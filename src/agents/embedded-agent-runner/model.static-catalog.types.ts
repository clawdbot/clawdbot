import type { planManifestModelCatalogRows } from "../../model-catalog/manifest-planner.js";

export type BundledStaticCatalogState = {
  plugins: Parameters<typeof planManifestModelCatalogRows>[0]["registry"]["plugins"][number][];
  plans: Map<string, ReturnType<typeof planManifestModelCatalogRows>>;
};
