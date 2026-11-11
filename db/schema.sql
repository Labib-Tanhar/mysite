CREATE TABLE IF NOT EXISTS mail_steps (
  id TEXT PRIMARY KEY,
  seq_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT NOT NULL DEFAULT '',
  step_idx INTEGER NOT NULL,
  mailbox TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  lead_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  send_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  sent_at INTEGER,
  replied_at INTEGER,
  message_id TEXT,
  conversation_id TEXT,
  error TEXT,
  UNIQUE (seq_id, step_idx)
);

CREATE INDEX IF NOT EXISTS mail_steps_due_idx ON mail_steps (status, send_at);
CREATE INDEX IF NOT EXISTS mail_steps_campaign_idx ON mail_steps (campaign_id);
CREATE INDEX IF NOT EXISTS mail_steps_mailbox_idx ON mail_steps (mailbox, sent_at);

CREATE TABLE IF NOT EXISTS mail_replies (
  id TEXT PRIMARY KEY,
  seq_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL DEFAULT '',
  mailbox TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  step_idx INTEGER,
  label TEXT NOT NULL DEFAULT '',
  seen INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS mail_replies_received_idx ON mail_replies (received_at);
CREATE INDEX IF NOT EXISTS mail_replies_unseen_idx ON mail_replies (kind, seen);

CREATE TABLE IF NOT EXISTS mail_suppress (
  email TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_state (
  mailbox TEXT PRIMARY KEY,
  last_check INTEGER NOT NULL
);
