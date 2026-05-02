const MATRIX_MEDIA_SIZE_LIMIT_ERROR_MESSAGE = "Matrix media exceeds configured size limit";

export class MatrixMediaSizeLimitError extends Error {
  readonly code = "MATRIX_MEDIA_SIZE_LIMIT" as const;

  constructor(message = MATRIX_MEDIA_SIZE_LIMIT_ERROR_MESSAGE, options?: ErrorOptions) {
    super(message, options);
    this.name = "MatrixMediaSizeLimitError";
  }
}

export function isMatrixMediaSizeLimitError(err: unknown): err is MatrixMediaSizeLimitError {
  if (err instanceof MatrixMediaSizeLimitError) {
    return true;
  }
  if (!(err instanceof Error) || err.cause === undefined) {
    return false;
  }
  return isMatrixMediaSizeLimitError(err.cause);
}
