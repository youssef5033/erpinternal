/** Application errors with user-safe messages. Server actions translate these to form state. */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fieldErrors?: Record<string, string>;
  constructor(message: string, opts: { code?: string; status?: number; fieldErrors?: Record<string, string> } = {}) {
    super(message);
    this.name = "AppError";
    this.code = opts.code ?? "app_error";
    this.status = opts.status ?? 400;
    this.fieldErrors = opts.fieldErrors;
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to do that.") {
    super(message, { code: "forbidden", status: 403 });
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(what = "Record") {
    super(`${what} not found.`, { code: "not_found", status: 404 });
    this.name = "NotFoundError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string, fieldErrors?: Record<string, string>) {
    super(message, { code: "validation", status: 422, fieldErrors });
    this.name = "ValidationError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, { code: "conflict", status: 409 });
    this.name = "ConflictError";
  }
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ValidationError(message);
}

/** Postgres unique violation */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = (err as { cause?: { code?: string; constraint?: string }; code?: string; constraint?: string }) ?? {};
  const code = e.code ?? e.cause?.code;
  const c = e.constraint ?? e.cause?.constraint;
  return code === "23505" && (!constraint || c === constraint);
}
