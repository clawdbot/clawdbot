type SecretStoreValidationCode =
  | "SECRET_STORE_INVALID_NAME"
  | "SECRET_STORE_INVALID_ALLOWED_HOST"
  | "SECRET_STORE_VALUE_TOO_LARGE"
  | "SECRET_STORE_VALUE_EMPTY";

export class SecretStoreValidationError extends Error {
  constructor(
    readonly code: SecretStoreValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "SecretStoreValidationError";
  }
}

export const SECRET_STORE_VALUE_MAX_BYTES = 64 * 1024;
export const SECRET_STORE_ALLOWED_HOSTS_MAX = 128;
