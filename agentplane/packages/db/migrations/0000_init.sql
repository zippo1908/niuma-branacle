-- AgentPlane initial schema (Phase 1 subset). expand-only.

CREATE TYPE demand_status AS ENUM (
  'inbox','clarified','queued','running','waiting_review',
  'accepted','rejected','building','preview','deployed',
  'done','failed','cancelled');
CREATE TYPE agent_run_status AS ENUM (
  'queued','preparing_workspace','running','waiting_user_input',
  'waiting_review','succeeded','failed','cancelled','timed_out');
CREATE TYPE run_mode AS ENUM ('analysis','edit','test','build','deploy');
CREATE TYPE risk_level AS ENUM ('low','medium','high','critical');
CREATE TYPE lock_status AS ENUM ('held','released','expired','force_released');
CREATE TYPE member_role AS ENUM ('viewer','developer','reviewer','admin','owner');

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  display_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_superadmin BOOLEAN NOT NULL DEFAULT false,
  last_login_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9-]{2,40}$'),
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  bare_repo_path TEXT,
  risk_level risk_level NOT NULL DEFAULT 'medium',
  allow_dangerous_mode BOOLEAN NOT NULL DEFAULT false,
  clone_status TEXT NOT NULL DEFAULT 'pending',
  settings JSONB NOT NULL DEFAULT '{}',
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX projects_org_slug_uq ON projects(org_id, slug);

CREATE TABLE project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  role member_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX project_members_uq ON project_members(project_id, user_id);

CREATE TABLE agent_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  executor TEXT NOT NULL,
  binary_path TEXT,
  default_args TEXT[] NOT NULL DEFAULT '{}',
  env_allowlist TEXT[] NOT NULL DEFAULT '{}',
  supports_vision BOOLEAN NOT NULL DEFAULT false,
  max_timeout_seconds INTEGER NOT NULL DEFAULT 7200,
  allowed_run_modes run_mode[] NOT NULL DEFAULT '{}',
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE demands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL CHECK (length(title) <= 200),
  description TEXT,
  acceptance_criteria TEXT,
  context_files TEXT[] NOT NULL DEFAULT '{}',
  target_branch TEXT NOT NULL,
  work_branch TEXT,
  priority SMALLINT NOT NULL DEFAULT 3,
  labels TEXT[] NOT NULL DEFAULT '{}',
  target_agent_profile_id UUID REFERENCES agent_profiles(id),
  run_mode run_mode NOT NULL DEFAULT 'edit',
  risk_level risk_level NOT NULL DEFAULT 'medium',
  status demand_status NOT NULL DEFAULT 'inbox',
  owner_id UUID REFERENCES users(id),
  reviewer_id UUID REFERENCES users(id),
  parent_demand_id UUID,
  linked_pr_url TEXT,
  scheduled_date DATE,
  stack_order INTEGER,
  retry_count SMALLINT NOT NULL DEFAULT 0,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX demands_project_number_uq ON demands(project_id, number);
CREATE INDEX demands_project_status_idx ON demands(project_id, status);
CREATE INDEX demands_stack_idx ON demands(scheduled_date, stack_order);

CREATE TABLE demand_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_id UUID NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  author_id UUID REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user','system','review_feedback','agent')),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX demand_comments_idx ON demand_comments(demand_id, created_at);

CREATE TABLE demand_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_id UUID NOT NULL REFERENCES demands(id) ON DELETE CASCADE,
  uploader_id UUID REFERENCES users(id),
  original_filename TEXT NOT NULL,
  safe_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 52428800),
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX demand_attachments_demand_idx ON demand_attachments(demand_id);

CREATE TABLE agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  demand_id UUID NOT NULL REFERENCES demands(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  agent_profile_id UUID REFERENCES agent_profiles(id),
  run_mode run_mode NOT NULL,
  status agent_run_status NOT NULL DEFAULT 'queued',
  attempt SMALLINT NOT NULL DEFAULT 1,
  triggered_by UUID REFERENCES users(id),
  workspace_id UUID,
  lock_id UUID,
  prompt TEXT,
  dangerous_mode BOOLEAN NOT NULL DEFAULT false,
  exit_code INTEGER,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  timeout_seconds INTEGER NOT NULL DEFAULT 3600,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agent_runs_demand_idx ON agent_runs(demand_id, attempt);
CREATE INDEX agent_runs_status_idx ON agent_runs(status);
CREATE INDEX agent_runs_project_idx ON agent_runs(project_id, created_at);

CREATE TABLE run_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','skipped')),
  command TEXT,
  exit_code INTEGER,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  meta JSONB NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX run_steps_run_seq_uq ON run_steps(run_id, seq);

CREATE TABLE run_logs (
  id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES agent_runs(id),
  step_id UUID,
  seq BIGINT NOT NULL,
  stream TEXT NOT NULL CHECK (stream IN ('stdout','stderr','event')),
  content TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX run_logs_run_seq_uq ON run_logs(run_id, seq);

CREATE TABLE run_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agent_runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('diff','test_report','build_output','coverage','screenshot','other')),
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  size_bytes BIGINT,
  sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX run_artifacts_run_idx ON run_artifacts(run_id);

CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL UNIQUE REFERENCES agent_runs(id),
  project_id UUID NOT NULL REFERENCES projects(id),
  path TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'worktree' CHECK (kind IN ('worktree','clone','docker')),
  base_branch TEXT NOT NULL,
  work_branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','ready','in_use','dirty','cleaned','failed')),
  cleaned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workspaces_project_status_idx ON workspaces(project_id, status);

CREATE TABLE project_locks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  branch TEXT NOT NULL,
  lock_key TEXT NOT NULL,
  holder_run_id UUID REFERENCES agent_runs(id),
  holder_worker_id TEXT,
  reason TEXT,
  status lock_status NOT NULL DEFAULT 'held',
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_heartbeat_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  released_by UUID REFERENCES users(id)
);
-- DB-level backstop: at most one held lock per project+branch.
CREATE UNIQUE INDEX project_locks_active_uq ON project_locks(project_id, branch) WHERE status = 'held';
CREATE INDEX project_locks_holder_idx ON project_locks(holder_run_id);

CREATE TABLE diffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agent_runs(id),
  base_commit TEXT NOT NULL,
  patch TEXT,
  patch_artifact_id UUID REFERENCES run_artifacts(id),
  files_changed INTEGER NOT NULL DEFAULT 0,
  insertions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  summary JSONB NOT NULL DEFAULT '{}',
  is_empty BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (patch IS NOT NULL OR patch_artifact_id IS NOT NULL OR is_empty)
);
CREATE INDEX diffs_run_idx ON diffs(run_id);

CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
