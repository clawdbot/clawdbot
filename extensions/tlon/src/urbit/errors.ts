export type UrbitErrorCode =
  | "invalid_url"
  | "http_error"
  | "auth_failed"
  | "missing_cookie"
  | "channel_not_open";

export class UrbitError extends Error {
  readonly code: UrbitErrorCode;

  constructor(code: UrbitErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UrbitError";
    this.code = code;
  }
}

export class UrbitUrlError extends UrbitError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("invalid_url", message, options);
    this.name = "UrbitUrlError";
  }
}

export class UrbitHttpError extends UrbitError {
  readonly status: number;
  readonly operation: string;
  readonly bodyText?: string;

  constructor(params: { operation: string; status: number; bodyText?: string; cause?: unknown }) {
    const suffix = params.bodyText ? ` - ${params.bodyText}` : "";
    super("http_error", `${params.operation} failed: ${params.status}${suffix}`, {
      cause: params.cause,
    });
    this.name = "UrbitHttpError";
    this.status = params.status;
    this.operation = params.operation;
    this.bodyText = params.bodyText;
  }
}

export class UrbitAuthError extends UrbitError {
  constructor(
    code: "auth_failed" | "missing_cookie",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(code, message, options);
    this.name = "UrbitAuthError";
  }
}
