"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("admin@agentplane.local");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api.login(email.trim(), password);
      router.push("/");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="wrap">
      <h1>Sign in</h1>
      <p className="muted">Single-user MVP. Credentials are seeded via <code>pnpm db:seed</code>.</p>
      <form onSubmit={submit} className="card">
        <label>Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" />
        </label>
        <label>Password
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" />
        </label>
        {err && <div className="err-msg">{err}</div>}
        <div style={{ marginTop: 16 }}>
          <button disabled={busy || !password} type="submit">{busy ? "Signing in…" : "Sign in"}</button>
        </div>
      </form>
    </main>
  );
}
