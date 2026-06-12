"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, type Project, type Demand } from "@/lib/api";

const TODAY = new Date().toISOString().slice(0, 10);

export default function HomePage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [stack, setStack] = useState<(Demand & { stackOrder: number | null; labels: string[] })[]>([]);
  const [planning, setPlanning] = useState(false);
  const [form, setForm] = useState({ slug: "", name: "", repo_url: "", default_branch: "main" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      await api.me();
    } catch {
      router.push("/login");
      return;
    }
    setProjects(await api.projects());
    setStack(await api.stack(TODAY).catch(() => []));
  }

  async function planToday() {
    setPlanning(true);
    try {
      await api.planStack(TODAY);
      setStack(await api.stack(TODAY));
    } finally {
      setPlanning(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.createProject(form);
      setForm({ slug: "", name: "", repo_url: "", default_branch: "main" });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wrap">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Home</h1>
        <button className="ghost" onClick={() => api.logout().then(() => router.push("/login"))}>Sign out</button>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Today&apos;s stack <span className="muted">{TODAY}</span></h3>
          <button disabled={planning} onClick={planToday}>{planning ? "Planning…" : "Plan today"}</button>
        </div>
        {stack.length === 0 && <p className="muted">Nothing planned. Hit “Plan today” to score &amp; order open demands.</p>}
        <ul className="steps">
          {stack.map((d) => (
            <li key={d.id} style={{ justifyContent: "space-between" }}>
              <span><b>{d.stackOrder}.</b> #{d.number} {d.title}</span>
              <span>
                {d.labels?.includes("needs-human") && <span className="badge b-fail">needs-human</span>}{" "}
                <span className="badge b-idle">{d.status}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <h2 style={{ marginTop: 20 }}>Projects</h2>
      {projects === null && <p className="muted">Loading…</p>}
      {projects?.map((p) => (
        <a key={p.id} href={`/projects/${p.id}`} className="card" style={{ display: "block" }}>
          <h3>{p.name} <span className="muted">/{p.slug}</span></h3>
          <div className="muted">{p.repoUrl}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <span className={`badge ${p.cloneStatus === "ready" ? "b-ok" : p.cloneStatus === "failed" ? "b-fail" : "b-wait"}`}>
              repo: {p.cloneStatus}
            </span>
            <span className="muted">branch {p.defaultBranch}</span>
          </div>
        </a>
      ))}
      {projects?.length === 0 && <p className="muted">No projects yet — register one below.</p>}

      <h2 style={{ marginTop: 24 }}>Register a project</h2>
      <form onSubmit={create} className="card">
        <label>Slug (a-z0-9-)
          <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="my-app" />
        </label>
        <label>Name
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My App" />
        </label>
        <label>Repo URL (git remote or local path)
          <input value={form.repo_url} onChange={(e) => setForm({ ...form, repo_url: e.target.value })} placeholder="git@github.com:me/app.git" />
        </label>
        <label>Default branch
          <input value={form.default_branch} onChange={(e) => setForm({ ...form, default_branch: e.target.value })} />
        </label>
        {err && <div className="err-msg">{err}</div>}
        <div style={{ marginTop: 14 }}>
          <button disabled={busy} type="submit">{busy ? "Creating…" : "Register + clone"}</button>
        </div>
      </form>
    </main>
  );
}
