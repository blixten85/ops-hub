-- ops-hub D1-schema
-- events: rått händelseflöde (GitHub-webhooks, framtida källor)
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,          -- 'github' | 'hostup' | 'manual' | ...
  event_type TEXT NOT NULL,      -- t.ex. 'pull_request.opened', 'check_run.completed'
  repo TEXT,                     -- 'blixten85/bastion' eller NULL om ej repo-bundet
  triggers_coderabbit INTEGER NOT NULL DEFAULT 0, -- 1 om händelsen sannolikt startar/kan starta en CodeRabbit-granskning
  payload TEXT NOT NULL,         -- rå JSON, trunkerad om stor
  received_at INTEGER NOT NULL   -- unix epoch seconds
);
CREATE INDEX IF NOT EXISTS idx_events_received_at ON events(received_at);
CREATE INDEX IF NOT EXISTS idx_events_coderabbit ON events(triggers_coderabbit, received_at);

-- healthcheck_state: senaste status per healthcheck-kontroll (politiker.denied.se)
-- används för transition-baserad alerting (Slacka bara vid OK→FAIL / FAIL→OK)
CREATE TABLE IF NOT EXISTS healthcheck_state (
  check_id TEXT PRIMARY KEY,     -- t.ex. 'root_200', 'd1_politicians'
  ok INTEGER NOT NULL,           -- 1 = OK, 0 = FAIL
  since INTEGER NOT NULL,        -- unix epoch: när nuvarande status började
  last_alert INTEGER,            -- unix epoch: senaste Slack-larm för denna kontroll (NULL om OK)
  detail TEXT                    -- senaste detaljbeskrivning
);

-- heartbeats: senast kända status per källa (VPS, tjänst, leverantör)
CREATE TABLE IF NOT EXISTS heartbeats (
  source_id TEXT PRIMARY KEY,    -- t.ex. 'mp100', 'bastion-winvps', 'hostup-account'
  status TEXT NOT NULL,          -- 'up' | 'down' | 'maintenance' | 'unknown'
  last_seen INTEGER NOT NULL,    -- unix epoch seconds
  details TEXT                   -- fri JSON: cpu/ram/disk/etc, källberoende
);
