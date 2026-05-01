import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import type {
  MediaUnderstandingConfig,
  MediaUnderstandingModelConfig,
  MediaUnderstandingScopeConfig,
} from "../config/types.tools.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_CHARS_BY_CAPABILITY,
  DEFAULT_MEDIA_CONCURRENCY,
  DEFAULT_PROMPT,
} from "./defaults.constants.js";
import { resolveEffectiveMediaEntryCapabilities } from "./entry-capabilities.js";
import { normalizeMediaProviderId } from "./provider-id.js";
import { normalizeMediaUnderstandingChatType, resolveMediaUnderstandingScope } from "./scope.js";
import type { MediaUnderstandingCapability } from "./types.js";

export function resolveTimeoutMs(seconds: number | undefined, fallbackSeconds: number): number {
  const value = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : fallbackSeconds;
  return Math.max(1000, Math.floor(value * 1000));
}

export function resolvePrompt(
  capability: MediaUnderstandingCapability,
  prompt?: string,
  maxChars?: number,
): string {
  const base = prompt?.trim() || DEFAULT_PROMPT[capability];
  if (!maxChars || capability === "audio") {
    return base;
  }
  return `${base} Respond in at most ${maxChars} characters.`;
}

export function resolveMaxChars(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
  cfg: OpenClawConfig;
  config?: MediaUnderstandingConfig;
}): number | undefined {
  const { capability, entry, cfg } = params;
  const configured =
    entry.maxChars ?? params.config?.maxChars ?? cfg.tools?.media?.[capability]?.maxChars;
  if (typeof configured === "number") {
    return configured;
  }
  return DEFAULT_MAX_CHARS_BY_CAPABILITY[capability];
}

export function resolveMaxBytes(params: {
  capability: MediaUnderstandingCapability;
  entry: MediaUnderstandingModelConfig;
  cfg: OpenClawConfig;
  config?: MediaUnderstandingConfig;
}): number {
  const configured =
    params.entry.maxBytes ??
    params.config?.maxBytes ??
    params.cfg.tools?.media?.[params.capability]?.maxBytes;
  if (typeof configured === "number") {
    return configured;
  }
  return DEFAULT_MAX_BYTES[params.capability];
}

export function resolveScopeDecision(params: {
  scope?: MediaUnderstandingScopeConfig;
  ctx: MsgContext;
}): "allow" | "deny" {
  return resolveMediaUnderstandingScope({
    scope: params.scope,
    sessionKey: params.ctx.SessionKey,
    channel: params.ctx.Surface ?? params.ctx.Provider,
    chatType: normalizeMediaUnderstandingChatType(params.ctx.ChatType),
  });
}

export function resolveModelEntries(params: {
  cfg: OpenClawConfig;
  capability: MediaUnderstandingCapability;
  config?: MediaUnderstandingConfig;
  providerRegistry: Map<string, { capabilities?: MediaUnderstandingCapability[] }>;
}): MediaUnderstandingModelConfig[] {
  const { cfg, capability, config } = params;
  const sharedModels = cfg.tools?.media?.models ?? [];
  const entries = [
    ...(config?.models ?? []).map((entry) => ({ entry, source: "capability" as const })),
    ...sharedModels.map((entry) => ({ entry, source: "shared" as const })),
  ];
  if (entries.length === 0) {
    return [];
  }

  return entries
    .filter(({ entry, source }) => {
      const caps = resolveEffectiveMediaEntryCapabilities({
        entry,
        source,
        providerRegistry: params.providerRegistry,
      });
      if (!caps || caps.length === 0) {
        if (source === "shared") {
          if (shouldLogVerbose()) {
            logVerbose(
              `Skipping shared media model without capabilities: ${entry.provider ?? entry.command ?? "unknown"}`,
            );
          }
          return false;
        }
        return true;
      }
      return caps.includes(capability);
    })
    .map(({ entry }) => entry);
}

export function resolveConcurrency(cfg: OpenClawConfig): number {
  const configured = cfg.tools?.media?.concurrency;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return DEFAULT_MEDIA_CONCURRENCY;
}

export function resolveEntriesWithActiveFallback(params: {
  cfg: OpenClawConfig;
  capability: MediaUnderstandingCapability;
  config?: MediaUnderstandingConfig;
  providerRegistry: Map<string, { capabilities?: MediaUnderstandingCapability[] }>;
  activeModel?: { provider: string; model?: string };
}): MediaUnderstandingModelConfig[] {
  const entries = resolveModelEntries({
    cfg: params.cfg,
    capability: params.capability,
    config: params.config,
    providerRegistry: params.providerRegistry,
  });
  if (entries.length > 0) {
    return entries;
  }
  if (params.config?.enabled !== true) {
    return entries;
  }
  const activeProviderRaw = params.activeModel?.provider?.trim();
  if (!activeProviderRaw) {
    return entries;
  }
  const activeProvider = normalizeMediaProviderId(activeProviderRaw);
  if (!activeProvider) {
    return entries;
  }
  const capabilities = params.providerRegistry.get(activeProvider)?.capabilities;
  if (!capabilities || !capabilities.includes(params.capability)) {
    return entries;
  }
  return [
    {
      type: "provider",
      provider: activeProvider,
      model: params.activeModel?.model,
    },
  ];
}
