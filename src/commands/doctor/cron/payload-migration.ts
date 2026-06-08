// Legacy cron payload migration for provider/channel aliases and OpenAI Codex model refs.
import {
  normalizeOptionalLowercaseString,
  readStringValue as readString,
} from "../../../../packages/normalization-core/src/string-coerce.js";

type UnknownRecord = Record<string, unknown>;

type LegacyAgentTurnCommandPayload = {
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
};

const LEGACY_AGENT_TURN_COMMAND_MARKER_RE = /\bCommand to run\s*:/iu;
const LEGACY_AGENT_TURN_COMMAND_FIELD_RE = /^\s*-\s*(command|workdir|timeout)\s*:\s*(.*?)\s*$/iu;
const SHELL_TOOL_NAMES = new Set(["bash", "command", "exec", "process", "shell", "sh"]);
const SHELL_COMMAND_MESSAGE_RE =
  /\b(?:bash|command|execute|exec|process|run|shell)\b[\s\S]{0,240}\b(?:python3?|node|bun|pnpm|npm|npx|yarn|sh|bash|sudo|cd|\.\/|\/[A-Za-z0-9._/-]+)\b/iu;
const LEGACY_DELIVERY_HINT_FIELDS = [
  "deliver",
  "bestEffortDeliver",
  "channel",
  "provider",
  "to",
  "threadId",
] as const;

function hasShellToolAccess(toolsAllow: unknown): boolean {
  if (toolsAllow === undefined) {
    return true;
  }
  if (!Array.isArray(toolsAllow)) {
    return false;
  }
  return toolsAllow.some((tool) => {
    const normalized = normalizeOptionalLowercaseString(tool);
    return normalized === "*" || (normalized ? SHELL_TOOL_NAMES.has(normalized) : false);
  });
}

function toCanonicalOpenAIModelRef(value: unknown): string | undefined {
  const raw = readString(value);
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const provider = trimmed.slice(0, slash).trim().toLowerCase();
  if (provider !== "openai-codex") {
    return undefined;
  }
  const model = trimmed.slice(slash + 1).trim();
  return model ? `openai/${model}` : undefined;
}

function normalizeChannel(value: string): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}

function parsePositiveInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function parseLegacyAgentTurnCommandMessage(message: string): LegacyAgentTurnCommandPayload | null {
  if (!LEGACY_AGENT_TURN_COMMAND_MARKER_RE.test(message)) {
    return null;
  }

  let command = "";
  let cwd: string | undefined;
  let timeoutSeconds: number | undefined;

  for (const line of message.split(/\r?\n/u)) {
    const match = LEGACY_AGENT_TURN_COMMAND_FIELD_RE.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1]?.toLowerCase();
    const value = match[2]?.trim() ?? "";
    if (key === "command" && value && !command) {
      command = value;
    } else if (key === "workdir" && value && !cwd) {
      cwd = value;
    } else if (key === "timeout" && value && timeoutSeconds === undefined) {
      timeoutSeconds = parsePositiveInteger(value);
    }
  }

  if (!command) {
    return null;
  }

  return {
    command,
    ...(cwd ? { cwd } : {}),
    ...(timeoutSeconds ? { timeoutSeconds } : {}),
  };
}

/** Return true when a cron payload contains legacy `openai-codex/*` model refs. */
export function hasLegacyOpenAICodexCronModelRef(payload: UnknownRecord): boolean {
  if (toCanonicalOpenAIModelRef(payload.model)) {
    return true;
  }
  const fallbacks = payload.fallbacks;
  return (
    Array.isArray(fallbacks) && fallbacks.some((fallback) => toCanonicalOpenAIModelRef(fallback))
  );
}

function migrateLegacyOpenAICodexModelRefs(payload: UnknownRecord): boolean {
  let mutated = false;

  const model = toCanonicalOpenAIModelRef(payload.model);
  if (model && payload.model !== model) {
    payload.model = model;
    mutated = true;
  }

  const fallbacks = payload.fallbacks;
  if (Array.isArray(fallbacks)) {
    const next = fallbacks.map((fallback) => toCanonicalOpenAIModelRef(fallback) ?? fallback);
    if (next.some((fallback, index) => fallback !== fallbacks[index])) {
      payload.fallbacks = next;
      mutated = true;
    }
  }

  return mutated;
}

/** Normalize legacy cron payload channel/provider and model reference fields in place. */
export function migrateLegacyCronPayload(payload: UnknownRecord): boolean {
  let mutated = false;

  const channelValue = readString(payload.channel);
  const providerValue = readString(payload.provider);

  const nextChannel =
    typeof channelValue === "string" && channelValue.trim().length > 0
      ? normalizeChannel(channelValue)
      : typeof providerValue === "string" && providerValue.trim().length > 0
        ? normalizeChannel(providerValue)
        : "";

  if (nextChannel) {
    if (channelValue !== nextChannel) {
      payload.channel = nextChannel;
      mutated = true;
    }
  }

  if ("provider" in payload) {
    delete payload.provider;
    mutated = true;
  }

  if (migrateLegacyOpenAICodexModelRefs(payload)) {
    mutated = true;
  }

  return mutated;
}

export function migrateLegacyAgentTurnCommandPayload(payload: UnknownRecord): boolean {
  if (payload.kind !== "agentTurn") {
    return false;
  }
  const message = readString(payload.message);
  if (typeof message !== "string") {
    return false;
  }
  const parsed = parseLegacyAgentTurnCommandMessage(message);
  if (!parsed) {
    return false;
  }
  if (!hasShellToolAccess(payload.toolsAllow)) {
    return false;
  }

  const timeoutSeconds = readPositiveInteger(payload.timeoutSeconds) ?? parsed.timeoutSeconds;
  const deliveryHints: UnknownRecord = {};
  for (const key of LEGACY_DELIVERY_HINT_FIELDS) {
    if (key in payload) {
      deliveryHints[key] = payload[key];
    }
  }

  for (const key of Object.keys(payload)) {
    delete payload[key];
  }

  payload.kind = "command";
  payload.argv = ["sh", "-lc", parsed.command];
  if (parsed.cwd) {
    payload.cwd = parsed.cwd;
  }
  if (timeoutSeconds !== undefined) {
    payload.timeoutSeconds = timeoutSeconds;
  }
  Object.assign(payload, deliveryHints);
  return true;
}

export function hasUnresolvedAgentTurnShellToolPrompt(payload: UnknownRecord): boolean {
  if (payload.kind !== "agentTurn") {
    return false;
  }
  const message = readString(payload.message);
  if (typeof message !== "string") {
    return false;
  }
  const parsed = parseLegacyAgentTurnCommandMessage(message);
  return (
    Boolean(parsed) ||
    (hasShellToolAccess(payload.toolsAllow) && SHELL_COMMAND_MESSAGE_RE.test(message))
  );
}
