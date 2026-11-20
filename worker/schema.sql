-- Index of AgentHongbao events, filled by the Worker's cron (worker/index.js).
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS packets (
  id INTEGER PRIMARY KEY,
  creator TEXT NOT NULL,
  kind INTEGER NOT NULL,          -- 0 direct, 1 code, 2 public
  token TEXT NOT NULL,
  total TEXT NOT NULL,            -- base units, as decimal string
  shares INTEGER NOT NULL,
  expiry INTEGER NOT NULL,        -- unix seconds
  lucky INTEGER NOT NULL,
  heat_step INTEGER NOT NULL DEFAULT 0,
  memo TEXT NOT NULL DEFAULT '',
  refunded TEXT,                  -- base units refunded to the creator, if any
  block INTEGER NOT NULL,
  slug TEXT                       -- link code (lib/link.mjs), from the creating transaction
);

CREATE UNIQUE INDEX IF NOT EXISTS packets_slug ON packets (slug);

-- One row per address per packet: a grabbed slot (code/public) or a direct claim.
CREATE TABLE IF NOT EXISTS claims (
  packet_id INTEGER NOT NULL,
  who TEXT NOT NULL,
  slot INTEGER,                   -- null for direct claims
  handle TEXT,                    -- name without ".ai", looked up when indexed
  amount TEXT,                    -- null until the slot is opened
  floored INTEGER NOT NULL DEFAULT 0,
  block INTEGER NOT NULL,
  PRIMARY KEY (packet_id, who)
);

CREATE INDEX IF NOT EXISTS claims_who ON claims (who);

-- Senders' public profiles, saved only with a signature from the sender's wallet.
CREATE TABLE IF NOT EXISTS profiles (
  address TEXT PRIMARY KEY,       -- lowercase
  x TEXT NOT NULL DEFAULT '',
  telegram TEXT NOT NULL DEFAULT '',
  intro TEXT NOT NULL DEFAULT '',
  issued INTEGER NOT NULL,        -- unix seconds signed by the sender
  signature TEXT NOT NULL
);

-- Token metadata, fetched by the Worker when a packet in that token is first indexed. Symbol and
-- name are written by whoever deployed the token: cleaned (lib/token.mjs) and always shown with the
-- address when the token is not listed.
CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY,       -- lowercase
  symbol TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  decimals INTEGER,               -- null when the token does not report a sensible value
  listed INTEGER NOT NULL DEFAULT 0,
  checked INTEGER NOT NULL DEFAULT 0  -- unix seconds of the last lookup
);

-- The profile each packet was sent with. A packet without a row shows its sender's latest profile
-- (packets from before per-packet profiles). source: 'signed' (the sender signed it for this packet)
-- or 'snapshot' (the sender's profile at the time, copied when the packet was sent).
CREATE TABLE IF NOT EXISTS packet_profiles (
  packet_id INTEGER PRIMARY KEY,
  address TEXT NOT NULL,          -- lowercase
  x TEXT NOT NULL DEFAULT '',
  telegram TEXT NOT NULL DEFAULT '',
  intro TEXT NOT NULL DEFAULT '',
  issued INTEGER NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL
);
