export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function notFound(message: string): HttpError {
  return new HttpError(404, message, "NOT_FOUND");
}

export function conflict(message: string, details?: unknown): HttpError {
  return new HttpError(409, message, "CONFLICT", details);
}
