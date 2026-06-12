"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, type Demand, type Project } from "@/lib/api";

function statusBadge(s: string) {
  const cls =
    s === "running" || s === "queued" ? "b-run"
    : s === "waiting_review" ? "b-wait"
    : s === "accepted" || s === "done" || s === "deployed" ? "b-ok"
    : s === "failed" || s === "rejected" || s === "cancelled" ? "b-fail"
    : "b-idle";
  return <span className={`badge ${cls}`}>{s}</span>;
}

export default function ProjectPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [demands, setDemands] = useState<Demand[]>([]);
  const [form, setForm] = useState({ title: "", acceptance_criteria: "", run_mode: "edit" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setProject(await api.project(params.id));
      setDemands(await api.demands(params.id));
    } catch (e) {
      if ((e as { status?: number }).status === 401) router.push("/login");
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.createDemand({ project_id: params.id, ...form });
      setForm({ title: "", acceptance_criteria: "", run_mode: "edit" });
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function run(d: Demand) {
    const { run_id } = await api.runDemand(d.id);
    router.push(`/runs/${run_id}`);
  }

  return (
    <main className="wrap">
      <a href="/" className="muted">← projects</a>
      <h1>{project?.name ?? "Project"}</h1>

      <h2 style={{ marginTop: 20 }}>Demands</h2>
      {demands.length === 0 && <p className="muted">No demands yet.</p>}
      {demands.map((d) => (
        <div key={d.id} className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3>#{d.number} {d.title}</h3>
            {statusBadge(d.status)}
          </div>
          <div className="muted">{d.runMode}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button onClick={() => run(d)}>▶ Run agent</button>
            <a href={`/projects/${params.id}`} className="muted" />
          </div>
        </div>
      ))}

      <h2 style={{ marginTop: 24 }}>File a demand</h2>
      <form onSubmit={create} className="card">
        <label>Title
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Fix the iOS login button" />
        </label>
        <label>Acceptance criteria (Markdown checklist)
          <textarea rows={4} value={form.acceptance_criteria}
            onChange={(e) => setForm({ ...form, acceptance_criteria: e.target.value })}
            placeholder={"- [ ] iOS Safari can log in\n- [ ] No desktop regression"} />
        </label>
        <label>Run mode
          <select value={form.run_mode} onChange={(e) => setForm({ ...form, run_mode: e.target.value })}>
            <option value="edit">edit</option>
            <option value="analysis">analysis</option>
            <option value="test">test</option>
          </select>
        </label>
        {err && <div className="err-msg">{err}</div>}
        <div style={{ marginTop: 14 }}>
          <button disabled={busy || !form.title} type="submit">{busy ? "Creating…" : "Create demand"}</button>
        </div>
      </form>
    </main>
  );
}
