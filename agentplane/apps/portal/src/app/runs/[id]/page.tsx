"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, type Run, type Deployment } from "@/lib/api";

const EVENT_TYPES = [
  "run.created", "run.queued", "workspace.created", "lock.acquired", "lock.released",
  "agent.started", "agent.output", "command.started", "command.finished", "step.updated",
  "diff.generated", "approval.requested", "commit.created", "push.completed", "pr.created",
  "run.succeeded", "run.failed", "run.cancelled", "run.timed_out",
];
const TERMINAL = new Set(["run.succeeded", "run.failed", "run.cancelled", "run.timed_out"]);

interface LogEntry { seq: number; cls: string; text: string; }

function statusBadge(s: string) {
  const cls =
    s === "running" || s === "queued" || s === "preparing_workspace" ? "b-run"
    : s === "waiting_review" ? "b-wait"
    : s === "succeeded" ? "b-ok"
    : s === "failed" || s === "cancelled" || s === "timed_out" ? "b-fail"
    : "b-idle";
  return <span className={`badge ${cls}`}>{s}</span>;
}

export default function RunPage({ params }: { params: { id: string } }) {
  const id = params.id;
  const router = useRouter();
  const [run, setRun] = useState<Run | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [diff, setDiff] = useState<{ patch: string; files_changed: number; insertions: number; deletions: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [deps, setDeps] = useState<Deployment[]>([]);
  const logRef = useRef<HTMLDivElement>(null);

  const loadDeps = (projectId?: string) => {
    if (projectId) api.deployments(projectId).then(setDeps).catch(() => {});
  };

  const refreshRun = () => api.run(id).then(setRun).catch(() => {});
  const loadDiff = () => api.runDiff(id).then(setDiff).catch(() => setDiff(null));

  useEffect(() => {
    void refreshRun();
    const es = new EventSource(`/api/v1/runs/${id}/events`, { withCredentials: true });
    const onEvt = (type: string) => (e: MessageEvent) => {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(e.data); } catch { /* keep empty */ }
      const seq = Number(data.seq ?? 0);
      if (type === "agent.output") {
        const stream = String(data.stream ?? "stdout");
        setLogs((l) => [...l, { seq, cls: stream === "stderr" ? "err" : "", text: String(data.content ?? "") }]);
      } else {
        setLogs((l) => [...l, { seq, cls: "ev", text: `● ${type} ${summarize(type, data)}` }]);
      }
      if (type === "diff.generated") void loadDiff();
      if (TERMINAL.has(type) || type === "approval.requested") void refreshRun();
    };
    for (const t of EVENT_TYPES) es.addEventListener(t, onEvt(t));
    es.onerror = () => { /* EventSource auto-reconnects with Last-Event-ID */ };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  useEffect(() => {
    if (run?.status === "waiting_review" && !diff) void loadDiff();
    if (run?.commitSha) loadDeps(run.projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.status, run?.commitSha]);

  async function decide(kind: "approve" | "ship" | "reject") {
    setBusy(true);
    try {
      if (kind === "approve") await api.approve(id);
      else if (kind === "ship") await api.approveAndShip(id);
      else await api.reject(id, "Please revise.");
      await refreshRun();
    } finally {
      setBusy(false);
    }
  }

  const reviewing = run?.status === "waiting_review";

  return (
    <main className="wrap">
      <a href="/" className="muted">← home</a>
      <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
        <h1>Run</h1>
        <div className="row">
          {run && ["failed", "cancelled", "timed_out"].includes(run.status) && (
            <button onClick={async () => { const r = await api.retry(id); router.push(`/runs/${r.new_run_id}`); }}>↻ Retry</button>
          )}
          {run && statusBadge(run.status)}
        </div>
      </div>
      <div className="muted">{id}</div>

      {run?.steps && run.steps.length > 0 && (
        <div className="card">
          <h3>Timeline</h3>
          <ul className="steps">
            {run.steps.map((s) => (
              <li key={s.seq}>{stepIcon(s.status)} {s.name} <span className="muted">{s.status}</span></li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Live logs</h3>
          {run && !["succeeded", "failed", "cancelled", "timed_out", "waiting_review"].includes(run.status) && (
            <button className="ghost" onClick={() => api.stop(id)}>Stop</button>
          )}
        </div>
        <div className="logs" ref={logRef}>
          {logs.length === 0 && <span className="ev">waiting for output…</span>}
          {logs.map((l, i) => (
            <div key={`${l.seq}-${i}`} className={l.cls}>{l.text}</div>
          ))}
        </div>
      </div>

      {diff && (
        <div className="card">
          <h3>Diff <span className="muted">{diff.files_changed} files · +{diff.insertions} −{diff.deletions}</span></h3>
          <pre className="diff">
            {(diff.patch || "").split("\n").map((line, i) => (
              <div key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : ""}>{line}</div>
            ))}
          </pre>
          {reviewing && (
            <div className="row" style={{ marginTop: 12 }}>
              <button className="green" disabled={busy} onClick={() => decide("ship")}>🚀 Approve &amp; ship</button>
              <button disabled={busy} onClick={() => decide("approve")}>✓ Approve only</button>
              <button className="red" disabled={busy} onClick={() => decide("reject")}>✗ Request changes</button>
            </div>
          )}
        </div>
      )}

      {run?.commitSha && (
        <div className="card">
          <h3>Ship &amp; deploy <span className="muted">commit {run.commitSha.slice(0, 8)}</span></h3>
          {run.demandId && (
            <div className="row" style={{ marginTop: 8 }}>
              <button disabled={busy} onClick={async () => { setBusy(true); try { await api.deploy(run.demandId!, "staging"); loadDeps(run.projectId); } finally { setBusy(false); } }}>Deploy → staging</button>
              <button disabled={busy} onClick={async () => { setBusy(true); try { await api.deploy(run.demandId!, "production"); loadDeps(run.projectId); } finally { setBusy(false); } }}>Deploy → production</button>
            </div>
          )}
          {deps.length > 0 && (
            <ul className="steps" style={{ marginTop: 12 }}>
              {deps.slice(0, 6).map((d) => (
                <li key={d.id} style={{ justifyContent: "space-between" }}>
                  <span>
                    <span className={`badge ${d.status === "succeeded" ? "b-ok" : d.status === "failed" ? "b-fail" : d.status === "rolled_back" ? "b-idle" : "b-wait"}`}>{d.environment}</span>{" "}
                    <span className="muted">{d.status} · {d.commitSha.slice(0, 8)}</span>{" "}
                    {d.url && <a href={d.url} target="_blank" rel="noreferrer">{d.url}</a>}
                  </span>
                  {d.status === "succeeded" && !d.rollbackOf && (
                    <button className="ghost" onClick={async () => { await api.rollback(d.id); loadDeps(run.projectId); }}>Rollback</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </main>
  );
}

function stepIcon(s: string) {
  return s === "succeeded" ? "✓" : s === "failed" ? "✗" : s === "running" ? "…" : "·";
}
function summarize(type: string, d: Record<string, unknown>) {
  if (type === "workspace.created") return String(d.work_branch ?? "");
  if (type === "diff.generated") return `${d.files_changed ?? 0} files`;
  if (type === "step.updated") return `${d.name ?? ""} ${d.status ?? ""}`;
  if (type === "commit.created") return String(d.commit_sha ?? "").slice(0, 10);
  if (type === "pr.created") return String(d.url ?? "");
  if (type === "run.failed") return String(d.error_message ?? d.exit_code ?? "");
  return "";
}
