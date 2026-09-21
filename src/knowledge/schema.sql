-- Shepard knowledge store.
--
-- Two rules shape this schema.
--
-- Every claim carries provenance: a pointer to the tool output that produced it.
-- A row whose provenance_id is null cannot support a verdict and cannot enter a
-- baseline. This is enforced in the store, not by convention.
--
-- Every claim carries the commit at which it was derived. When HEAD moves past a
-- row covering changed code the row goes stale and is re-derived rather than
-- trusted. Shepard distrusting its own old conclusions is deliberate.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS application (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  repo_url      TEXT,
  root_path     TEXT NOT NULL,
  head_commit   TEXT,
  created_at    TEXT NOT NULL,
  accepted_at   TEXT,
  accept_state  TEXT NOT NULL DEFAULT 'unqualified'
                CHECK (accept_state IN ('unqualified','denied','accepted','accepted_with_known_issues'))
);

-- Provenance. The tool invocation behind a claim. Nothing else in this schema is
-- allowed to assert anything without one.
CREATE TABLE IF NOT EXISTS provenance (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,          -- parse | crawl | browser | shell | query | model
  tool        TEXT NOT NULL,
  detail      TEXT,                   -- command, selector, file, query
  evidence_id TEXT REFERENCES evidence(id),
  at_commit   TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_prov_app ON provenance(app_id);

-- Content-addressed evidence. Blobs live on disk; this indexes them.
CREATE TABLE IF NOT EXISTS evidence (
  id         TEXT PRIMARY KEY,        -- sha256 of content
  app_id     TEXT NOT NULL,
  kind       TEXT NOT NULL,           -- screenshot | har | log | stdout | trace | snippet | json
  path       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  meta       TEXT,
  created_at TEXT NOT NULL
);

-- What the application is, expressed as rows. The prose report the user reads is
-- rendered from these; a sentence with no row behind it does not get written.
CREATE TABLE IF NOT EXISTS system (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  summary       TEXT,
  importance    TEXT NOT NULL DEFAULT 'supporting' CHECK (importance IN ('core','supporting','peripheral')),
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  at_commit     TEXT,
  stale         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS actor (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'role',  -- role | anonymous | service
  credentials   TEXT,                          -- how Shepard obtains this identity, never a secret
  obtained      INTEGER NOT NULL DEFAULT 0,
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  at_commit     TEXT,
  stale         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS journey (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  system_id     TEXT REFERENCES system(id),
  actor_id      TEXT REFERENCES actor(id),
  name          TEXT NOT NULL,
  importance    TEXT NOT NULL DEFAULT 'supporting' CHECK (importance IN ('core','supporting','peripheral')),
  steps         TEXT,                          -- json
  depends_on    TEXT,                          -- json array of journey ids, for state construction order
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  at_commit     TEXT,
  stale         INTEGER NOT NULL DEFAULT 0
);

-- The verification surface. Everything enumerable that can be exercised.
-- These rows are produced by parsers and crawlers, never by a model, because
-- absence is what a model misses and absence is the shape of most defects.
CREATE TABLE IF NOT EXISTS surface (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  system_id     TEXT REFERENCES system(id),
  kind          TEXT NOT NULL,   -- route | control | endpoint | table | policy | integration | job | form
  identifier    TEXT NOT NULL,   -- stable semantic identity, not a line number
  label         TEXT,
  location      TEXT,            -- file:line where known
  safety        TEXT NOT NULL DEFAULT 'unknown'
                CHECK (safety IN ('safe','sandbox_only','unsafe','unknown')),
  importance    TEXT NOT NULL DEFAULT 'supporting' CHECK (importance IN ('core','supporting','peripheral')),
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  at_commit     TEXT,
  stale         INTEGER NOT NULL DEFAULT 0,
  -- Structural facts about the surface, carried forward between audits. What a
  -- surface used to be is evidence: a route that had an authorization check
  -- yesterday and has none today is a regression, and nothing in today's code
  -- can tell you that, because the defect deleted its own expectation.
  attributes    TEXT,
  UNIQUE (app_id, kind, identifier)
);
CREATE INDEX IF NOT EXISTS ix_surface_app ON surface(app_id, kind);

-- An expectation about a surface, tagged with where it came from. The source
-- matters: code_derived expectations can never on their own justify a healthy
-- verdict, because a defect in the code would be inherited by the expectation.
CREATE TABLE IF NOT EXISTS expectation (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  surface_id    TEXT NOT NULL REFERENCES surface(id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK (source IN
                  ('affordance','cross_layer','history','invariant','code_derived','user_stated')),
  statement     TEXT NOT NULL,
  predicate     TEXT NOT NULL,   -- json: machine-checkable form
  provenance_id TEXT NOT NULL REFERENCES provenance(id),
  at_commit     TEXT,
  stale         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_expectation_surface ON expectation(surface_id);

CREATE TABLE IF NOT EXISTS verification_case (
  id             TEXT PRIMARY KEY,
  app_id         TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  surface_id     TEXT REFERENCES surface(id) ON DELETE CASCADE,
  actor_id       TEXT REFERENCES actor(id),
  journey_id     TEXT REFERENCES journey(id),
  title          TEXT NOT NULL,
  polarity       TEXT NOT NULL DEFAULT 'positive' CHECK (polarity IN ('positive','negative')),
  spec           TEXT NOT NULL,   -- json: deterministic, replayable steps
  needs_level    INTEGER NOT NULL DEFAULT 2,   -- minimum capability ladder level
  stability      REAL NOT NULL DEFAULT 0,      -- proven across repeated runs before entering a baseline
  state          TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','unstable','retired')),
  provenance_id  TEXT NOT NULL REFERENCES provenance(id),
  at_commit      TEXT,
  stale          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_case_app ON verification_case(app_id, state);

CREATE TABLE IF NOT EXISTS audit_cycle (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,   -- onboarding | scheduled | requalify | targeted
  at_commit   TEXT,
  level       INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  selection   TEXT,
  summary     TEXT
);

CREATE TABLE IF NOT EXISTS run (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  cycle_id   TEXT REFERENCES audit_cycle(id),
  case_id    TEXT REFERENCES verification_case(id),
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  -- inconclusive is a real outcome with a reason. It never rounds up to pass.
  outcome    TEXT NOT NULL CHECK (outcome IN ('pass','fail','inconclusive')),
  reason     TEXT,
  attempt    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_run_case ON run(case_id, started_at);

CREATE TABLE IF NOT EXISTS observation (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT,
  evidence_id TEXT REFERENCES evidence(id)
);
CREATE INDEX IF NOT EXISTS ix_obs_run ON observation(run_id);

-- Findings have identity, so New/Known/Resolved/Recurrence/Intentional is
-- computed rather than guessed. The fingerprint keys on semantic location and
-- failure class, never on line numbers or exact message text.
CREATE TABLE IF NOT EXISTS finding (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  fingerprint   TEXT NOT NULL,
  surface_id    TEXT REFERENCES surface(id),
  class         TEXT NOT NULL,   -- inert_control | broken_link | http_error | console_error | auth_leak | ...
  title         TEXT NOT NULL,
  expected      TEXT,
  observed      TEXT,
  impact        TEXT,
  cause         TEXT,
  severity      TEXT NOT NULL DEFAULT 'medium'
                CHECK (severity IN ('critical','high','medium','low','info')),
  status        TEXT NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','known','resolved','recurrence','intentional','intermittent')),
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  confirmations INTEGER NOT NULL DEFAULT 0,
  UNIQUE (app_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS ix_finding_app ON finding(app_id, status, severity);

CREATE TABLE IF NOT EXISTS finding_event (
  id         TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL REFERENCES finding(id) ON DELETE CASCADE,
  run_id     TEXT REFERENCES run(id),
  kind       TEXT NOT NULL,   -- observed | confirmed | resolved | recurred | marked_intentional | quarantined
  at         TEXT NOT NULL,
  note       TEXT
);

-- What Shepard accepted, so re-qualification is a diff rather than a fresh opinion.
CREATE TABLE IF NOT EXISTS baseline (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  at_commit  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state      TEXT NOT NULL,   -- accepted | accepted_with_known_issues | denied
  manifest   TEXT NOT NULL,   -- json: case set, expected observations, coverage, known-unverified
  reason     TEXT
);

-- Intentional behaviour. Scoped and falsifiable, never a permanent mute: an
-- exception reopens for re-confirmation when the code around it changes.
CREATE TABLE IF NOT EXISTS exception (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  reason      TEXT NOT NULL,
  condition   TEXT,            -- observable condition under which it holds
  bound_commit TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_reconfirmation','revoked')),
  created_at  TEXT NOT NULL
);

-- The state of Shepard's own inquiry, so an hour-long onboarding is resumable
-- rather than restartable when the working context is replaced.
CREATE TABLE IF NOT EXISTS investigation (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  cycle_id   TEXT REFERENCES audit_cycle(id),
  question   TEXT NOT NULL,
  hypotheses TEXT,            -- json: [{statement, predicted_observation, status}]
  ruled_out  TEXT,            -- json
  next_probe TEXT,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','abandoned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- When the user corrects Shepard the durable artifact is the methodology defect,
-- not the fact. Facts make Shepard better at one repository; these make it better
-- at every repository.
CREATE TABLE IF NOT EXISTS blind_spot (
  id         TEXT PRIMARY KEY,
  app_id     TEXT REFERENCES application(id) ON DELETE SET NULL,
  class      TEXT NOT NULL,
  missed     TEXT NOT NULL,
  why        TEXT NOT NULL,
  heuristic  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- How far Shepard got towards being able to run the application at all.
CREATE TABLE IF NOT EXISTS acquisition (
  id         TEXT PRIMARY KEY,
  app_id     TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  at_commit  TEXT,
  level      INTEGER NOT NULL,     -- 0..5, the capability ladder
  recipe     TEXT,                 -- json: how to build, boot, seed
  unmet      TEXT,                 -- json: precisely what is missing for the next level
  base_url   TEXT,
  created_at TEXT NOT NULL
);
