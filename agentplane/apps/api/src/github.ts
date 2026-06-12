/** Minimal GitHub Actions reader for CI status (poll fallback when webhooks aren't reachable). */
export interface GitHubRepo {
  owner: string;
  repo: string;
}

export function parseGitHubRepo(repoUrl: string): GitHubRepo | null {
  const m =
    repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/) ??
    repoUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

export interface WorkflowRun {
  id: number;
  status: string | null;
  conclusion: string | null;
  html_url: string;
  head_branch: string | null;
  head_sha: string;
}

export async function latestWorkflowRunForBranch(gh: GitHubRepo, branch: string): Promise<WorkflowRun | null> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not set");
  const url = `https://api.github.com/repos/${gh.owner}/${gh.repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`GitHub Actions query failed (${res.status})`);
  const data = (await res.json()) as { workflow_runs?: WorkflowRun[] };
  return data.workflow_runs?.[0] ?? null;
}
