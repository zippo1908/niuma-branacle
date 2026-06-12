-- Phase 2: review approvals (expand-only).

CREATE TYPE approval_status AS ENUM ('pending','accepted','rejected','changes_requested');

CREATE TABLE approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agent_runs(id),
  demand_id UUID NOT NULL REFERENCES demands(id),
  kind TEXT NOT NULL CHECK (kind IN ('diff_review','staging_deploy','production_deploy')),
  status approval_status NOT NULL DEFAULT 'pending',
  reviewer_id UUID REFERENCES users(id),
  comment TEXT,
  diff_id UUID REFERENCES diffs(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
CREATE INDEX approvals_run_idx ON approvals(run_id);
CREATE INDEX approvals_pending_idx ON approvals(status) WHERE status = 'pending';

-- track the git commit a run produced once approved
ALTER TABLE agent_runs ADD COLUMN commit_sha TEXT;
