export type ProviderCatalogOutcome = {
  provider: string;
  /** Auth profile tested by discovery; omission means a profile-less credential. */
  profileId?: string;
  status: "ready" | "auth-rejected" | "unavailable";
};
