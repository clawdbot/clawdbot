import fs from "node:fs/promises";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveApiKeyForProvider } from "../../agents/model-auth.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { buildGatewayConnectionDetailsWithResolvers } from "../../gateway/connection-details.js";
import { isLoopbackHost } from "../../gateway/net.js";
import { canonicalizeSpeechProviderId, listSpeechProviders } from "../../tts/provider-registry.js";
import {
  getTtsProvider,
  getTtsPersona,
  listTtsPersonas,
  listSpeechVoices,
  resolveExplicitTtsOverrides,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  setTtsEnabled,
  setTtsPersona,
  setTtsProvider,
  textToSpeech,
} from "../../tts/tts.js";
import { getTtsCommandSecretTargetIds } from "../command-secret-targets.js";
import type { CapabilityEnvelope, CapabilityTransport } from "./metadata.js";
import {
  pinRuntimeConfigSnapshot,
  providerHasGenericConfig,
  resolveLocalCapabilityRuntimeConfig,
  resolveSelectedProviderFromModelRef,
} from "./shared.js";

export async function runTtsConvert(params: {
  text: string;
  channel?: string;
  provider?: string;
  modelId?: string;
  voiceId?: string;
  output?: string;
  transport: CapabilityTransport;
}) {
  if (params.transport === "gateway") {
    const gatewayConnection = buildGatewayConnectionDetailsWithResolvers({
      config: getRuntimeConfig(),
    });
    const result: {
      audioPath?: string;
      provider?: string;
      outputFormat?: string;
      voiceCompatible?: boolean;
    } = await callGateway({
      method: "tts.convert",
      params: {
        text: params.text,
        channel: params.channel,
        provider: normalizeOptionalString(params.provider),
        modelId: params.modelId,
        voiceId: params.voiceId,
      },
      timeoutMs: 120_000,
    });
    let outputPath = result.audioPath;
    if (params.output && result.audioPath) {
      const gatewayHost = new URL(gatewayConnection.url).hostname;
      if (!isLoopbackHost(gatewayHost)) {
        throw new Error(
          `--output is not supported for remote gateway TTS yet (gateway target: ${gatewayConnection.url}).`,
        );
      }
      const target = path.resolve(params.output);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(result.audioPath, target);
      outputPath = target;
    }
    return {
      ok: true,
      capability: "tts.convert",
      transport: "gateway" as const,
      provider: result.provider,
      attempts: [],
      outputs: [
        {
          path: outputPath,
          format: result.outputFormat,
          voiceCompatible: result.voiceCompatible,
        },
      ],
    } satisfies CapabilityEnvelope;
  }

  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: "infer tts convert",
    targetIds: getTtsCommandSecretTargetIds(),
  });
  const ttsProvider = resolveTtsProviderForAuthHydration({
    cfg,
    provider: params.provider,
    modelId: params.modelId,
    channelId: params.channel,
  });
  const effectiveCfg = await injectTtsAuthProfileApiKey({
    cfg,
    provider: ttsProvider,
    channelId: params.channel,
  });
  if (effectiveCfg !== cfg) {
    pinRuntimeConfigSnapshot(effectiveCfg);
  }
  const overrides = resolveExplicitTtsOverrides({
    cfg: effectiveCfg,
    provider: params.provider,
    modelId: params.modelId,
    voiceId: params.voiceId,
    channelId: params.channel,
  });
  const hasExplicitSelection = Boolean(
    overrides.provider ||
    normalizeOptionalString(params.modelId) ||
    normalizeOptionalString(params.voiceId),
  );
  const result = await textToSpeech({
    text: params.text,
    cfg: effectiveCfg,
    channel: params.channel,
    overrides,
    disableFallback: hasExplicitSelection,
  });
  if (!result.success || !result.audioPath) {
    throw new Error(result.error ?? "TTS conversion failed");
  }
  let outputPath = result.audioPath;
  if (params.output) {
    const target = path.resolve(params.output);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(result.audioPath, target);
    outputPath = target;
  }
  return {
    ok: true,
    capability: "tts.convert",
    transport: "local" as const,
    provider: result.provider,
    attempts: result.attempts ?? [],
    outputs: [
      {
        path: outputPath,
        format: result.outputFormat,
        voiceCompatible: result.voiceCompatible,
      },
    ],
  } satisfies CapabilityEnvelope;
}

function resolveTtsProviderForAuthHydration(params: {
  cfg: OpenClawConfig;
  provider?: string;
  modelId?: string;
  channelId?: string;
}): string | undefined {
  const explicitProvider =
    params.provider ?? resolveSelectedProviderFromModelRef(normalizeOptionalString(params.modelId));
  if (explicitProvider) {
    return explicitProvider;
  }
  const ttsConfig = resolveTtsConfig(params.cfg, { channelId: params.channelId });
  return getTtsProvider(ttsConfig, resolveTtsPrefsPath(ttsConfig));
}

async function injectTtsAuthProfileApiKey(params: {
  cfg: OpenClawConfig;
  provider?: string;
  channelId?: string;
}): Promise<OpenClawConfig> {
  if (!params.provider) {
    return params.cfg;
  }
  const providerId =
    canonicalizeSpeechProviderId(params.provider, params.cfg) ??
    normalizeLowercaseStringOrEmpty(params.provider);
  if (!providerId) {
    return params.cfg;
  }
  const effectiveTtsConfig = resolveTtsConfig(params.cfg, { channelId: params.channelId });
  if (resolvedTtsConfigHasProviderApiKey(effectiveTtsConfig, providerId)) {
    return params.cfg;
  }
  const existingProviderConfig = resolveExistingTtsProviderConfig({
    cfg: params.cfg,
    providerId,
    channelId: params.channelId,
  });
  if (ttsProviderConfigHasApiKey(existingProviderConfig?.value)) {
    return params.cfg;
  }
  const auth = await resolveApiKeyForProvider({
    provider: providerId,
    cfg: params.cfg,
    credentialPrecedence: "profile-first",
  }).catch(() => undefined);
  if (!auth?.apiKey || auth.mode !== "api-key") {
    return params.cfg;
  }
  if (existingProviderConfig?.scope === "channel") {
    const channels = { ...params.cfg.channels };
    const channel = channels[existingProviderConfig.channelKey];
    if (!isObjectRecord(channel)) {
      return params.cfg;
    }
    const nextChannel = {
      ...channel,
      tts: buildTtsConfigWithHydratedProvider({
        tts: channel.tts,
        existingProviderConfig,
        providerId,
        apiKey: auth.apiKey,
      }),
    };
    return {
      ...params.cfg,
      channels: {
        ...channels,
        [existingProviderConfig.channelKey]: nextChannel,
      },
    };
  }
  const messages = { ...params.cfg.messages };
  const nextTts = buildTtsConfigWithHydratedProvider({
    tts: messages.tts,
    existingProviderConfig,
    providerId,
    apiKey: auth.apiKey,
  });
  return {
    ...params.cfg,
    messages: {
      ...messages,
      tts: nextTts,
    },
  };
}

type TtsProviderConfigLocation = {
  container: "providers" | "direct";
  key: string;
  value: unknown;
};

type ExistingTtsProviderConfig =
  | (TtsProviderConfigLocation & {
      scope: "root";
      channelKey?: never;
    })
  | (TtsProviderConfigLocation & {
      scope: "channel";
      channelKey: string;
    });

function resolveExistingTtsProviderConfig(params: {
  cfg: OpenClawConfig;
  providerId: string;
  channelId?: string;
}): ExistingTtsProviderConfig | undefined {
  const channelTts = resolveChannelTtsConfigForAuthHydration(params);
  if (channelTts) {
    const channelProviderConfig = resolveExistingTtsProviderConfigInTts({
      cfg: params.cfg,
      tts: channelTts.tts,
      providerId: params.providerId,
    });
    if (channelProviderConfig) {
      return {
        ...channelProviderConfig,
        scope: "channel",
        channelKey: channelTts.channelKey,
      };
    }
  }
  const rootProviderConfig = resolveExistingTtsProviderConfigInTts({
    cfg: params.cfg,
    tts: params.cfg.messages?.tts,
    providerId: params.providerId,
  });
  return rootProviderConfig ? { ...rootProviderConfig, scope: "root" } : undefined;
}

function resolveExistingTtsProviderConfigInTts(params: {
  cfg: OpenClawConfig;
  tts: unknown;
  providerId: string;
}): TtsProviderConfigLocation | undefined {
  if (!isObjectRecord(params.tts)) {
    return undefined;
  }
  const providers = isObjectRecord(params.tts.providers) ? params.tts.providers : undefined;
  if (!providers) {
    return resolveDirectTtsProviderConfig(params);
  }
  const exact = providers[params.providerId];
  if (exact !== undefined) {
    return { container: "providers", key: params.providerId, value: exact };
  }
  for (const [key, value] of Object.entries(providers)) {
    const normalizedKey = normalizeLowercaseStringOrEmpty(
      canonicalizeSpeechProviderId(key, params.cfg) ?? key,
    );
    if (normalizedKey === params.providerId) {
      return { container: "providers", key, value };
    }
  }
  return resolveDirectTtsProviderConfig(params);
}

const TTS_CONFIG_RESERVED_KEYS = new Set([
  "auto",
  "enabled",
  "maxTextLength",
  "mode",
  "modelOverrides",
  "persona",
  "personas",
  "prefsPath",
  "provider",
  "providers",
  "summaryModel",
  "timeoutMs",
]);

function resolveDirectTtsProviderConfig(params: {
  cfg: OpenClawConfig;
  tts: unknown;
  providerId: string;
}): TtsProviderConfigLocation | undefined {
  if (!isObjectRecord(params.tts)) {
    return undefined;
  }
  for (const [key, value] of Object.entries(params.tts)) {
    if (TTS_CONFIG_RESERVED_KEYS.has(key)) {
      continue;
    }
    const normalizedKey = normalizeLowercaseStringOrEmpty(
      canonicalizeSpeechProviderId(key, params.cfg) ?? key,
    );
    if (normalizedKey === params.providerId) {
      return { container: "direct", key, value };
    }
  }
  return undefined;
}

function resolveChannelTtsConfigForAuthHydration(params: {
  cfg: OpenClawConfig;
  channelId?: string;
}): { channelKey: string; tts: unknown } | undefined {
  const channels = params.cfg.channels;
  const normalizedChannelId = normalizeOptionalString(params.channelId);
  if (!isObjectRecord(channels) || !normalizedChannelId) {
    return undefined;
  }
  const channelKey = Object.hasOwn(channels, normalizedChannelId)
    ? normalizedChannelId
    : Object.keys(channels).find(
        (candidate) =>
          normalizeLowercaseStringOrEmpty(candidate) ===
          normalizeLowercaseStringOrEmpty(normalizedChannelId),
      );
  const channel = channelKey ? channels[channelKey] : undefined;
  if (!channelKey || !isObjectRecord(channel)) {
    return undefined;
  }
  return { channelKey, tts: channel.tts };
}

function buildTtsConfigWithHydratedProvider(params: {
  tts: unknown;
  existingProviderConfig?: ExistingTtsProviderConfig;
  providerId: string;
  apiKey: string;
}): Record<string, unknown> {
  const tts = isObjectRecord(params.tts) ? { ...params.tts } : {};
  const providers = isObjectRecord(tts.providers) ? { ...tts.providers } : {};
  const providerConfigKey = params.existingProviderConfig?.key ?? params.providerId;
  const nextProviderConfig = {
    ...(isObjectRecord(params.existingProviderConfig?.value)
      ? params.existingProviderConfig.value
      : {}),
    apiKey: params.apiKey,
  };
  if (params.existingProviderConfig?.container === "direct") {
    tts[providerConfigKey] = nextProviderConfig;
  } else {
    providers[providerConfigKey] = nextProviderConfig;
    tts.providers = providers;
  }
  return tts;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function ttsProviderConfigHasApiKey(value: unknown): boolean {
  return isObjectRecord(value) && "apiKey" in value;
}

function resolvedTtsConfigHasProviderApiKey(config: unknown, providerId: string): boolean {
  if (!isObjectRecord(config) || !isObjectRecord(config.providerConfigs)) {
    return false;
  }
  return ttsProviderConfigHasApiKey(config.providerConfigs[providerId]);
}

export async function runTtsProviders(transport: CapabilityTransport) {
  const cfg = getRuntimeConfig();
  if (transport === "gateway") {
    const payload: {
      providers?: Array<Record<string, unknown>>;
      active?: string;
    } = await callGateway({
      method: "tts.providers",
      timeoutMs: 30_000,
    });
    return {
      ...payload,
      providers: (payload.providers ?? []).map((provider) => {
        const id = typeof provider.id === "string" ? provider.id : "";
        return Object.assign(
          {
            available: true,
            configured:
              typeof provider.configured === `boolean`
                ? provider.configured
                : providerHasGenericConfig({ cfg, providerId: id }),
            selected: Boolean(id && payload.active === id),
          },
          provider,
        );
      }),
    };
  }
  const config = resolveTtsConfig(cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const active = getTtsProvider(config, prefsPath);
  return {
    providers: listSpeechProviders(cfg).map((provider) => ({
      available: true,
      configured:
        active === provider.id || providerHasGenericConfig({ cfg, providerId: provider.id }),
      selected: active === provider.id,
      id: provider.id,
      name: provider.label,
      models: [...(provider.models ?? [])],
      voices: [...(provider.voices ?? [])],
    })),
    active,
  };
}

export async function runTtsPersonas(transport: CapabilityTransport) {
  if (transport === "gateway") {
    return await callGateway({
      method: "tts.personas",
      timeoutMs: 30_000,
    });
  }
  const cfg = getRuntimeConfig();
  const config = resolveTtsConfig(cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const active = getTtsPersona(config, prefsPath);
  return {
    active: active?.id ?? null,
    personas: listTtsPersonas(config).map((persona) => ({
      id: persona.id,
      label: persona.label,
      description: persona.description,
      provider: persona.provider,
      fallbackPolicy: persona.fallbackPolicy,
      providers: Object.keys(persona.providers ?? {}),
    })),
  };
}

export async function runTtsVoices(providerRaw?: string) {
  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: "infer tts voices",
    targetIds: getTtsCommandSecretTargetIds(),
  });
  const config = resolveTtsConfig(cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  const provider = normalizeOptionalString(providerRaw) || getTtsProvider(config, prefsPath);
  return await listSpeechVoices({
    provider,
    cfg,
    config,
  });
}

export async function runTtsStateMutation(params: {
  capability: "tts.enable" | "tts.disable" | "tts.set-provider" | "tts.set-persona";
  transport: CapabilityTransport;
  provider?: string;
  persona?: string | null;
}) {
  if (params.transport === "gateway") {
    const method =
      params.capability === "tts.enable"
        ? "tts.enable"
        : params.capability === "tts.disable"
          ? "tts.disable"
          : params.capability === "tts.set-provider"
            ? "tts.setProvider"
            : "tts.setPersona";
    const payload = await callGateway({
      method,
      params:
        params.capability === "tts.set-provider"
          ? { provider: params.provider }
          : params.capability === "tts.set-persona"
            ? { persona: params.persona ?? "off" }
            : undefined,
      timeoutMs: 30_000,
    });
    return payload;
  }

  const cfg = getRuntimeConfig();
  const config = resolveTtsConfig(cfg);
  const prefsPath = resolveTtsPrefsPath(config);
  if (params.capability === "tts.enable") {
    setTtsEnabled(prefsPath, true);
    return { enabled: true };
  }
  if (params.capability === "tts.disable") {
    setTtsEnabled(prefsPath, false);
    return { enabled: false };
  }
  if (params.capability === "tts.set-persona") {
    if (!params.persona) {
      setTtsPersona(prefsPath, null);
      return { persona: null };
    }
    const persona = listTtsPersonas(config).find(
      (entry) => entry.id === normalizeLowercaseStringOrEmpty(params.persona ?? ""),
    );
    if (!persona) {
      throw new Error(`Unknown TTS persona: ${params.persona}`);
    }
    setTtsPersona(prefsPath, persona.id);
    return { persona: persona.id };
  }
  if (!params.provider) {
    throw new Error("--provider is required");
  }
  const provider = canonicalizeSpeechProviderId(params.provider, cfg);
  if (!provider) {
    throw new Error(`Unknown speech provider: ${params.provider}`);
  }
  setTtsProvider(prefsPath, provider);
  return { provider };
}
