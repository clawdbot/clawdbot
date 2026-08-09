/**
 * Thrown when media exceeds the caller-provided byte cap. Message text matches
 * the previous plain Error so existing matchers keep working; the class lets
 * owners (e.g. the image tool request budget) distinguish an expected cap
 * rejection from genuine load failures. Kept in its own module so lazy-boundary
 * consumers can import the type without statically pulling in web-media.
 */
export class MediaSizeCapExceededError extends Error {
  readonly capBytes: number;

  constructor(message: string, params: { capBytes: number; cause?: unknown }) {
    super(message, params.cause !== undefined ? { cause: params.cause } : undefined);
    this.name = "MediaSizeCapExceededError";
    this.capBytes = params.capBytes;
  }
}
