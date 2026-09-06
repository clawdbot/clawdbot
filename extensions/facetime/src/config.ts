import {
  isRealtimeVoiceAgentConsultToolPolicy,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES,
  type RealtimeVoiceAgentConsultToolPolicy,
} from "openclaw/plugin-sdk/realtime-voice";
import { asRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export type FaceTimeConfig = {
  enabled: boolean;
  ownerHandles: string[];
  realtime: {
    provider?: string;
    model?: string;
    voice?: string;
    sessionKey: string;
    toolPolicy: RealtimeVoiceAgentConsultToolPolicy;
    instructions?: string;
    providers: Record<string, Record<string, unknown>>;
  };
};

const DEFAULT_INSTRUCTIONS = [
  "You are the realtime voice surface for the configured OpenClaw agent during a private 1:1 FaceTime call.",
  "Keep replies concise, natural, and useful for a hands-free voice conversation.",
].join(" ");

function resolveBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resolveStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function resolveRealtimeVoiceAgentConsultToolPolicy(
  value: unknown,
): RealtimeVoiceAgentConsultToolPolicy {
  if (value === undefined) {
    return "owner";
  }
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!isRealtimeVoiceAgentConsultToolPolicy(normalized)) {
    throw new Error(
      `realtime.toolPolicy must be one of ${REALTIME_VOICE_AGENT_CONSULT_TOOL_POLICIES.join(", ")}`,
    );
  }
  return normalized;
}

function resolveProviders(value: unknown): Record<string, Record<string, unknown>> {
  const raw = asRecord(value);
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [key, providerConfig] of Object.entries(raw)) {
    const id = normalizeOptionalString(key);
    if (id) {
      providers[id] = asRecord(providerConfig);
    }
  }
  return providers;
}

export function resolveFaceTimeConfig(input: unknown): FaceTimeConfig {
  const raw = asRecord(input);
  const realtime = asRecord(raw.realtime);
  if (typeof realtime.instructions === "string" && realtime.instructions.length > 4000) {
    throw new Error("realtime.instructions must not exceed 4000 characters");
  }
  return {
    enabled: resolveBoolean(raw.enabled, true),
    ownerHandles: resolveStringArray(raw.ownerHandles),
    realtime: {
      provider: normalizeOptionalString(realtime.provider),
      model: normalizeOptionalString(realtime.model),
      voice: normalizeOptionalString(realtime.voice),
      sessionKey: normalizeOptionalString(realtime.sessionKey) ?? "main",
      toolPolicy: resolveRealtimeVoiceAgentConsultToolPolicy(realtime.toolPolicy),
      instructions: normalizeOptionalString(realtime.instructions) ?? DEFAULT_INSTRUCTIONS,
      providers: resolveProviders(realtime.providers),
    },
  };
}

export function validateFaceTimeConfig(config: FaceTimeConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!config.ownerHandles.length) {
    errors.push("ownerHandles must contain at least one authorized FaceTime handle");
  }
  if (process.platform !== "darwin") {
    errors.push("facetime requires macOS");
  }
  return { valid: errors.length === 0, errors };
}
