// Media store runtime facade loads filesystem-safe store implementation.
import "../infra/fs-safe-defaults.js";
import {
  FsSafeError,
  openLocalFileSafely as openLocalFileSafelyImpl,
  readLocalFileSafely as readLocalFileSafelyImpl,
  type FsSafeErrorCode,
} from "../infra/fs-safe.js";

/** Minimal fs-safe error shape consumed by media-store source-copy failures. */
export type FsSafeLikeError = {
  code: FsSafeErrorCode;
  message: string;
};

/** fs-safe local file reader re-exported for media-store test/runtime injection. */
export const readLocalFileSafely = readLocalFileSafelyImpl;

/** fs-safe local file opener re-exported for bounded media MIME sniffing. */
export const openLocalFileSafely = openLocalFileSafelyImpl;

/** Narrows fs-safe failures without exposing the full infra error class to store callers. */
export function isFsSafeError(error: unknown): error is FsSafeLikeError {
  return error instanceof FsSafeError;
}
