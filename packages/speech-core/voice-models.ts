// Voice model catalog helpers shared by TTS and realtime voice plugins.
export type VoiceModelCapability = "tts" | "realtime_transcription" | "realtime_voice";

/** Capability flags advertised by a voice model catalog entry. */
export type VoiceModelCapabilities = Partial<Record<VoiceModelCapability, true>>;

/** Provider/model override parsed from config. */
export type VoiceModelRef = {
  provider: string;
  model: string;
  timeoutMs?: number;
};

/** Static provider metadata used to validate configured voice model refs. */
export type VoiceModelProvider = {
  id: string;
  aliases?: readonly string[];
  label?: string;
  defaultModel?: string | null;
  models?: readonly string[];
};

/** Synthesized voice model catalog row exposed to provider/model selection. */
export type VoiceModelCatalogEntry = {
  kind: "voice";
  provider: string;
  model: string;
  source: "static";
  capabilities: VoiceModelCapabilities;
  label?: string;
  default?: boolean;
  modes?: readonly string[];
};

/** Ordered provider candidate, optionally with a concrete voice model override. */
export type VoiceProviderCandidate = {
  provider: string;
  voiceModel?: VoiceModelRef;
};

type VoiceModelConfig =
  | string
  | {
      primary?: unknown;
      fallbacks?: unknown;
      timeoutMs?: unknown;
    };

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeLowercaseString(value: unknown): string | undefined {
  return normalizeString(value)?.toLowerCase();
}

function normalizeTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function parseVoiceModelRef(value: unknown): VoiceModelRef | undefined {
  const raw = normalizeString(value);
  if (!raw) {
    return undefined;
  }
  const slashIndex = raw.indexOf("/");
  if (slashIndex <= 0 || slashIndex === raw.length - 1) {
    return undefined;
  }
  const provider = normalizeLowercaseString(raw.slice(0, slashIndex));
  const model = normalizeString(raw.slice(slashIndex + 1));
  return provider && model ? { provider, model } : undefined;
}

function sameProvider(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeLowercaseString(left);
  return Boolean(normalizedLeft && normalizedLeft === normalizeLowercaseString(right));
}

/** Match provider ids case-insensitively across canonical id and aliases. */
export function providerMatchesId(provider: VoiceModelProvider, providerId?: string): boolean {
  return (
    sameProvider(provider.id, providerId) ||
    (provider.aliases ?? []).some((alias) => sameProvider(alias, providerId))
  );
}

/** Find the provider metadata for a configured provider id or alias. */
export function findVoiceModelProvider<T extends VoiceModelProvider>(params: {
  providers: readonly T[];
  providerId?: string;
}): T | undefined {
  return params.providers.find((provider) => providerMatchesId(provider, params.providerId));
}

/** Return true when a provider advertises the requested model. */
export function voiceProviderSupportsModel(
  provider: VoiceModelProvider | undefined,
  model: unknown,
): boolean {
  if (!provider) {
    return false;
  }
  const normalizedModel = normalizeString(model);
  return [provider.defaultModel, ...(provider.models ?? [])].some(
    (candidate) => normalizeString(candidate) === normalizedModel,
  );
}

/** Parse primary/fallback voice model refs from config. */
export function resolveVoiceModelRefs(config: unknown): VoiceModelRef[] {
  const voiceModel = config as VoiceModelConfig | undefined;
  if (typeof voiceModel === "string") {
    const parsed = parseVoiceModelRef(voiceModel);
    return parsed ? [parsed] : [];
  }
  if (typeof voiceModel !== "object" || voiceModel === null || Array.isArray(voiceModel)) {
    return [];
  }
  const timeoutMs = normalizeTimeoutMs(voiceModel.timeoutMs);
  const refs: VoiceModelRef[] = [];
  const addRef = (value: unknown) => {
    const parsed = parseVoiceModelRef(value);
    if (parsed) {
      refs.push({ ...parsed, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    }
  };
  addRef(voiceModel.primary);
  if (Array.isArray(voiceModel.fallbacks)) {
    for (const fallback of voiceModel.fallbacks) {
      addRef(fallback);
    }
  }
  return refs;
}

/** Resolve configured voice model refs that are supported by known providers. */
export function resolveSupportedVoiceModelRefs(params: {
  config: unknown;
  providers: readonly VoiceModelProvider[];
  providerId?: string;
}): VoiceModelRef[] {
  return resolveVoiceModelRefs(params.config).flatMap((ref) => {
    const provider = findVoiceModelProvider({
      providers: params.providers,
      providerId: ref.provider,
    });
    if (!provider || (params.providerId && !providerMatchesId(provider, params.providerId))) {
      return [];
    }
    return voiceProviderSupportsModel(provider, ref.model)
      ? [{ ...ref, provider: provider.id }]
      : [];
  });
}

/** Build ordered provider candidates from primary provider plus voice-model fallbacks. */
export function resolveVoiceProviderCandidates(params: {
  primaryProvider: string;
  providers: readonly VoiceModelProvider[];
  voiceModelConfig?: unknown;
}): VoiceProviderCandidate[] {
  const primary =
    findVoiceModelProvider({ providers: params.providers, providerId: params.primaryProvider })
      ?.id ?? params.primaryProvider;
  const candidates: VoiceProviderCandidate[] = [];
  const seenProviders = new Set<string>();
  const addCandidate = (candidate: VoiceProviderCandidate) => {
    candidates.push(candidate);
    seenProviders.add(candidate.provider);
  };
  const refs = resolveSupportedVoiceModelRefs({
    config: params.voiceModelConfig,
    providers: params.providers,
  });
  const primaryRefs = refs.filter((ref) => ref.provider === primary);
  for (const voiceModel of primaryRefs) {
    addCandidate({ provider: primary, voiceModel });
  }
  if (primaryRefs.length === 0) {
    addCandidate({ provider: primary });
  }
  for (const voiceModel of refs) {
    if (voiceModel.provider !== primary) {
      addCandidate({ provider: voiceModel.provider, voiceModel });
    }
  }
  for (const provider of params.providers) {
    if (!seenProviders.has(provider.id)) {
      addCandidate({ provider: provider.id });
    }
  }
  return candidates;
}

/** Resolve only the primary provider candidate for direct synthesis paths. */
export function resolvePrimaryVoiceProviderCandidate(params: {
  primaryProvider: string;
  providers: readonly VoiceModelProvider[];
  voiceModelConfig?: unknown;
}): VoiceProviderCandidate {
  const provider =
    findVoiceModelProvider({ providers: params.providers, providerId: params.primaryProvider })
      ?.id ?? params.primaryProvider;
  const voiceModel = resolveSupportedVoiceModelRefs({
    config: params.voiceModelConfig,
    providers: params.providers,
    providerId: provider,
  })[0];
  return voiceModel ? { provider, voiceModel } : { provider };
}

/** Read provider config by configured id, canonical id, or alias. */
export function getVoiceProviderConfig<TConfig extends Record<string, unknown>>(params: {
  providerConfigs: Record<string, TConfig | undefined>;
  provider: VoiceModelProvider;
  configuredProviderId?: string;
}): TConfig {
  const candidates = [
    normalizeString(params.configuredProviderId),
    params.provider.id,
    ...(params.provider.aliases ?? []),
  ].filter((key): key is string => Boolean(key));
  const configuredKeys = Object.keys(params.providerConfigs);
  for (const candidate of candidates) {
    if (Object.hasOwn(params.providerConfigs, candidate)) {
      return params.providerConfigs[candidate] ?? ({} as TConfig);
    }
    const normalizedCandidate = normalizeLowercaseString(candidate);
    const matchingKey = configuredKeys.find(
      (key) => normalizeLowercaseString(key) === normalizedCandidate,
    );
    if (matchingKey) {
      return params.providerConfigs[matchingKey] ?? ({} as TConfig);
    }
  }
  return {} as TConfig;
}

/** Convert provider metadata into static voice catalog entries. */
export function synthesizeVoiceModelCatalogEntries(params: {
  provider: VoiceModelProvider;
  capabilities: VoiceModelCapabilities;
  modes?: readonly string[];
}): VoiceModelCatalogEntry[] {
  const seen = new Set<string>();
  const models = [params.provider.defaultModel, ...(params.provider.models ?? [])].flatMap(
    (entry) => {
      const model = normalizeString(entry);
      if (!model || seen.has(model)) {
        return [];
      }
      seen.add(model);
      return [model];
    },
  );
  return models.map((model) => {
    const entry: VoiceModelCatalogEntry = {
      kind: "voice",
      provider: params.provider.id,
      model,
      source: "static",
      capabilities: params.capabilities,
    };
    if (params.provider.label) {
      entry.label = params.provider.label;
    }
    if (model === params.provider.defaultModel) {
      entry.default = true;
    }
    if (params.modes) {
      entry.modes = params.modes;
    }
    return entry;
  });
}
