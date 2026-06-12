/**
 * Minimal GitHub REST client for opening PRs. Uses GITHUB_TOKEN from the env
 * (Phase 4 will move this to a GitHub App + isolated deploy credentials).
 */
export interface GitHubRepo {
  owner: string;
  repo: string;
}

export function parseGitHubRepo(repoUrl: string): GitHubRepo | null {
  // git@github.com:owner/repo.git  |  https://github.com/owner/repo(.git)
  const m =
    repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/) ??
    repoUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

export interface CreatedPr {
  html_url: string;
  number: number;
}

export async function createPullRequest(
  gh: GitHubRepo,
  input: { title: string; body: string; head: string; base: string },
): Promise<CreatedPr> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not set");
  const res = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PR create failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as CreatedPr;
  return { html_url: data.html_url, number: data.number };
}
