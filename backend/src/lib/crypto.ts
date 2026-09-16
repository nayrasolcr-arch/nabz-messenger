// Cryptographic primitives: token generation, hashing, password hashing.
// Password hashing uses PBKDF2-SHA256 via WebCrypto (native, FIPS-grade).
// Iterations are configurable via PBKDF2_ITERATIONS (default 50k) - documented
// tradeoff for Workers free-tier CPU limits; see docs/SECURITY.md.

const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 256-bit opaque random token, url-safe. */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}

export function randomId(): string {
  return crypto.randomUUID();
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function safeEqualStrings(a: string, b: string): boolean {
  const ea = enc.encode(a);
  const eb = enc.encode(b);
  return timingSafeEqual(ea, eb);
}

async function pbkdf2Bits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations: number): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const bits = await pbkdf2Bits(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${b64urlEncode(salt)}$${b64urlEncode(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, iterStr, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'pbkdf2-sha256') return false;
    const iterations = parseInt(iterStr, 10);
    if (!Number.isFinite(iterations) || iterations < 1) return false;
    const bits = await pbkdf2Bits(password, b64urlDecode(saltB64), iterations);
    return timingSafeEqual(bits, b64urlDecode(hashB64));
  } catch {
    return false;
  }
}

/** Constant-time-ish dummy verify used when username does not exist (anti user-enumeration). */
export async function dummyVerify(iterations: number): Promise<void> {
  await pbkdf2Bits('dummy-password-for-timing', new Uint8Array(16), iterations);
}
