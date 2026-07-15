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

-- thread_classifications: Workers AI-klassificering av olösta CodeRabbit-
-- review-trådar (pull_request_review_thread.unresolved). Loggar varje
-- klassificeringsbeslut för uppföljning/prompttuning, oavsett vilken åtgärd
-- som valdes.
CREATE TABLE IF NOT EXISTS thread_classifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  action TEXT NOT NULL,          -- 'skip' | 'autofix' | 'escalate'
  reasoning TEXT,                -- AI:ns motivering, trunkerad
  classified_at INTEGER NOT NULL -- unix epoch seconds
);
CREATE INDEX IF NOT EXISTS idx_thread_classifications_repo_pr ON thread_classifications(repo, pr_number);

-- escalated_threads: debounce för @claude-eskaleringskommentarer — max en
-- eskalering per repo+PR var 30:e minut, oavsett hur många trådar som blir
-- olösta under den tiden.
CREATE TABLE IF NOT EXISTS escalated_threads (
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  escalated_at INTEGER NOT NULL,
  escalation_count INTEGER NOT NULL DEFAULT 0, -- stoppar upprepade @claude-kommentarer om fixen inte biter
  UNIQUE(repo, pr_number)
);

-- heartbeats: senast kända status per källa (VPS, tjänst, leverantör)
CREATE TABLE IF NOT EXISTS heartbeats (
  source_id TEXT PRIMARY KEY,    -- t.ex. 'mp100', 'bastion-winvps', 'hostup-account'
  status TEXT NOT NULL,          -- 'up' | 'down' | 'maintenance' | 'unknown'
  last_seen INTEGER NOT NULL,    -- unix epoch seconds
  details TEXT                   -- fri JSON: cpu/ram/disk/etc, källberoende
);

-- healthcheck_state: senaste status per healthcheck-kontroll (politiker.denied.se)
-- används för transition-baserad alerting (Slacka bara vid OK→FAIL / FAIL→OK).
-- since/last_alert är unix epoch-sekunder (INTEGER) — koden gör datumaritmetik
-- på dem (t.ex. "fortfarande FAIL sedan Nh"), en TEXT-kolumn skulle bryta det.
CREATE TABLE IF NOT EXISTS healthcheck_state (
  check_id TEXT PRIMARY KEY,     -- t.ex. 'root_200', 'd1_politicians'
  ok INTEGER NOT NULL,           -- 1 = OK, 0 = FAIL
  since INTEGER NOT NULL,        -- unix epoch: när nuvarande status började
  last_alert INTEGER,            -- unix epoch: senaste Slack-larm för denna kontroll (NULL om OK)
  detail TEXT                    -- senaste detaljbeskrivning
);
