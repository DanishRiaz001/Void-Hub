-- VOID HUB — Cloudflare D1 Database Schema
-- Run: wrangler d1 execute void-hub-db --file=schema.sql

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT NOT NULL,
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  country TEXT DEFAULT '',
  market TEXT DEFAULT '',
  website TEXT DEFAULT '',
  instagram TEXT DEFAULT '',
  type TEXT DEFAULT 'Retailer',
  source TEXT DEFAULT '',
  status TEXT DEFAULT 'New',
  priority TEXT DEFAULT 'Warm',
  notes TEXT DEFAULT '',
  added INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS emails_sent (
  id TEXT PRIMARY KEY,
  contact_id TEXT,
  to_email TEXT NOT NULL,
  to_name TEXT DEFAULT '',
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'sent',
  gmail_id TEXT DEFAULT '',
  sent_at INTEGER NOT NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tag TEXT DEFAULT '',
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  contact_id TEXT,
  message TEXT NOT NULL,
  icon TEXT DEFAULT '📝',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Default templates
INSERT OR IGNORE INTO templates VALUES
  ('t1','First Touch — Retailer','Cold Outreach','VOID SUPPLY CO. — Wholesale Introduction',
  'Hi {name},

I came across {company} and was really impressed by your curation — the aesthetic you carry is exactly the market we design for.

My name is [Your Name] from VOID SUPPLY CO., a streetwear manufacturing brand based in Pakistan (Sialkot/Karachi) producing for retailers across Europe, Scandinavia, and North America.

What we offer:
• MOQ from 50 units per style
• In-house sampling (7–10 day turnaround)
• Full-package manufacturing: cut, sew, wash, trim
• Competitive ex-works pricing for wholesale buyers

Would you be open to a quick call or I can send over our wholesale lookbook + pricing sheet?

Best regards,
[Your Name]
VOID SUPPLY CO.',
  34, 9, strftime('%s','now')*1000),
  ('t2','Follow-Up #1','Follow-Up','Re: VOID SUPPLY CO. — Quick Follow-Up',
  'Hi {name},

I sent a message last week about VOID SUPPLY CO.''s wholesale program — wanted to make sure it didn''t get lost in your inbox.

If you''re ever looking for a reliable manufacturing partner for streetwear, knitwear, or outerwear — I''d love to connect.

Happy to send a lookbook at any time, no obligation.

[Your Name]
VOID SUPPLY CO.',
  22, 5, strftime('%s','now')*1000),
  ('t3','Instagram Warm Lead','Warm Outreach','Loved your latest drop — VOID here',
  'Hey {name},

Just saw your recent post on Instagram — the aesthetic you''re building is exactly the world we operate in.

VOID SUPPLY CO. manufactures streetwear, outerwear, and knitwear for boutiques and retailers in Europe and North America.

If you''re ever thinking about expanding your offering or need a production partner — I''d love to chat.

[Your Name]',
  41, 14, strftime('%s','now')*1000),
  ('t4','Final Follow-Up','Follow-Up','Closing the loop — VOID SUPPLY CO.',
  'Hi {name},

This is my last message — I don''t want to be a nuisance. If {company} ever revisits wholesale manufacturing partnerships, I''d love to be on your radar.

The door is always open.

[Your Name]
VOID SUPPLY CO.',
  18, 7, strftime('%s','now')*1000),
  ('t5','Distribution Partnership','Distributor','Distribution partnership — VOID SUPPLY CO.',
  'Dear {name},

I''m reaching out because {company}''s reach across {market} is exactly the kind of distribution partnership we''re looking for.

VOID SUPPLY CO. produces seasonal streetwear collections for the European and Scandinavian market. We''re looking for regional distributors who can represent the brand.

Terms for distribution partners:
• Exclusive territory rights available
• Tiered margin structure (30–45% retail margin)
• Net-30 payment terms for established partners

Would you be open to reviewing our wholesale catalogue?

[Your Name]
VOID SUPPLY CO.',
  12, 4, strftime('%s','now')*1000);
