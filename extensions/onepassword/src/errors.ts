export type OnePasswordErrorCode =
  | "TOKEN_MISSING"
  | "OP_NOT_FOUND"
  | "ITEM_NOT_FOUND"
  | "FIELD_NOT_FOUND"
  | "RATE_LIMITED"
  | "AUTH_FAILED"
  | "TIMEOUT"
  | "OP_ERROR";

export class OnePasswordError extends Error {
  readonly code: OnePasswordErrorCode;

  constructor(code: OnePasswordErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OnePasswordError";
    this.code = code;
  }
}
