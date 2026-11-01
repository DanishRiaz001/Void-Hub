/**
 * VOID HUB — Cloudflare Pages Functions (catches all /api/* routes)
 */

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}
function now() { return Date.now(); }
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
function err(msg, status = 400) { return json({ error: msg }, status); }

// ── JWT ──────────────────────────────────────────────────────────────────────
async function signJWT(payload, secret) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${body}.${sigB64}`;
}

async function verifyJWT(token, secret) {
  try {
    const [header, body, sig] = token.split('.');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(`${header}.${body}`));
    if (!valid) return null;
    const payload = JSON.parse(atob(body));
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch { return null; }
}

async function hashPassword(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getToken(request) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/void_token=([^;]+)/);
  return m ? m[1] : null;
}

async function requireAuth(request, env) {
  const token = getToken(request);
  if (!token) return null;
  return await verifyJWT(token, env.JWT_SECRET || 'void-secret-key');
}

// ── GMAIL API ─────────────────────────────────────────────────────────────────
async function getGmailAccessToken(env) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID || '',
      client_secret: env.GMAIL_CLIENT_SECRET || '',
      refresh_token: env.GMAIL_REFRESH_TOKEN || '',
      grant_type: 'refresh_token',
    })
  });
  const data = await resp.json();
  return data.access_token || null;
}

async function sendGmail(env, to, toName, subject, body) {
  const accessToken = await getGmailAccessToken(env);
  if (!accessToken) throw new Error('Gmail not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN in Cloudflare secrets.');
  const fromEmail = env.GMAIL_FROM_EMAIL || 'me';
  const emailLines = [
    `From: ${fromEmail}`,
    `To: ${toName ? `"${toName}" <${to}>` : to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset=utf-8`,
    `MIME-Version: 1.0`,
    ``,
    body
  ];
  const raw = btoa(emailLines.join('\r\n')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw })
  });
  const result = await resp.json();
  if (!resp.ok) throw new Error(result.error?.message || 'Gmail send failed');
  return result.id;
}

function applyMergeTags(text, contact) {
  const first = (contact.name || '').split(' ')[0];
  return text
    .replace(/{name}/g, first)
    .replace(/{company}/g, contact.company || '')
    .replace(/{market}/g, contact.market || '');
}

// ── ROUTE HANDLER ─────────────────────────────────────────────────────────────
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    }});
  }

  // ── AUTH ──────────────────────────────────────────────────────────────────
  if (path[0] === 'auth') {
    if (path[1] === 'login' && method === 'POST') {
      const { email, password } = await request.json();
      const adminEmail = env.ADMIN_EMAIL || 'admin@void.co';
      const adminPw = env.ADMIN_PASSWORD || await hashPassword('void2024');
      const hashedInput = await hashPassword(password || '');
      if (email !== adminEmail || hashedInput !== adminPw) return err('Invalid credentials', 401);
      const token = await signJWT({ email, role: 'admin', exp: Math.floor(Date.now() / 1000) + 86400 * 30 }, env.JWT_SECRET || 'void-secret-key');
      return json({ token, email });
    }
    if (path[1] === 'me' && method === 'GET') {
      const token = getToken(request);
      if (!token) return err('Unauthorized', 401);
      const user = await verifyJWT(token, env.JWT_SECRET || 'void-secret-key');
      if (!user) return err('Unauthorized', 401);
      return json({ email: user.email, role: user.role });
    }
    return err('Not found', 404);
  }

  const user = await requireAuth(request, env);
  if (!user) return err('Unauthorized', 401);

  // ── CONTACTS ──────────────────────────────────────────────────────────────
  if (path[0] === 'contacts') {

    // Export CSV — must come before generic path[1] handler
    if (method === 'GET' && path[1] === 'export') {
      const { results } = await env.DB.prepare('SELECT * FROM contacts ORDER BY added DESC').all();
      const cols = ['id','name','company','email','phone','country','market','website','instagram','type','source','status','priority','notes','added','updated'];
      const escape = v => { const s = String(v ?? ''); return (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s; };
      const rows = results.map(r => cols.map(c => escape(r[c])).join(','));
      const csv = [cols.join(','), ...rows].join('\r\n');
      return new Response(csv, { headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="void-hub-contacts.csv"`,
        'Access-Control-Allow-Origin': '*'
      }});
    }

    if (method === 'GET' && !path[1]) {
      const status = url.searchParams.get('status') || '';
      const market = url.searchParams.get('market') || '';
      const priority = url.searchParams.get('priority') || '';
      const search = url.searchParams.get('search') || '';
      const page = parseInt(url.searchParams.get('page') || '1');
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '200'), 500);
      const offset = (page - 1) * limit;
      let q = 'SELECT * FROM contacts WHERE 1=1';
      const args = [];
      if (status) { q += ' AND status=?'; args.push(status); }
      if (market) { q += ' AND market=?'; args.push(market); }
      if (priority) { q += ' AND priority=?'; args.push(priority); }
      if (search) { q += ' AND (name LIKE ? OR company LIKE ? OR email LIKE ? OR country LIKE ?)'; args.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
      const countQ = q.replace('SELECT *', 'SELECT COUNT(*) as n');
      const [{ results }, countRow] = await Promise.all([
        env.DB.prepare(q + ' ORDER BY added DESC LIMIT ? OFFSET ?').bind(...args, limit, offset).all(),
        env.DB.prepare(countQ).bind(...args).first()
      ]);
      return json({ results, total: countRow.n, page, limit });
    }

    if (method === 'GET' && path[1]) {
      const row = await env.DB.prepare('SELECT * FROM contacts WHERE id=?').bind(path[1]).first();
      return row ? json(row) : err('Not found', 404);
    }

    if (method === 'POST') {
      const body = await request.json();
      const contacts = Array.isArray(body) ? body : [body];
      const inserted = [];
      for (const c of contacts) {
        if (!c.name || !c.company) continue;
        const id = uid();
        const t = now();
        await env.DB.prepare(
          'INSERT INTO contacts (id,name,company,email,phone,country,market,website,instagram,type,source,status,priority,notes,added,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
        ).bind(id, c.name, c.company, c.email||'', c.phone||'', c.country||'', c.market||'', c.website||'', c.instagram||'', c.type||'Retailer', c.source||'', c.status||'New', c.priority||'Warm', c.notes||'', t, t).run();
        await env.DB.prepare('INSERT INTO activity (id,contact_id,message,icon,created_at) VALUES (?,?,?,?,?)').bind(uid(), id, `Added: ${c.name} @ ${c.company}`, '👤', t).run();
        inserted.push(id);
      }
      return json({ inserted: inserted.length, ids: inserted });
    }

    if (method === 'PUT' && path[1]) {
      const c = await request.json();
      await env.DB.prepare(
        'UPDATE contacts SET name=?,company=?,email=?,phone=?,country=?,market=?,website=?,instagram=?,type=?,source=?,status=?,priority=?,notes=?,updated=? WHERE id=?'
      ).bind(c.name, c.company, c.email||'', c.phone||'', c.country||'', c.market||'', c.website||'', c.instagram||'', c.type||'Retailer', c.source||'', c.status||'New', c.priority||'Warm', c.notes||'', now(), path[1]).run();
      await env.DB.prepare('INSERT INTO activity (id,contact_id,message,icon,created_at) VALUES (?,?,?,?,?)').bind(uid(), path[1], `Updated: ${c.name}`, '✏', now()).run();
      return json({ ok: true });
    }

    if (method === 'DELETE' && path[1]) {
      await env.DB.prepare('DELETE FROM contacts WHERE id=?').bind(path[1]).run();
      return json({ ok: true });
    }
  }

  // ── EMAIL ─────────────────────────────────────────────────────────────────
  if (path[0] === 'email') {

    // Send single email
    if (path[1] === 'send' && method === 'POST') {
      const { contact_id, to, to_name, subject, body, template_id } = await request.json();
      if (!to || !subject || !body) return err('Missing fields');
      try {
        const gmailId = await sendGmail(env, to, to_name, subject, body);
        const id = uid();
        await env.DB.prepare('INSERT INTO emails_sent (id,contact_id,to_email,to_name,subject,body,status,gmail_id,sent_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, contact_id||null, to, to_name||'', subject, body, 'sent', gmailId||'', now()).run();
        if (contact_id) {
          await env.DB.prepare('UPDATE contacts SET status=?,updated=? WHERE id=? AND status=?').bind('Email Sent', now(), contact_id, 'New').run();
          await env.DB.prepare('INSERT INTO activity (id,contact_id,message,icon,created_at) VALUES (?,?,?,?,?)').bind(uid(), contact_id, `Email sent: "${subject}"`, '✉', now()).run();
        }
        if (template_id) {
          await env.DB.prepare('UPDATE templates SET sent_count=sent_count+1 WHERE id=?').bind(template_id).run();
        }
        return json({ ok: true, id, gmail_id: gmailId });
      } catch (e) {
        return err(e.message);
      }
    }

    // Bulk email — send template to many contacts
    if (path[1] === 'bulk' && method === 'POST') {
      const { template_id, contact_ids, filter } = await request.json();
      if (!template_id) return err('Missing template_id');

      const tpl = await env.DB.prepare('SELECT * FROM templates WHERE id=?').bind(template_id).first();
      if (!tpl) return err('Template not found');

      let ctList = [];
      if (contact_ids?.length) {
        for (const cid of contact_ids) {
          const c = await env.DB.prepare("SELECT * FROM contacts WHERE id=? AND email != ''").bind(cid).first();
          if (c) ctList.push(c);
        }
      } else {
        let q = "SELECT * FROM contacts WHERE email != '' AND email IS NOT NULL";
        const args = [];
        if (filter?.status) { q += ' AND status=?'; args.push(filter.status); }
        if (filter?.market) { q += ' AND market=?'; args.push(filter.market); }
        const { results } = await env.DB.prepare(q + ' ORDER BY added DESC LIMIT 200').bind(...args).all();
        ctList = results;
      }

      if (!ctList.length) return err('No contacts with email addresses found for this selection');

      let accessToken;
      try { accessToken = await getGmailAccessToken(env); }
      catch(e) { return err('Gmail not configured'); }
      if (!accessToken) return err('Gmail not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN in Cloudflare secrets.');

      const sent = [], failed = [];
      const batchTime = now();

      for (const c of ctList) {
        const subject = applyMergeTags(tpl.subject, c);
        const body = applyMergeTags(tpl.body, c);
        try {
          const gmailId = await sendGmail(env, c.email, c.name, subject, body);
          const id = uid();
          await env.DB.prepare('INSERT INTO emails_sent (id,contact_id,to_email,to_name,subject,body,status,gmail_id,sent_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, c.id, c.email, c.name, subject, body, 'sent', gmailId||'', batchTime).run();
          await env.DB.prepare('INSERT INTO activity (id,contact_id,message,icon,created_at) VALUES (?,?,?,?,?)').bind(uid(), c.id, `Bulk email: "${tpl.name}"`, '📨', batchTime).run();
          await env.DB.prepare("UPDATE contacts SET status='Email Sent',updated=? WHERE id=? AND status='New'").bind(batchTime, c.id).run();
          sent.push(c.id);
        } catch(e) {
          failed.push({ id: c.id, name: c.name, error: e.message });
        }
      }

      if (sent.length) {
        await env.DB.prepare('UPDATE templates SET sent_count=sent_count+? WHERE id=?').bind(sent.length, template_id).run();
      }

      return json({ ok: true, sent: sent.length, failed: failed.length, failures: failed });
    }

    // Per-contact email history
    if (path[1] === 'contact' && path[2] && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM emails_sent WHERE contact_id=? ORDER BY sent_at DESC LIMIT 30').bind(path[2]).all();
      return json(results);
    }

    // Mark email as replied
    if (path[1] === 'reply' && path[2] && method === 'PUT') {
      const email = await env.DB.prepare('SELECT * FROM emails_sent WHERE id=?').bind(path[2]).first();
      if (!email) return err('Not found', 404);
      await env.DB.prepare("UPDATE emails_sent SET status='replied' WHERE id=?").bind(path[2]).run();
      if (email.contact_id) {
        await env.DB.prepare("UPDATE contacts SET status='Replied',updated=? WHERE id=? AND status IN ('New','Email Sent')").bind(now(), email.contact_id).run();
        await env.DB.prepare('INSERT INTO activity (id,contact_id,message,icon,created_at) VALUES (?,?,?,?,?)').bind(uid(), email.contact_id, `Reply marked on: "${email.subject}"`, '↩', now()).run();
      }
      return json({ ok: true });
    }

    if (path[1] === 'sent' && method === 'GET') {
      const search = url.searchParams.get('search') || '';
      let q = 'SELECT e.*, c.name as contact_name, c.company FROM emails_sent e LEFT JOIN contacts c ON e.contact_id=c.id WHERE 1=1';
      const args = [];
      if (search) { q += ' AND (e.to_name LIKE ? OR e.to_email LIKE ? OR e.subject LIKE ?)'; args.push(`%${search}%`, `%${search}%`, `%${search}%`); }
      q += ' ORDER BY e.sent_at DESC LIMIT 300';
      const { results } = await env.DB.prepare(q).bind(...args).all();
      return json(results);
    }

    if (path[1] === 'gmail-status' && method === 'GET') {
      const hasGmail = !!(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN);
      return json({ connected: hasGmail, email: env.GMAIL_FROM_EMAIL || null });
    }
  }

  // ── TEMPLATES ─────────────────────────────────────────────────────────────
  if (path[0] === 'templates') {
    if (method === 'GET' && !path[1]) {
      const { results } = await env.DB.prepare('SELECT * FROM templates ORDER BY created_at DESC').all();
      return json(results);
    }
    if (method === 'GET' && path[1]) {
      const row = await env.DB.prepare('SELECT * FROM templates WHERE id=?').bind(path[1]).first();
      return row ? json(row) : err('Not found', 404);
    }
    if (method === 'POST') {
      const t = await request.json();
      const id = t.id || uid();
      await env.DB.prepare('INSERT OR REPLACE INTO templates (id,name,tag,subject,body,sent_count,reply_count,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(id, t.name, t.tag||'', t.subject, t.body, t.sent_count||0, t.reply_count||0, now()).run();
      return json({ ok: true, id });
    }
    if (method === 'DELETE' && path[1]) {
      await env.DB.prepare('DELETE FROM templates WHERE id=?').bind(path[1]).run();
      return json({ ok: true });
    }
  }

  // ── ACTIVITY ──────────────────────────────────────────────────────────────
  if (path[0] === 'activity' && method === 'GET') {
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
    const offset = (page - 1) * limit;
    const { results } = await env.DB.prepare('SELECT a.*, c.name as contact_name, c.company FROM activity a LEFT JOIN contacts c ON a.contact_id=c.id ORDER BY a.created_at DESC LIMIT ? OFFSET ?').bind(limit, offset).all();
    const { n } = await env.DB.prepare('SELECT COUNT(*) as n FROM activity').first();
    return json({ results, total: n, page, limit });
  }

  // ── STATS ─────────────────────────────────────────────────────────────────
  if (path[0] === 'stats' && method === 'GET') {
    const [total, byStatus, byMarket, byPriority, recentEmails, recentContacts] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as n FROM contacts').first(),
      env.DB.prepare("SELECT status, COUNT(*) as n FROM contacts GROUP BY status").all(),
      env.DB.prepare("SELECT market, COUNT(*) as n FROM contacts WHERE market != '' GROUP BY market ORDER BY n DESC LIMIT 8").all(),
      env.DB.prepare("SELECT priority, COUNT(*) as n FROM contacts GROUP BY priority").all(),
      env.DB.prepare('SELECT COUNT(*) as n FROM emails_sent WHERE sent_at > ?').bind(now() - 7*86400000).first(),
      env.DB.prepare('SELECT COUNT(*) as n FROM contacts WHERE added > ?').bind(now() - 7*86400000).first(),
    ]);
    return json({
      total: total.n,
      byStatus: byStatus.results,
      byMarket: byMarket.results,
      byPriority: byPriority.results,
      emailsThisWeek: recentEmails.n,
      newThisWeek: recentContacts.n
    });
  }

  // ── HUNTER.IO ─────────────────────────────────────────────────────────────
  if (path[0] === 'hunter') {
    if (path[1] === 'status' && method === 'GET') {
      return json({ connected: !!(env.HUNTER_API_KEY) });
    }

    const apiKey = env.HUNTER_API_KEY;
    if (!apiKey) return err('Hunter.io not configured. Run: wrangler secret put HUNTER_API_KEY');

    // Domain search — returns all emails found for a domain
    if (path[1] === 'domain' && method === 'GET') {
      const domain = url.searchParams.get('domain');
      if (!domain) return err('Missing domain');
      const resp = await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=10&api_key=${apiKey}`);
      const data = await resp.json();
      if (data.errors?.length) return err(data.errors[0]?.details || 'Hunter.io error');
      const emails = (data.data?.emails || []).map(e => ({
        email: e.value,
        confidence: e.confidence,
        first_name: e.first_name || '',
        last_name: e.last_name || '',
        position: e.position || '',
        type: e.type || ''
      }));
      return json({ domain: data.data?.domain, organization: data.data?.organization, emails, pattern: data.data?.pattern });
    }

    // Email finder — targeted lookup by name + domain
    if (path[1] === 'find' && method === 'GET') {
      const domain = url.searchParams.get('domain');
      if (!domain) return err('Missing domain');
      const params = new URLSearchParams({ domain, api_key: apiKey });
      const first = url.searchParams.get('first_name');
      const last = url.searchParams.get('last_name');
      if (first) params.set('first_name', first);
      if (last) params.set('last_name', last);
      const resp = await fetch(`https://api.hunter.io/v2/email-finder?${params}`);
      const data = await resp.json();
      if (data.errors?.length) return err(data.errors[0]?.details || 'Hunter.io error');
      return json({ email: data.data?.email, confidence: data.data?.score, first_name: data.data?.first_name, last_name: data.data?.last_name });
    }
  }

  // ── GMAIL OAUTH SETUP ─────────────────────────────────────────────────────
  if (path[0] === 'gmail-auth' && method === 'POST') {
    const { code, redirect_uri } = await request.json();
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET, redirect_uri, grant_type: 'authorization_code' })
    });
    const data = await resp.json();
    if (!data.refresh_token) return err('No refresh token. Make sure access_type=offline in your OAuth URL.');
    return json({ refresh_token: data.refresh_token, instructions: 'Run: wrangler secret put GMAIL_REFRESH_TOKEN and paste the value above' });
  }

  return err('Not found', 404);
}
