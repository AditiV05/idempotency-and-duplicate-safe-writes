CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE incidents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  service_id  UUID NOT NULL,
  title       TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('P1','P2','P3','P4')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The primary key is the atomic owner of one logical action.
CREATE TABLE idempotency_keys (
  tenant_id       UUID NOT NULL,
  operation       TEXT NOT NULL,
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('processing','completed','failed')),
  response_status INTEGER,
  response_body   JSON, -- JSON, not JSONB, keeps the exact text, so a replay matches the first response
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, operation, key),
  -- A completed key must always have a response to replay.
  CHECK (state <> 'completed' OR (response_status IS NOT NULL AND response_body IS NOT NULL))
);

-- One durable job per incident. A worker sends the page after commit, and uses id
-- as a stable identity so the provider call is safe to repeat.
CREATE TABLE paging_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  incident_id UUID NOT NULL UNIQUE REFERENCES incidents(id) ON DELETE RESTRICT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
