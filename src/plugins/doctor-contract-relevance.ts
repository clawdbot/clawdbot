import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { isChannelConfigMetadataKey } from "../channels/config-metadata.js";

function hasLegacyElevenLabsTalkFields(raw: unknown): boolean {
  const talk = asNullableRecord(asNullableRecord(raw)?.talk);
  if (!talk) {
    return false;
  }
  return ["voiceId", "voiceAliases", "modelId", "outputFormat", "apiKey"].some((key) =>
    Object.hasOwn(talk, key),
  );
}

function collectMediaProviderIds(root: Record<string, unknown>, ids: Set<string>): void {
  const media = asNullableRecord(asNullableRecord(root.tools)?.media);
  if (!media) {
    return;
  }
  // Keep legacy lists visible until the doctor migration window closes so
  // provider-owned repairs can run in the same pass as core consolidation.
  const modelLists = [
    media.models,
    asNullableRecord(media.audio)?.models,
    asNullableRecord(media.image)?.models,
    asNullableRecord(media.video)?.models,
  ];
  for (const models of modelLists) {
    if (!Array.isArray(models)) {
      continue;
    }
    for (const model of models) {
      const provider = asNullableRecord(model)?.provider;
      if (typeof provider === "string" && provider.trim()) {
        ids.add(normalizeProviderId(provider));
      }
    }
  }
}

function collectConfiguredModelProviderIds(params: {
  root: Record<string, unknown>;
  ids: Set<string>;
}): void {
  const addRef = (value: unknown) => {
    const parsed = typeof value === "string" ? parseProviderModelRef(value) : null;
    if (parsed) {
      params.ids.add(normalizeProviderId(parsed.provider));
    }
  };
  for (const ref of collectConfiguredModelRefs(params.root)) {
    addRef(ref.value);
  }
  const collectAgentPolicy = (value: unknown) => {
    const allow = asNullableRecord(asNullableRecord(value)?.modelPolicy)?.allow;
    if (Array.isArray(allow)) {
      allow.forEach(addRef);
    }
  };
  const agents = asNullableRecord(params.root.agents) ?? {};
  collectAgentPolicy(agents.defaults);
  if (Object.hasOwn(agents, "entries")) {
    const entries = asNullableRecord(agents.entries);
    if (entries) {
      Object.values(entries).forEach(collectAgentPolicy);
    }
  } else if (Array.isArray(agents.list)) {
    agents.list.forEach(collectAgentPolicy);
  }
}

export function collectRelevantDoctorPluginIds(raw: unknown): string[] {
  const ids = new Set<string>();
  const root = asNullableRecord(raw);
  if (!root) {
    return [];
  }

  const channels = asNullableRecord(root.channels);
  if (channels) {
    for (const rawChannelId of Object.keys(channels)) {
      const channelId = rawChannelId.trim();
      if (channelId && !isChannelConfigMetadataKey(channelId)) {
        ids.add(channelId);
      }
    }
  }

  const pluginsEntries = asNullableRecord(asNullableRecord(root.plugins)?.entries);
  if (pluginsEntries) {
    for (const pluginId of Object.keys(pluginsEntries)) {
      ids.add(pluginId);
    }
  }

  const modelProviders = asNullableRecord(asNullableRecord(root.models)?.providers);
  if (modelProviders) {
    for (const providerId of Object.keys(modelProviders)) {
      ids.add(providerId);
    }
  }

  collectMediaProviderIds(root, ids);
  collectConfiguredModelProviderIds({ root, ids });

  if (hasLegacyElevenLabsTalkFields(root)) {
    ids.add("elevenlabs");
  }

  return [...ids].toSorted();
}

export function collectRelevantDoctorPluginIdsForTouchedPaths(params: {
  raw: unknown;
  touchedPaths: ReadonlyArray<ReadonlyArray<string>>;
}): string[] {
  const root = asNullableRecord(params.raw);
  if (!root) {
    return [];
  }

  const ids = new Set<string>();
  collectConfiguredModelProviderIds({ root, ids });
  for (const touchedPath of params.touchedPaths) {
    const [first, second, third] = touchedPath;
    if (first === "channels") {
      if (!second) {
        return collectRelevantDoctorPluginIds(params.raw);
      }
      const channelId = second.trim();
      if (channelId && !isChannelConfigMetadataKey(channelId)) {
        ids.add(channelId);
      }
      continue;
    }
    if (first === "plugins") {
      if (second !== "entries" || !third) {
        return collectRelevantDoctorPluginIds(params.raw);
      }
      ids.add(third);
      continue;
    }
    if (first === "models") {
      if (second !== "providers" || !third) {
        return collectRelevantDoctorPluginIds(params.raw);
      }
      ids.add(third);
      continue;
    }
    if (first === "tools" && second === "media") {
      collectMediaProviderIds(root, ids);
      continue;
    }
    if (first === "talk" && hasLegacyElevenLabsTalkFields(root)) {
      ids.add("elevenlabs");
    }
  }

  return [...ids].toSorted();
}
