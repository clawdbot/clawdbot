/** Converts registry/catalog models into printable model-list rows. */
import { modelKey } from "../../agents/model-ref-shared.js";
import { isLocalBaseUrl } from "./list.local-url.js";
import type { ModelRow } from "./list.types.js";

/** Minimal model shape needed to render a model-list row. */
export type ListRowModel = {
  id: string;
  name: string;
  provider: string;
  input: Array<"text" | "image" | "document">;
  baseUrl?: string;
  contextWindow?: number | null;
  contextTokens?: number | null;
};

/** Provider-auth predicate used when model-level availability is unavailable. */
export type ModelAuthAvailabilityResolver = (provider: string) => boolean;

/** Builds a display row, preserving configured tags and alias metadata. */
export function toModelRow(params: {
  model?: ListRowModel;
  key: string;
  tags: string[];
  aliases?: string[];
  availableKeys?: Set<string>;
  allowProviderAvailabilityFallback?: boolean;
  hasAuthForProvider?: ModelAuthAvailabilityResolver;
}): ModelRow {
  const {
    model,
    key,
    tags,
    aliases = [],
    availableKeys,
    allowProviderAvailabilityFallback = false,
  } = params;
  if (!model) {
    return {
      key,
      name: key,
      input: "-",
      contextWindow: null,
      local: null,
      available: null,
      tags: [...tags, "missing"],
      missing: true,
    };
  }

  const input = model.input.join("+") || "text";
  const local = isLocalBaseUrl(model.baseUrl ?? "");
  const modelIsAvailable = availableKeys?.has(modelKey(model.provider, model.id)) ?? false;
  // Prefer model-level registry availability when present.
  // Fall back to provider-level auth heuristics only if registry availability isn't available,
  // or if the caller marks this as a synthetic/forward-compat model that won't appear in getAvailable().
  const available =
    availableKeys !== undefined && !allowProviderAvailabilityFallback
      ? modelIsAvailable
      : modelIsAvailable || (params.hasAuthForProvider?.(model.provider) ?? false);
  const aliasTags = aliases.length > 0 ? [`alias:${aliases.join(",")}`] : [];
  const mergedTags = new Set(tags);
  if (aliasTags.length > 0) {
    for (const tag of mergedTags) {
      if (tag === "alias" || tag.startsWith("alias:")) {
        mergedTags.delete(tag);
      }
    }
    for (const tag of aliasTags) {
      mergedTags.add(tag);
    }
  }

  return {
    key,
    name: model.name || model.id,
    input,
    contextWindow: model.contextWindow ?? null,
    ...(typeof model.contextTokens === "number" ? { contextTokens: model.contextTokens } : {}),
    local,
    available,
    tags: Array.from(mergedTags),
    missing: false,
  };
}
