export type ProviderCatalogOutcome = {
  provider: string;
  status: "ready" | "auth-rejected" | "unavailable";
};
