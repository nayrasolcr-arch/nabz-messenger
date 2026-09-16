// RateLimiter: sliding-window limiter backed by a single Durable Object.
// In-memory buckets; a restart merely resets limits (acceptable for abuse damping).

interface CheckBody {
  key: string;
  limit: number;
  windowMs: number;
}

export class RateLimiter implements DurableObject {
  private buckets: Map<string, number[]> = new Map();

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/check') return new Response('not found', { status: 404 });
    const body = (await request.json()) as CheckBody;
    const now = Date.now();
    const arr = (this.buckets.get(body.key) ?? []).filter((t) => t > now - body.windowMs);
    if (arr.length >= body.limit) {
      const retryAfterMs = arr.length > 0 ? arr[0] + body.windowMs - now : body.windowMs;
      return Response.json({ allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) });
    }
    arr.push(now);
    this.buckets.set(body.key, arr);
    if (this.buckets.size > 5000) {
      // prune stale keys to bound memory
      for (const [k, v] of this.buckets) {
        if (v.every((t) => t <= now - body.windowMs)) this.buckets.delete(k);
      }
    }
    return Response.json({ allowed: true, retryAfterSec: 0 });
  }
}
