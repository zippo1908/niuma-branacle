-- Phase 5: append-only audit log (expand-only).

CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_id UUID REFERENCES users(id),
  actor_ip TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_resource_idx ON audit_logs(resource_type, resource_id);
CREATE INDEX audit_actor_idx ON audit_logs(actor_id, ts);
CREATE INDEX audit_action_idx ON audit_logs(action);

-- Append-only at the DB layer: once a dedicated low-privilege app role exists
-- (Phase 5 hardening), run:
--   REVOKE UPDATE, DELETE ON audit_logs FROM <app_role>;
