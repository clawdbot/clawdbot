import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  markReplyPayloadAsTtsSupplement,
  resolveSendableOutboundReplyParts,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { isVerbose, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  parseTtsDirectives,
  summarizeText,
  type SpeechVoiceOption,
} from "openclaw/plugin-sdk/speech-core";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { assertSpeechRuntimeAvailable, isSpeechRuntimeAvailable } from "./runtime-availability.js";
import { isCodeHeavySpeechText, normalizeSpeechText } from "./speech-text.js";
import {
  getResolvedSpeechProviderConfig,
  resolveSpeechProviderTimeoutMs,
  resolveTtsProvider,
} from "./tts-provider-resolution.js";
import {
  getTtsMaxLength,
  isSummarizationEnabled,
  resolveTtsConfig,
  resolveTtsRuntimeConfig,
  resolveTtsSettingsSnapshot,
  type ResolvedTtsConfig,
} from "./tts-settings.js";
import { textToSpeech } from "./tts-synthesis.js";
import type { TtsStatusEntry } from "./tts-types.js";

let lastTtsAttempt: TtsStatusEntry | undefined;

export function getLastTtsAttempt(): TtsStatusEntry | undefined {
  return lastTtsAttempt;
}

export function setLastTtsAttempt(entry: TtsStatusEntry | undefined): void {
  lastTtsAttempt = entry;
}

export async function listSpeechVoices(params: {
  provider: string;
  cfg?: OpenClawConfig;
  config?: ResolvedTtsConfig;
  apiKey?: string;
  baseUrl?: string;
}): Promise<SpeechVoiceOption[]> {
  assertSpeechRuntimeAvailable();
  const cfg = params.cfg ? resolveTtsRuntimeConfig(params.cfg) : undefined;
  const provider = canonicalizeSpeechProviderId(params.provider, cfg);
  if (!provider) {
    throw new Error("speech provider id is required");
  }
  const config = params.config ?? (cfg ? resolveTtsConfig(cfg) : undefined);
  if (!config) {
    throw new Error(`speech provider ${provider} requires cfg or resolved config`);
  }
  const resolvedProvider = getSpeechProvider(provider, cfg);
  if (!resolvedProvider) {
    throw new Error(`speech provider ${provider} is not registered`);
  }
  if (!resolvedProvider.listVoices) {
    throw new Error(`speech provider ${provider} does not support voice listing`);
  }
  const timeoutMs = resolveSpeechProviderTimeoutMs({
    config,
    provider: resolvedProvider,
  });
  return await resolvedProvider.listVoices({
    cfg,
    providerConfig: getResolvedSpeechProviderConfig(config, resolvedProvider.id, cfg),
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    timeoutMs,
  });
}

function hasLegacyFinalMediaDirective(text: string): boolean {
  return /(?:^|\n)\s*MEDIA\s*:/i.test(text);
}

export async function maybeApplyTtsToPayload(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  channel?: string;
  kind?: "tool" | "block" | "final";
  inboundAudio?: boolean;
  ttsAuto?: string;
  agentId?: string;
  accountId?: string;
}): Promise<ReplyPayload> {
  if (!isSpeechRuntimeAvailable()) {
    return params.payload;
  }
  if (params.payload.isCompactionNotice) {
    return params.payload;
  }
  const cfg = resolveTtsRuntimeConfig(params.cfg);
  const { autoMode, config, prefsPath } = resolveTtsSettingsSnapshot({
    cfg,
    sessionAuto: params.ttsAuto,
    agentId: params.agentId,
    channelId: params.channel,
    accountId: params.accountId,
  });
  if (autoMode === "off") {
    return params.payload;
  }
  const activeProvider = resolveTtsProvider(config, prefsPath);

  const reply = resolveSendableOutboundReplyParts(params.payload);
  const text = reply.text;
  const directives = parseTtsDirectives(text, config.modelOverrides, {
    cfg,
    providerConfigs: config.providerConfigs,
    preferredProviderId: activeProvider,
  });
  if (directives.warnings.length > 0) {
    logVerbose(`TTS: ignored directive overrides (${directives.warnings.join("; ")})`);
  }

  if (isVerbose()) {
    const effectiveProvider = directives.overrides?.provider
      ? (canonicalizeSpeechProviderId(directives.overrides.provider, cfg) ?? activeProvider)
      : activeProvider;
    logVerbose(
      `TTS: auto mode enabled (${autoMode}), channel=${params.channel}, selected provider=${effectiveProvider}, config.provider=${config.provider}, config.providerSource=${config.providerSource}`,
    );
  }

  const cleanedText = directives.cleanedText;
  const trimmedCleaned = cleanedText.trim();
  const visibleText = trimmedCleaned.length > 0 ? trimmedCleaned : "";
  const explicitTtsText = directives.ttsText?.trim() || "";
  const ttsText = explicitTtsText || visibleText;

  const nextPayload =
    visibleText === text.trim()
      ? params.payload
      : {
          ...params.payload,
          text: visibleText.length > 0 ? visibleText : undefined,
        };

  if (autoMode === "tagged" && !directives.hasDirective) {
    return nextPayload;
  }
  if (autoMode === "inbound" && params.inboundAudio !== true) {
    return nextPayload;
  }

  const mode = config.mode ?? "final";
  if (mode === "final" && params.kind && params.kind !== "final") {
    return nextPayload;
  }

  if (!ttsText.trim()) {
    return nextPayload;
  }
  if (reply.hasMedia || hasLegacyFinalMediaDirective(text)) {
    return nextPayload;
  }
  if (!explicitTtsText && ttsText.trim().length < 10) {
    return nextPayload;
  }

  const maxLength = getTtsMaxLength(prefsPath);
  let textForAudio = ttsText.trim();
  let wasSummarized = false;

  if (!explicitTtsText && isCodeHeavySpeechText(textForAudio)) {
    // The visible reply already carries code-heavy detail. Skip noisy voice-note audio instead of
    // telling channel users to look at a screen they may not have.
    return nextPayload;
  }

  if (textForAudio.length > maxLength) {
    if (!isSummarizationEnabled(prefsPath)) {
      logVerbose(
        `TTS: truncating long text (${textForAudio.length} > ${maxLength}), summarization disabled.`,
      );
      textForAudio = `${truncateUtf16Safe(textForAudio, maxLength - 3)}...`;
    } else {
      try {
        const summary = await summarizeText({
          text: textForAudio,
          targetLength: maxLength,
          cfg,
          config,
          timeoutMs: config.timeoutMs,
        });
        textForAudio = summary.summary;
        wasSummarized = true;
        if (textForAudio.length > config.maxTextLength) {
          logVerbose(
            `TTS: summary exceeded hard limit (${textForAudio.length} > ${config.maxTextLength}); truncating.`,
          );
          textForAudio = `${truncateUtf16Safe(textForAudio, config.maxTextLength - 3)}...`;
        }
      } catch (err) {
        const error = err as Error;
        logVerbose(`TTS: summarization failed, truncating instead: ${error.message}`);
        textForAudio = `${truncateUtf16Safe(textForAudio, maxLength - 3)}...`;
      }
    }
  }

  const normalizedTextForAudio = normalizeSpeechText(textForAudio);
  if (!normalizedTextForAudio) {
    return nextPayload;
  }
  if (!explicitTtsText && normalizedTextForAudio.length < 10) {
    return nextPayload;
  }

  const ttsStart = Date.now();
  const result = await textToSpeech({
    text: textForAudio,
    cfg,
    prefsPath,
    channel: params.channel,
    overrides: directives.overrides,
    agentId: params.agentId,
    accountId: params.accountId,
  });

  if (result.success && result.audioPath) {
    lastTtsAttempt = {
      timestamp: Date.now(),
      success: true,
      textLength: text.length,
      summarized: wasSummarized,
      provider: result.provider,
      persona: result.persona,
      fallbackFrom: result.fallbackFrom,
      attemptedProviders: result.attemptedProviders,
      attempts: result.attempts,
      latencyMs: result.latencyMs,
    };

    const payloadWithAudio = {
      ...nextPayload,
      mediaUrl: result.audioPath,
      audioAsVoice: result.audioAsVoice || params.payload.audioAsVoice,
      spokenText: textForAudio,
      trustedLocalMedia: true,
    } as ReplyPayload;
    return nextPayload.text?.trim()
      ? markReplyPayloadAsTtsSupplement(payloadWithAudio)
      : payloadWithAudio;
  }

  lastTtsAttempt = {
    timestamp: Date.now(),
    success: false,
    textLength: text.length,
    summarized: wasSummarized,
    persona: result.persona,
    attemptedProviders: result.attemptedProviders,
    attempts: result.attempts,
    error: result.error,
  };

  const latency = Date.now() - ttsStart;
  logVerbose(`TTS: conversion failed after ${latency}ms (${result.error ?? "unknown"}).`);
  return nextPayload;
}
