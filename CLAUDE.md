# VOID HUB — Claude Context

B2B outreach CRM for VOID SUPPLY CO. (Pakistani streetwear manufacturer). Tracks retailer/boutique contacts across Europe, Scandinavia, North America. Sends emails via Gmail API. Deployed on Cloudflare Pages + D1.

## Stack

- **Frontend**: Single HTML file (`public/index.html`) — vanilla JS, no framework, no build step
- **Backend**: Cloudflare Pages Functions (`functions/api/[[route]].js`) — catches all `/api/*` routes
- **Database**: Cloudflare D1 (SQLite) — bound as `env.DB`
- **Email**: Gmail REST API via OAuth2 refresh token (no SMTP — Workers don't support TCP)
- **Auth**: JWT (HMAC-SHA256) using Web Crypto API
- **Email lookup**: Hunter.io API

## Project Structure

```
void-hub/
├── public/
│   └── index.html          # Entire frontend (~1500 lines)
├── functions/
│   └── api/
│       └── [[route]].js    # Entire backend (~440 lines)
├── schema.sql               # D1 schema + 5 default templates
└── wrangler.toml            # Cloudflare config (fill in database_id)
```

## Database Tables

```sql
contacts       -- id, name, company, email, phone, country, market, website,
               --   instagram, type, source, status, priority, notes, added, updated
emails_sent    -- id, contact_id, to_email, to_name, subject, body, status,
               --   gmail_id, sent_at
templates      -- id, name, tag, subject, body, sent_count, reply_count, created_at
activity       -- id, contact_id, message, icon, created_at
settings       -- key, value
```

Status values: `New` → `Email Sent` → `Replied` → `Meeting Set` → `Closed` / `Bounced` / `Opt-Out`

Priority values: `Hot`, `Warm`, `Cold`

## API Routes

All routes require `Authorization: Bearer <jwt>` except `/api/auth/login` and `/api/auth/me`.

```
POST   /api/auth/login              { email, password } → { token }
GET    /api/auth/me

GET    /api/contacts                ?status=&market=&priority=&search=&page=&limit=
POST   /api/contacts                single object or array
PUT    /api/contacts/:id
DELETE /api/contacts/:id
GET    /api/contacts/export         returns CSV (must be before /:id handler in code)

POST   /api/email/send              { contact_id, to, to_name, subject, body, template_id }
POST   /api/email/bulk              { template_id, contact_ids?, filter? }
GET    /api/email/contact/:id       email history for a contact
PUT    /api/email/reply/:id         mark email as replied, updates contact status
GET    /api/email/sent              ?search=
GET    /api/email/gmail-status

GET    /api/templates
POST   /api/templates               { id?, name, tag, subject, body }
DELETE /api/templates/:id

GET    /api/activity                ?page=&limit=
GET    /api/stats
POST   /api/gmail-auth              { code, redirect_uri } → { refresh_token }

GET    /api/hunter/status
GET    /api/hunter/domain           ?domain=acme.com → emails[]
GET    /api/hunter/find             ?domain=acme.com&first_name=&last_name=
```

## Frontend Pages

Navigation via `nav(page)` function. Pages: `dashboard`, `contacts`, `import`, `compose`, `bulk`, `sent`, `templates`, `activity`, `settings`.

Key globals: `contacts[]`, `templates[]`, `TOKEN`, `selectedIds` (Set), `sortKey`, `sortDir`, `filterApplied`, `searchQ`.

Key patterns:
- `api(path, opts)` — authenticated fetch wrapper, auto-logout on 401
- `esc(s)` — XSS escape for all user data rendered into HTML
- `toast(msg, icon)` — bottom toast notification
- `showModal(html)` / `closeModal()` — modal system
- `openPanel(contactId)` — right-side contact detail panel

## Secrets (set via `wrangler secret put`)

| Secret | Required | Purpose |
|---|---|---|
| `ADMIN_EMAIL` | Yes | Login email |
| `ADMIN_PASSWORD` | Yes | Login password (plain text, hashed server-side) |
| `JWT_SECRET` | Yes | 32-char random string for JWT signing |
| `GMAIL_CLIENT_ID` | For email | Google OAuth client ID |
| `GMAIL_CLIENT_SECRET` | For email | Google OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | For email | Long-lived refresh token |
| `GMAIL_FROM_EMAIL` | For email | Your Gmail address |
| `HUNTER_API_KEY` | For email lookup | Hunter.io API key |

Default credentials (no secrets set): `admin@void.co` / `void2024`

## Deploy Commands

```bash
# First time
wrangler d1 create void-hub-db
# Copy database_id into wrangler.toml
wrangler d1 execute void-hub-db --file=schema.sql
wrangler secret put ADMIN_EMAIL
wrangler secret put ADMIN_PASSWORD
wrangler secret put JWT_SECRET
wrangler pages deploy public --project-name void-hub

# Subsequent deploys
wrangler pages deploy public --project-name void-hub

# Add Gmail
wrangler secret put GMAIL_CLIENT_ID
wrangler secret put GMAIL_CLIENT_SECRET
wrangler secret put GMAIL_REFRESH_TOKEN
wrangler secret put GMAIL_FROM_EMAIL

# Add Hunter.io
wrangler secret put HUNTER_API_KEY
```

## Merge Tags (templates + bulk email)

`{name}` → first name, `{company}` → company name, `{market}` → market

Applied in `applyMergeTags(text, contact)` on the backend and inline in compose/preview on the frontend.

## Key Design Decisions

- **No build step**: single HTML file keeps deployment trivial — `wrangler pages deploy public`
- **No framework**: vanilla JS with template literals for rendering; fast, no dependencies
- **Gmail REST not SMTP**: Cloudflare Workers have no TCP access; all email via `https://gmail.googleapis.com`
- **Bulk email is sequential**: Workers have a 30s CPU limit; sends one at a time in a loop, returns `{sent, failed}`
- **CSV export**: returns `text/csv` Response directly (not JSON), frontend uses Blob + `URL.createObjectURL`
- **XSS safety**: `esc()` wraps all user data inserted into innerHTML throughout the frontend
- **sessionStorage for bulk**: selected contact IDs passed from contacts page to bulk page via `sessionStorage`
- **Timestamps as integers**: all `added`, `updated`, `sent_at`, `created_at` stored as `Date.now()` (ms since epoch)

## Known Gaps / Future Work

- `templates.reply_count` never increments — `emails_sent` has no `template_id` column so replies can't be traced back to a template
- No pagination UI on contacts table (loads up to 500 at once — fine for current scale)
- Hunter.io free plan = 25 searches/month
