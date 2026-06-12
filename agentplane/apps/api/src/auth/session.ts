import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

const COOKIE = "ap_session";

function sign(value: string): string {
  const mac = createHmac("sha256", config.sessionSecret).update(value).digest("base64url");
  return `${value}.${mac}`;
}

export function makeSessionCookie(userId: string): string {
  const signed = sign(userId);
  const attrs = [
    `${COOKIE}=${signed}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=2592000",
    config.cookieSecure ? "Secure" : "",
  ].filter(Boolean);
  return attrs.join("; ");
}

export function clearSessionCookie(): string {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

export function readSession(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const found = cookieHeader.split(";").map((s) => s.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  if (!found) return null;
  const signed = decodeURIComponent(found.slice(COOKIE.length + 1));
  const dot = signed.lastIndexOf(".");
  if (dot < 0) return null;
  const value = signed.slice(0, dot);
  const expected = sign(value);
  const a = Buffer.from(signed);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return value;
}
