import { asOptionalRecord, readStringField } from "openclaw/plugin-sdk/text-runtime";
import type { VoiceCallConfig } from "./config.js";
import { VoiceCallConfigSchema } from "./config.js";

export const VOICE_CALL_LEGACY_CONFIG_REMOVAL_VERSION = "2026.6.0";

type VoiceCallLegacyConfigIssue = {
  path: string;
  replacement: string;
  message: string;
};

const asObject = asOptionalRecord;
const getString = readStringField;

function getNumber(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = obj?.[key];
  return typeof value === "number" ? value : undefined;
}

function mergeProviderConfig(
  providersValue: unknown,
  providerId: string,
  compatValues: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (Object.keys(compatValues).length === 0) {
    return asObject(providersValue);
  }

  const providers = asObject(providersValue) ?? {};
  const existing = asObject(providers[providerId]) ?? {};
  return {
    ...providers,
    [providerId]: {
      ...existing,
      ...compatValues,
    },
  };
}

export function collectVoiceCallLegacyConfigIssues(value: unknown): VoiceCallLegacyConfigIssue[] {
  const raw = asObject(value) ?? {};
  const twilio = asObject(raw.twilio);
  const streaming = asObject(raw.streaming);

  const issues: VoiceCallLegacyConfigIssue[] = [];
  if (raw.provider === "log") {
    issues.push({
      path: "provider",
      replacement: "provider",
      message: 'Replace provider "log" with "mock".',
    });
  }
  if (typeof twilio?.from === "string") {
    issues.push({
      path: "twilio.from",
      replacement: "fromNumber",
      message: "Move twilio.from to fromNumber.",
    });
  }
  if (typeof streaming?.sttProvider === "string") {
    issues.push({
      path: "streaming.sttProvider",
      replacement: "streaming.provider",
      message: "Move streaming.sttProvider to streaming.provider.",
    });
  }
  if (typeof streaming?.openaiApiKey === "string") {
    issues.push({
      path: "streaming.openaiApiKey",
      replacement: "streaming.providers.openai.apiKey",
      message: "Move streaming.openaiApiKey to streaming.providers.openai.apiKey.",
    });
  }
  if (typeof streaming?.sttModel === "string") {
    issues.push({
      path: "streaming.sttModel",
      replacement: "streaming.providers.openai.model",
      message: "Move streaming.sttModel to streaming.providers.openai.model.",
    });
  }
  if (typeof streaming?.silenceDurationMs === "number") {
    issues.push({
      path: "streaming.silenceDurationMs",
      replacement: "streaming.providers.openai.silenceDurationMs",
      message: "Move streaming.silenceDurationMs to streaming.providers.openai.silenceDurationMs.",
    });
  }
  if (typeof streaming?.vadThreshold === "number") {
    issues.push({
      path: "streaming.vadThreshold",
      replacement: "streaming.providers.openai.vadThreshold",
      message: "Move streaming.vadThreshold to streaming.providers.openai.vadThreshold.",
    });
  }

  return issues;
}

export function formatVoiceCallLegacyConfigWarnings(params: {
  value: unknown;
  configPathPrefix: string;
  doctorFixCommand: string;
}): string[] {
  const issues = collectVoiceCallLegacyConfigIssues(params.value);
  if (issues.length === 0) {
    return [];
  }

  return [
    `[voice-call] legacy config keys detected under ${params.configPathPrefix}; runtime loading will not rewrite them, and support for the legacy shape will be removed in ${VOICE_CALL_LEGACY_CONFIG_REMOVAL_VERSION}. Run "${params.doctorFixCommand}".`,
    ...issues.map(
      (issue) => `[voice-call] ${params.configPathPrefix}.${issue.path}: ${issue.message}`,
    ),
  ];
}

export function migrateVoiceCallLegacyConfigInput(params: {
  value: unknown;
  configPathPrefix?: string;
}): {
  config: Record<string, unknown>;
  changes: string[];
  issues: VoiceCallLegacyConfigIssue[];
} {
  const raw = asObject(params.value) ?? {};
  const twilio = asObject(raw.twilio);
  const streaming = asObject(raw.streaming);
  const configPathPrefix = params.configPathPrefix ?? "plugins.entries.voice-call.config";
  const issues = collectVoiceCallLegacyConfigIssues(raw);

  const legacyStreamingOpenAICompat: Record<string, unknown> = {};
  const streamingOpenAIApiKey = getString(streaming, "openaiApiKey");
  if (streamingOpenAIApiKey) {
    legacyStreamingOpenAICompat.apiKey = streamingOpenAIApiKey;
  }
  const streamingSttModel = getString(streaming, "sttModel");
  if (streamingSttModel) {
    legacyStreamingOpenAICompat.model = streamingSttModel;
  }
  const streamingSilenceDurationMs = getNumber(streaming, "silenceDurationMs");
  if (streamingSilenceDurationMs !== undefined) {
    legacyStreamingOpenAICompat.silenceDurationMs = streamingSilenceDurationMs;
  }
  const streamingVadThreshold = getNumber(streaming, "vadThreshold");
  if (streamingVadThreshold !== undefined) {
    legacyStreamingOpenAICompat.vadThreshold = streamingVadThreshold;
  }
  const streamingProvider = getString(streaming, "provider");
  const legacyStreamingProvider = getString(streaming, "sttProvider");

  const normalizedStreaming: Record<string, unknown> | undefined = streaming
    ? {
        ...streaming,
        provider: streamingProvider ?? legacyStreamingProvider,
        providers: mergeProviderConfig(streaming.providers, "openai", legacyStreamingOpenAICompat),
      }
    : undefined;

  if (normalizedStreaming) {
    delete normalizedStreaming.sttProvider;
    delete normalizedStreaming.openaiApiKey;
    delete normalizedStreaming.sttModel;
    delete normalizedStreaming.silenceDurationMs;
    delete normalizedStreaming.vadThreshold;
  }

  const normalizedTwilio = twilio
    ? {
        ...twilio,
      }
    : undefined;
  if (normalizedTwilio) {
    delete normalizedTwilio.from;
  }

  const config = {
    ...raw,
    provider: raw.provider === "log" ? "mock" : raw.provider,
    fromNumber: raw.fromNumber ?? (typeof twilio?.from === "string" ? twilio.from : undefined),
    twilio: normalizedTwilio,
    streaming: normalizedStreaming,
  };

  const changes: string[] = [];
  if (raw.provider === "log") {
    changes.push(`Moved ${configPathPrefix}.provider "log" → "mock".`);
  }
  if (typeof twilio?.from === "string" && typeof raw.fromNumber !== "string") {
    changes.push(`Moved ${configPathPrefix}.twilio.from → ${configPathPrefix}.fromNumber.`);
  }
  if (typeof streaming?.sttProvider === "string") {
    changes.push(
      `Moved ${configPathPrefix}.streaming.sttProvider → ${configPathPrefix}.streaming.provider.`,
    );
  }
  if (typeof streaming?.openaiApiKey === "string") {
    changes.push(
      `Moved ${configPathPrefix}.streaming.openaiApiKey → ${configPathPrefix}.streaming.providers.openai.apiKey.`,
    );
  }
  if (typeof streaming?.sttModel === "string") {
    changes.push(
      `Moved ${configPathPrefix}.streaming.sttModel → ${configPathPrefix}.streaming.providers.openai.model.`,
    );
  }
  if (typeof streaming?.silenceDurationMs === "number") {
    changes.push(
      `Moved ${configPathPrefix}.streaming.silenceDurationMs → ${configPathPrefix}.streaming.providers.openai.silenceDurationMs.`,
    );
  }
  if (typeof streaming?.vadThreshold === "number") {
    changes.push(
      `Moved ${configPathPrefix}.streaming.vadThreshold → ${configPathPrefix}.streaming.providers.openai.vadThreshold.`,
    );
  }

  return { config, changes, issues };
}

export function normalizeVoiceCallLegacyConfigInput(value: unknown): Record<string, unknown> {
  return migrateVoiceCallLegacyConfigInput({ value }).config;
}

export function parseVoiceCallPluginConfig(value: unknown): VoiceCallConfig {
  return VoiceCallConfigSchema.parse(normalizeVoiceCallLegacyConfigInput(value));
}
