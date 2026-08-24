/** Doctor-only detection result for the retired primary device identity JSON. */
export type LegacyDeviceIdentityDetection = {
  sourcePath: string;
  claimPath: string;
  nativeClaimPath: string;
  hasLegacy: boolean;
  hasInvalidCanonical: boolean;
};
