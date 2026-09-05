export type ReleaseValidationIntent =
  | "release-beta"
  | "release-stable"
  | "main-daily"
  | "main-weekly"
  | "diagnostic-full";

export type ReleaseValidationProfile = "beta" | "stable" | "full";

export type ReleaseValidationPurpose =
  | "beta-publish"
  | "stable-publish"
  | "diagnostic"
  | "postpublish-confidence"
  | "main-qualification";

export type ReleaseValidationIntentPolicy = {
  intent: ReleaseValidationIntent;
  profile: ReleaseValidationProfile;
  publishable: boolean;
  soak: boolean;
};

export function resolveReleaseValidationIntent(
  intent: string,
  assertions?: {
    profile?: string;
    soak?: boolean;
  },
): ReleaseValidationIntentPolicy;

export function releaseValidationIntentForPurpose(
  purpose: string,
  requestedIntent?: string,
): ReleaseValidationIntent;
