-- Phase 4: CI/CD — ci_jobs + deployments (expand-only).

CREATE TYPE ci_status AS ENUM ('pending','queued','in_progress','success','failure','cancelled');
CREATE TYPE deployment_status AS ENUM ('pending','deploying','succeeded','failed','rolled_back');

CREATE TABLE ci_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_id UUID NOT NULL REFERENCES demands(id),
  run_id UUID REFERENCES agent_runs(id),
  provider TEXT NOT NULL DEFAULT 'github_actions',
  external_id TEXT,
  external_url TEXT,
  ref TEXT,
  status ci_status NOT NULL DEFAULT 'pending',
  conclusion_detail JSONB NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ci_jobs_demand_idx ON ci_jobs(demand_id);
CREATE UNIQUE INDEX ci_jobs_provider_ext_uq ON ci_jobs(provider, external_id);

CREATE TABLE deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_id UUID REFERENCES demands(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  environment TEXT NOT NULL CHECK (environment IN ('preview','staging','production')),
  status deployment_status NOT NULL DEFAULT 'pending',
  commit_sha TEXT NOT NULL,
  approval_id UUID REFERENCES approvals(id),
  deployed_by UUID REFERENCES users(id),
  url TEXT,
  rollback_of UUID REFERENCES deployments(id),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deployments_proj_env_idx ON deployments(project_id, environment, created_at);
-- at most one in-flight deploy per project+environment
CREATE UNIQUE INDEX deployments_active_uq ON deployments(project_id, environment) WHERE status = 'deploying';
