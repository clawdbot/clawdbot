import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { modelKey } from "../../agents/model-ref-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isLocalBaseUrl } from "./list.local-url.js";
import type { ModelRow } from "./list.types.js";

export type ListRowModel = {
  id: string;
  name: string;
  provider: string;
  input: Array<"text" | "image">;
  baseUrl?: string;
  contextWindow?: number | null;
};

export type ModelAuthAvailabilityResolver = (params: {
  provider: string;
  cfg: OpenClawConfig;
  authStore: AuthProfileStore;
}) => boolean;

function authStoreHasProviderProfile(authStore: AuthProfileStore, provider: string): boolean {
  return Object.values(authStore.profiles ?? {}).some(
    (credential) => credential.provider === provider,
  );
}

export function toModelRow(params: {
  model?: ListRowModel;
  key: string;
  tags: string[];
  aliases?: string[];
  availableKeys?: Set<string>;
  cfg?: OpenClawConfig;
  authStore?: AuthProfileStore;
  allowProviderAvailabilityFallback?: boolean;
  hasAuthForProvider?: ModelAuthAvailabilityResolver;
}): ModelRow {
  const {
    model,
    key,
    tags,
    aliases = [],
    availableKeys,
    cfg,
    authStore,
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
      : modelIsAvailable ||
        (cfg && authStore
          ? (
              params.hasAuthForProvider ??
              ((input) => authStoreHasProviderProfile(input.authStore, input.provider))
            )({
              provider: model.provider,
              cfg,
              authStore,
            })
          : false);
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
    local,
    available,
    tags: Array.from(mergedTags),
    missing: false,
  };
}
