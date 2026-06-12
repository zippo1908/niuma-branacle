const BASE = "/api/v1";

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    credentials: "include",
    headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    ...opts,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.error?.message ?? res.statusText;
    throw Object.assign(new Error(message), { status: res.status, code: data?.error?.code });
  }
  return data as T;
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  cloneStatus: string;
}
export interface Demand {
  id: string;
  number: number;
  title: string;
  status: string;
  runMode: string;
  acceptanceCriteria?: string | null;
}
export interface Run {
  id: string;
  status: string;
  runMode: string;
  exitCode: number | null;
  demandId?: string;
  projectId?: string;
  commitSha?: string | null;
  steps?: { seq: number; name: string; status: string }[];
  diff?: { filesChanged: number; insertions: number; deletions: number; isEmpty: boolean } | null;
}

export interface Deployment {
  id: string;
  environment: string;
  status: string;
  commitSha: string;
  url: string | null;
  rollbackOf: string | null;
}
export interface CiJob {
  id: string;
  status: string;
  externalUrl: string | null;
  ref: string | null;
}

export const api = {
  me: () => req<{ id: string; email: string; display_name: string }>("/auth/me"),
  login: (email: string, password: string) =>
    req<{ id: string }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => req<void>("/auth/logout", { method: "POST" }),

  projects: () => req<Project[]>("/projects"),
  createProject: (b: { slug: string; name: string; repo_url: string; default_branch?: string }) =>
    req<Project>("/projects", { method: "POST", body: JSON.stringify(b) }),
  project: (id: string) =>
    req<Project & { active_runs: Run[]; locks: Lock[] }>(`/projects/${id}`),
  releaseLock: (projectId: string, lockId: string) =>
    req<{ status: string }>(`/projects/${projectId}/locks/${lockId}/release`, { method: "POST", body: "{}" }),

  demands: (projectId: string) => req<Demand[]>(`/demands?project_id=${projectId}`),
  stack: (date: string) => req<(Demand & { stackOrder: number | null; labels: string[] })[]>(`/demands/stack?date=${date}`),
  planStack: (date: string, projectId?: string) =>
    req<{ count: number; auto_run_enabled: boolean }>(`/demands/stack/plan?date=${date}${projectId ? `&project_id=${projectId}` : ""}`, { method: "POST", body: "{}" }),
  createDemand: (b: { project_id: string; title: string; acceptance_criteria?: string; run_mode?: string }) =>
    req<Demand>("/demands", { method: "POST", body: JSON.stringify(b) }),
  demand: (id: string) =>
    req<Demand & { runs: Run[]; comments: { kind: string; body: string }[]; attachments: unknown[] }>(`/demands/${id}`),
  runDemand: (id: string) => req<{ run_id: string }>(`/demands/${id}/run`, { method: "POST", body: "{}" }),

  run: (id: string) => req<Run>(`/runs/${id}`),
  runDiff: (id: string) =>
    req<{ files_changed: number; insertions: number; deletions: number; is_empty: boolean; patch: string }>(`/runs/${id}/diff`),
  approve: (id: string, comment?: string) =>
    req<{ decision: string }>(`/runs/${id}/approve`, { method: "POST", body: JSON.stringify({ comment }) }),
  approveAndShip: (id: string) =>
    req<{ decision: string; shipping: boolean }>(`/runs/${id}/approve?auto=ship`, { method: "POST", body: "{}" }),
  reject: (id: string, comment?: string) =>
    req<{ decision: string }>(`/runs/${id}/reject`, { method: "POST", body: JSON.stringify({ comment }) }),
  stop: (id: string) => req<void>(`/runs/${id}/stop`, { method: "POST", body: "{}" }),
  retry: (id: string) => req<{ new_run_id: string }>(`/runs/${id}/retry`, { method: "POST", body: "{}" }),

  deploy: (demandId: string, environment: string) =>
    req<{ deployment_id: string }>(`/demands/${demandId}/deploy`, { method: "POST", body: JSON.stringify({ environment }) }),
  deployments: (projectId: string) => req<Deployment[]>(`/deployments?project_id=${projectId}`),
  rollback: (deploymentId: string) =>
    req<{ deployment_id: string }>(`/deployments/${deploymentId}/rollback`, { method: "POST", body: "{}" }),
  ciJobs: (demandId: string) => req<CiJob[]>(`/ci-jobs?demand_id=${demandId}`),
  ciRefresh: (demandId: string) => req<{ ci: unknown }>(`/demands/${demandId}/ci/refresh`, { method: "POST", body: "{}" }),
};

export interface Lock {
  id: string;
  branch: string;
  holderRunId: string | null;
  expiresAt: string;
}
