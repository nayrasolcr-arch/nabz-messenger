// Durable Object based sliding-window rate limiter.
// Wraps the RATE_LIMITER DO; fails OPEN on DO errors to protect availability
// (documented in docs/SECURITY.md).

export async function rateLimit(
  env: Env,
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  try {
    const id = env.RATE_LIMITER.idFromName('global');
    const stub = env.RATE_LIMITER.get(id);
    const res = await stub.fetch('https://rate-limiter/check', {
      method: 'POST',
      body: JSON.stringify({ key, limit, windowMs }),
    });
    if (!res.ok) return { allowed: true, retryAfterSec: 0 };
    const data = (await res.json()) as { allowed: boolean; retryAfterSec: number };
    return data;
  } catch {
    return { allowed: true, retryAfterSec: 0 };
  }
}

export function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? '0.0.0.0';
}
