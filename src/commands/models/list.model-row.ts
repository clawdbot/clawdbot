/** Converts registry/catalog models into printable model-list rows. */
import { modelKey } from "../../agents/model-ref-shared.js";
import { isLocalBaseUrl } from "./list.local-url.js";
import type { ModelRow } from "./list.types.js";

/** Minimal model shape needed to render a model-list row. */
export type ListRowModel = {
  id: string;
  name: string;
  provider: string;
  api?: string | null;
  input?: Array<"text" | "image" | "document">;
  baseUrl?: string;
  contextWindow?: number | null;
  contextTokens?: number | null;
};

/** Builds a display row, preserving configured tags and alias metadata. */
export function toModelRow(params: {
  model?: ListRowModel;
  key: string;
  tags: string[];
  aliases?: string[];
  availableKeys?: Set<string>;
  authAvailability: boolean | undefined;
  authAvailabilityAuthoritative?: boolean;
}): ModelRow {
  const {
    model,
    key,
    tags,
    aliases = [],
    availableKeys,
    authAvailability,
    authAvailabilityAuthoritative = false,
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

  const input = model.input?.join("+") || "-";
  const local = isLocalBaseUrl(model.baseUrl ?? "");
  const modelIsAvailable =
    local || (availableKeys?.has(modelKey(model.provider, model.id)) ?? false);
  // Registry model availability remains authoritative unless the row is outside
  // that inventory or provider-owned route facts select a physical auth route.
  const available = authAvailabilityAuthoritative
    ? (authAvailability ?? null)
    : availableKeys !== undefined
      ? modelIsAvailable
      : (authAvailability ?? (modelIsAvailable ? true : null));
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
