import path from "node:path";

/**
 * Resolve `untrusted` under `root` and guarantee the result stays inside `root`
 * (defence against `..` traversal and absolute-path injection). See
 * docs/architecture/09-security — every workspace/upload path goes through this.
 *
 * Note: this is a *lexical* check (no filesystem access). For the final realpath
 * check against symlinks, callers additionally verify with fs.realpath at runtime.
 */
export function safeJoin(root: string, ...untrusted: string[]): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...untrusted);
  const rel = path.relative(resolvedRoot, target);
  if (rel === "" ) return target; // target === root
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new PathTraversalError(root, untrusted.join("/"));
  }
  return target;
}

export class PathTraversalError extends Error {
  constructor(root: string, attempted: string) {
    super(`Path traversal blocked: "${attempted}" escapes root "${root}"`);
    this.name = "PathTraversalError";
  }
}

/** A slug safe for filesystem paths and URLs: `^[a-z0-9-]{2,40}$`. */
const SLUG_RE = /^[a-z0-9-]{2,40}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export function assertValidSlug(slug: string): void {
  if (!isValidSlug(slug)) {
    throw new Error(`Invalid slug "${slug}" — must match ${SLUG_RE}`);
  }
}

/**
 * Sanitize an uploaded filename for safe use inside a workspace: strip any
 * directory component, allow only a conservative charset, cap length.
 */
export function sanitizeFilename(original: string): string {
  const base = path.basename(original).replace(/\\/g, "");
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  const trimmed = cleaned.slice(0, 128);
  return trimmed.length > 0 ? trimmed : "file";
}
