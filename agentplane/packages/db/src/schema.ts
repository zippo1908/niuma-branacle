/**
 * Drizzle schema — Phase 1 subset of docs/architecture/03-data-model.
 * Tables not yet needed by the MVP loop (ci_jobs, deployments, audit_logs,
 * organizations beyond seed, etc.) are intentionally deferred per the roadmap.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  smallint,
  bigint,
  bigserial,
  jsonb,
  date,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ── enums ─────────────────────────────────────────────────────────────────────
export const demandStatus = pgEnum("demand_status", [
  "inbox", "clarified", "queued", "running", "waiting_review",
  "accepted", "rejected", "building", "preview", "deployed",
  "done", "failed", "cancelled",
]);
export const agentRunStatus = pgEnum("agent_run_status", [
  "queued", "preparing_workspace", "running", "waiting_user_input",
  "waiting_review", "succeeded", "failed", "cancelled", "timed_out",
]);
export const runMode = pgEnum("run_mode", ["analysis", "edit", "test", "build", "deploy"]);
export const riskLevel = pgEnum("risk_level", ["low", "medium", "high", "critical"]);
export const lockStatus = pgEnum("lock_status", ["held", "released", "expired", "force_released"]);
export const memberRole = pgEnum("member_role", ["viewer", "developer", "reviewer", "admin", "owner"]);
export const approvalStatus = pgEnum("approval_status", ["pending", "accepted", "rejected", "changes_requested"]);

// ── organizations / users / projects ───────────────────────────────────────────
export const organizations = pgTable("organizations", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  settings: jsonb("settings").notNull().default({}),
  createdAt: createdAt(),
});

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),
  displayName: text("display_name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  isSuperadmin: boolean("is_superadmin").notNull().default(false),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const projects = pgTable(
  "projects",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    repoUrl: text("repo_url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    bareRepoPath: text("bare_repo_path"),
    riskLevel: riskLevel("risk_level").notNull().default("medium"),
    allowDangerousMode: boolean("allow_dangerous_mode").notNull().default(false),
    cloneStatus: text("clone_status").notNull().default("pending"), // pending|cloning|ready|failed
    settings: jsonb("settings").notNull().default({}),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({ orgSlug: uniqueIndex("projects_org_slug_uq").on(t.orgId, t.slug) }),
);

export const projectMembers = pgTable(
  "project_members",
  {
    id: id(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id),
    role: memberRole("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => ({ uq: uniqueIndex("project_members_uq").on(t.projectId, t.userId) }),
);

// ── agent profiles ──────────────────────────────────────────────────────────
export const agentProfiles = pgTable("agent_profiles", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  executor: text("executor").notNull(), // codex | claude | shell
  binaryPath: text("binary_path"),
  defaultArgs: text("default_args").array().notNull().default(sql`'{}'::text[]`),
  envAllowlist: text("env_allowlist").array().notNull().default(sql`'{}'::text[]`),
  supportsVision: boolean("supports_vision").notNull().default(false),
  maxTimeoutSeconds: integer("max_timeout_seconds").notNull().default(7200),
  allowedRunModes: runMode("allowed_run_modes").array().notNull().default(sql`'{}'::run_mode[]`),
  isEnabled: boolean("is_enabled").notNull().default(true),
  config: jsonb("config").notNull().default({}),
  createdAt: createdAt(),
});

// ── demands ───────────────────────────────────────────────────────────────────
export const demands = pgTable(
  "demands",
  {
    id: id(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    acceptanceCriteria: text("acceptance_criteria"),
    contextFiles: text("context_files").array().notNull().default(sql`'{}'::text[]`),
    targetBranch: text("target_branch").notNull(),
    workBranch: text("work_branch"),
    priority: smallint("priority").notNull().default(3),
    labels: text("labels").array().notNull().default(sql`'{}'::text[]`),
    targetAgentProfileId: uuid("target_agent_profile_id").references(() => agentProfiles.id),
    runMode: runMode("run_mode").notNull().default("edit"),
    riskLevel: riskLevel("risk_level").notNull().default("medium"),
    status: demandStatus("status").notNull().default("inbox"),
    ownerId: uuid("owner_id").references(() => users.id),
    reviewerId: uuid("reviewer_id").references(() => users.id),
    parentDemandId: uuid("parent_demand_id"),
    linkedPrUrl: text("linked_pr_url"),
    scheduledDate: date("scheduled_date"),
    stackOrder: integer("stack_order"),
    retryCount: smallint("retry_count").notNull().default(0),
    failureReason: text("failure_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    numberUq: uniqueIndex("demands_project_number_uq").on(t.projectId, t.number),
    statusIdx: index("demands_project_status_idx").on(t.projectId, t.status),
    stackIdx: index("demands_stack_idx").on(t.scheduledDate, t.stackOrder),
  }),
);

export const demandComments = pgTable(
  "demand_comments",
  {
    id: id(),
    demandId: uuid("demand_id").notNull().references(() => demands.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").references(() => users.id),
    kind: text("kind").notNull().default("user"), // user|system|review_feedback|agent
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => ({ idx: index("demand_comments_idx").on(t.demandId, t.createdAt) }),
);

export const demandAttachments = pgTable(
  "demand_attachments",
  {
    id: id(),
    demandId: uuid("demand_id").notNull().references(() => demands.id, { onDelete: "cascade" }),
    uploaderId: uuid("uploader_id").references(() => users.id),
    originalFilename: text("original_filename").notNull(),
    safeFilename: text("safe_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    storagePath: text("storage_path").notNull(),
    createdAt: createdAt(),
  },
  (t) => ({ idx: index("demand_attachments_demand_idx").on(t.demandId) }),
);

// ── runs ──────────────────────────────────────────────────────────────────────
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: id(),
    demandId: uuid("demand_id").notNull().references(() => demands.id),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    agentProfileId: uuid("agent_profile_id").references(() => agentProfiles.id),
    runMode: runMode("run_mode").notNull(),
    status: agentRunStatus("status").notNull().default("queued"),
    attempt: smallint("attempt").notNull().default(1),
    triggeredBy: uuid("triggered_by").references(() => users.id),
    workspaceId: uuid("workspace_id"),
    lockId: uuid("lock_id"),
    prompt: text("prompt"),
    dangerousMode: boolean("dangerous_mode").notNull().default(false),
    exitCode: integer("exit_code"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    timeoutSeconds: integer("timeout_seconds").notNull().default(3600),
    errorMessage: text("error_message"),
    commitSha: text("commit_sha"),
    createdAt: createdAt(),
  },
  (t) => ({
    demandIdx: index("agent_runs_demand_idx").on(t.demandId, t.attempt),
    statusIdx: index("agent_runs_status_idx").on(t.status),
    projIdx: index("agent_runs_project_idx").on(t.projectId, t.createdAt),
  }),
);

export const runSteps = pgTable(
  "run_steps",
  {
    id: id(),
    runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull().default("pending"), // pending|running|succeeded|failed|skipped
    command: text("command"),
    exitCode: integer("exit_code"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    meta: jsonb("meta").notNull().default({}),
  },
  (t) => ({ uq: uniqueIndex("run_steps_run_seq_uq").on(t.runId, t.seq) }),
);

export const runLogs = pgTable(
  "run_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: uuid("run_id").notNull().references(() => agentRuns.id),
    stepId: uuid("step_id"),
    seq: bigint("seq", { mode: "number" }).notNull(),
    stream: text("stream").notNull(), // stdout|stderr|event
    content: text("content").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ uq: uniqueIndex("run_logs_run_seq_uq").on(t.runId, t.seq) }),
);

export const runArtifacts = pgTable(
  "run_artifacts",
  {
    id: id(),
    runId: uuid("run_id").notNull().references(() => agentRuns.id),
    kind: text("kind").notNull(), // diff|test_report|build_output|coverage|screenshot|other
    filename: text("filename").notNull(),
    storagePath: text("storage_path").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sha256: text("sha256"),
    createdAt: createdAt(),
  },
  (t) => ({ idx: index("run_artifacts_run_idx").on(t.runId) }),
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: id(),
    runId: uuid("run_id").notNull().unique().references(() => agentRuns.id),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    path: text("path").notNull().unique(),
    kind: text("kind").notNull().default("worktree"), // worktree|clone|docker
    baseBranch: text("base_branch").notNull(),
    workBranch: text("work_branch").notNull(),
    baseCommit: text("base_commit").notNull(),
    status: text("status").notNull().default("creating"), // creating|ready|in_use|dirty|cleaned|failed
    cleanedAt: timestamp("cleaned_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => ({ idx: index("workspaces_project_status_idx").on(t.projectId, t.status) }),
);

export const projectLocks = pgTable(
  "project_locks",
  {
    id: id(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    branch: text("branch").notNull(),
    lockKey: text("lock_key").notNull(),
    holderRunId: uuid("holder_run_id").references(() => agentRuns.id),
    holderWorkerId: text("holder_worker_id"),
    reason: text("reason"),
    status: lockStatus("status").notNull().default("held"),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: uuid("released_by").references(() => users.id),
  },
  (t) => ({ holderIdx: index("project_locks_holder_idx").on(t.holderRunId) }),
);

export const diffs = pgTable(
  "diffs",
  {
    id: id(),
    runId: uuid("run_id").notNull().references(() => agentRuns.id),
    baseCommit: text("base_commit").notNull(),
    patch: text("patch"),
    patchArtifactId: uuid("patch_artifact_id").references(() => runArtifacts.id),
    filesChanged: integer("files_changed").notNull().default(0),
    insertions: integer("insertions").notNull().default(0),
    deletions: integer("deletions").notNull().default(0),
    summary: jsonb("summary").notNull().default({}),
    isEmpty: boolean("is_empty").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => ({ idx: index("diffs_run_idx").on(t.runId) }),
);

export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    runId: uuid("run_id").notNull().references(() => agentRuns.id),
    demandId: uuid("demand_id").notNull().references(() => demands.id),
    kind: text("kind").notNull(), // diff_review | staging_deploy | production_deploy
    status: approvalStatus("status").notNull().default("pending"),
    reviewerId: uuid("reviewer_id").references(() => users.id),
    comment: text("comment"),
    diffId: uuid("diff_id").references(() => diffs.id),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => ({ runIdx: index("approvals_run_idx").on(t.runId) }),
);

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  description: text("description"),
  updatedAt: updatedAt(),
});
