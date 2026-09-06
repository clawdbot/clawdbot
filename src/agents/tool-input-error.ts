// Only host construction records trust; error names and prototypes are forgeable.
const trustedToolInputErrors = new WeakSet<object>();

export class ToolInputError extends Error {
  readonly status: number = 400;

  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
    trustedToolInputErrors.add(this);
  }
}

export class ToolAuthorizationError extends ToolInputError {
  override readonly status = 403;

  constructor(message: string) {
    super(message);
    this.name = "ToolAuthorizationError";
  }
}

export function isTrustedToolInputError(error: unknown): boolean {
  return typeof error === "object" && error !== null && trustedToolInputErrors.has(error);
}
