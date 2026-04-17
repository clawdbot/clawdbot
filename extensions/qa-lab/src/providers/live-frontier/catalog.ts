export const QA_FRONTIER_PROVIDER_IDS = ["anthropic", "google", "openai"] as const;
export const QA_FRONTIER_CATALOG_PRIMARY_MODEL = "openai/gpt-5.4";
export const QA_FRONTIER_CATALOG_ALTERNATE_MODEL = "anthropic/claude-sonnet-4-6";

export function isPreferredQaLiveFrontierCatalogModel(modelRef: string) {
  return modelRef === QA_FRONTIER_CATALOG_PRIMARY_MODEL;
}
