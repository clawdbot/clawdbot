// Loads the bundled, presentation-only onboarding install catalog.
import recommendedToolInstalls from "../../scripts/lib/recommended-tool-installs.json" with { type: "json" };
import { isRecord } from "../utils.js";

export type SetupRecommendedInstall = {
  id: string;
  label: string;
  hint: string;
  website: string;
  icon: string;
};

function normalizeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const normalized = value.trim();
  try {
    const url = new URL(normalized);
    const canonical = url.toString();
    return url.protocol === "https:" &&
      url.hostname &&
      !url.username &&
      !url.password &&
      canonical.length <= 2048
      ? canonical
      : undefined;
  } catch {
    return undefined;
  }
}

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
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    const hint = typeof entry.hint === "string" ? entry.hint.trim() : "";
    const website = normalizeHttpsUrl(entry.website);
    const icon = normalizeHttpsUrl(entry.icon);
    if (!id || seenIds.has(id) || !label || !hint || !website || !icon) {
      continue;
    }
    seenIds.add(id);
    installs.push({ id, label, hint, website, icon });
  }
  return installs;
}
