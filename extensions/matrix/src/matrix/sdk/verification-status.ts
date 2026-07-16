import type { MatrixDeviceVerificationStatusLike } from "./types.js";

export function isMatrixDeviceLocallyVerified(
  status: MatrixDeviceVerificationStatusLike | null | undefined,
): boolean {
  return status?.localVerified === true;
}

export function isMatrixDeviceOwnerVerified(
  status: MatrixDeviceVerificationStatusLike | null | undefined,
): boolean {
  return status?.crossSigningVerified === true || status?.signedByOwner === true;
}

export function isMatrixDeviceVerifiedInCurrentClient(
  status: MatrixDeviceVerificationStatusLike | null | undefined,
): boolean {
  return (
    status?.isVerified?.() === true ||
    isMatrixDeviceLocallyVerified(status) ||
    isMatrixDeviceOwnerVerified(status)
  );
}
