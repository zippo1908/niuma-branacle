import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Password hashing. The architecture targets argon2id; for a dependency-light,
 * native-build-free MVP we use Node's built-in scrypt (memory-hard) with the
 * same stored-format discipline. Swap the implementation here for argon2id in
 * production without touching call sites.  Format: `scrypt$N$<salt>$<hash>`.
 */
const N = 16384; // CPU/memory cost
const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N });
  return `scrypt$${N}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const salt = Buffer.from(parts[2]!, "hex");
  const expected = Buffer.from(parts[3]!, "hex");
  const actual = scryptSync(password, salt, expected.length, { N: n });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
