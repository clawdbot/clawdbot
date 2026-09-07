// Loads the bundled, presentation-only onboarding install catalog.
import recommendedToolInstalls from "../../scripts/lib/recommended-tool-installs.json" with { type: "json" };
import { isRecord } from "../utils.js";
import { normalizeSetupPresentationHttpsUrl } from "./setup-presentation-url.js";

export type SetupRecommendedInstall = {
  id: string;
  brandId?: string;
  label: string;
  hint: string;
  website: string;
  icon: string;
};

export function listRecommendedToolInstalls(): SetupRecommendedInstall[] {
  const entries = (recommendedToolInstalls as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    return [];
  }
  const seenIds = new Set<string>();
  const installs: SetupRecommendedInstall[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const brandId = typeof entry.brandId === "string" ? entry.brandId.trim() : "";
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    const hint = typeof entry.hint === "string" ? entry.hint.trim() : "";
    const website = normalizeSetupPresentationHttpsUrl(entry.website);
    const icon = normalizeSetupPresentationHttpsUrl(entry.icon);
    if (!id || seenIds.has(id) || !label || !hint || !website || !icon) {
      continue;
    }
    seenIds.add(id);
    installs.push({ id, ...(brandId ? { brandId } : {}), label, hint, website, icon });
  }
  return installs;
}
