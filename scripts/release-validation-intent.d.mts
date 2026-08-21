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

export const RELEASE_VALIDATION_INTENTS: Readonly<
  Record<ReleaseValidationIntent, Readonly<Omit<ReleaseValidationIntentPolicy, "intent">>>
>;

export function resolveReleaseValidationIntent(
  intent: ReleaseValidationIntent | string,
  assertions?: {
    profile?: ReleaseValidationProfile | string;
    soak?: boolean;
  },
): ReleaseValidationIntentPolicy;

export function releaseValidationIntentForPurpose(
  purpose: ReleaseValidationPurpose | string,
  requestedIntent?: ReleaseValidationIntent | string,
): ReleaseValidationIntent;
