/** Model candidate normalization and catalog selection for auth probes. */
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeProviderId, parseModelRef } from "../../agents/model-selection.js";
import { DEFAULT_PROVIDER } from "./shared.js";

/** Groups configured model candidates by their requested provider identity. */
export function buildProbeCandidateMap(modelCandidates: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const raw of modelCandidates) {
    const parsed = parseModelRef(raw ?? "", DEFAULT_PROVIDER);
    if (!parsed) {
      continue;
    }
    const list = map.get(parsed.provider) ?? [];
    if (!list.includes(parsed.model)) {
      list.push(parsed.model);
    }
    map.set(parsed.provider, list);
  }
  return map;
}

function catalogProbePriority(provider: string, modelId: string): number {
  const id = modelId.trim().toLowerCase();
  if (provider !== "anthropic") {
    return 50;
  }
  if (/^claude-haiku-4-5-\d{8}$/.test(id)) {
    return 0;
  }
  if (id === "claude-haiku-4-5") {
    return 1;
  }
  if (id === "claude-sonnet-5" || id.startsWith("claude-sonnet-5-")) {
    return 2;
  }
  if (id === "claude-sonnet-4-6" || id.startsWith("claude-sonnet-4-6-")) {
    return 3;
  }
  if (id.startsWith("claude-sonnet-4-")) {
    return 4;
  }
  if (id.startsWith("claude-3-")) {
    return 100;
  }
  return 50;
}

/** Selects a requested-provider candidate before falling back to its catalog rows. */
export function selectProbeModel(params: {
  provider: string;
  candidates: Map<string, string[]>;
  catalog: Array<{ provider: string; id: string }>;
}): { provider: string; model: string } | null {
  const { provider, candidates, catalog } = params;
  const direct = candidates.get(provider);
  if (direct && direct.length > 0) {
    return { provider, model: expectDefined(direct[0], "direct entry at 0") };
  }
  const fromCatalog = catalog
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => normalizeProviderId(entry.provider) === provider)
    .toSorted((left, right) => {
      const priority =
        catalogProbePriority(provider, left.entry.id) -
        catalogProbePriority(provider, right.entry.id);
      return priority || left.index - right.index;
    })[0]?.entry;
  return fromCatalog ? { provider, model: fromCatalog.id } : null;
}
