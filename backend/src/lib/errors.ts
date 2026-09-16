// Central error type + helpers. All errors are mapped to a consistent JSON envelope
// by the onError handler in index.ts. Internal details are never leaked to clients.
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const unauthorized = (code = 'UNAUTHORIZED', msg = 'Authentication required') => new ApiError(401, code, msg);
export const forbidden = (code = 'FORBIDDEN', msg = 'Not allowed') => new ApiError(403, code, msg);
export const notFound = (code = 'NOT_FOUND', msg = 'Not found') => new ApiError(404, code, msg);
export const badRequest = (code = 'BAD_REQUEST', msg = 'Malformed request', details?: unknown) =>
  new ApiError(400, code, msg, details);
export const conflict = (code: string, msg: string) => new ApiError(409, code, msg);
export const tooMany = (retryAfterSec: number) =>
  new ApiError(429, 'RATE_LIMITED', 'Too many requests', { retry_after: retryAfterSec });
