import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "AgentPlane",
  description: "Demand-driven control plane for AI coding agents",
};

export const viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <a href="/" className="brand">▚ AgentPlane</a>
          <span className="muted">control plane</span>
        </header>
        {children}
      </body>
    </html>
  );
}
