// Legacy cron payload migration for provider/channel aliases and OpenAI Codex model refs.
import {
  normalizeOptionalLowercaseString,
  readStringValue as readString,
} from "../../../../packages/normalization-core/src/string-coerce.js";
import { toCanonicalOpenAIModelRef } from "../shared/codex-route-model-ref.js";

type UnknownRecord = Record<string, unknown>;

type LegacyAgentTurnCommandPayload = {
  command: string;
  cwd?: string;
  timeoutSeconds?: number;
};

type UnresolvedAgentTurnShellToolPromptKind = "commandPromptWithoutShellAccess" | "shellToolPrompt";

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

type LegacyOpenAICodexCronModelRoute = {
  legacyModelRef: string;
  canonicalModelRef: string;
};

function readLegacyOpenAICodexCronModelRoute(
  value: unknown,
): LegacyOpenAICodexCronModelRoute | undefined {
  const legacyModelRef = readString(value)?.trim();
  const canonicalModelRef = legacyModelRef ? toCanonicalOpenAIModelRef(legacyModelRef) : undefined;
  return legacyModelRef && canonicalModelRef ? { legacyModelRef, canonicalModelRef } : undefined;
}

/** Legacy and canonical route pairs retained for namespace-specific migration blockers. */
export function collectLegacyOpenAICodexCronModelRoutes(
  payload: UnknownRecord,
): LegacyOpenAICodexCronModelRoute[] {
  const routes = new Map<string, LegacyOpenAICodexCronModelRoute>();
  const add = (value: unknown) => {
    const route = readLegacyOpenAICodexCronModelRoute(value);
    if (route) {
      routes.set(`${route.legacyModelRef}\u0000${route.canonicalModelRef}`, route);
    }
  };
  add(payload.model);
  if (Array.isArray(payload.fallbacks)) {
    for (const fallback of payload.fallbacks) {
      add(fallback);
    }
  }
  return [...routes.values()];
}

/** Canonical OpenAI refs whose legacy cron shape implied the Codex runtime. */
function collectLegacyOpenAICodexCronModelRefs(payload: UnknownRecord): string[] {
  return [
    ...new Set(
      collectLegacyOpenAICodexCronModelRoutes(payload).map((route) => route.canonicalModelRef),
    ),
  ];
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

/** Return true when a cron payload contains legacy Codex-route model refs. */
export function hasLegacyOpenAICodexCronModelRef(payload: UnknownRecord): boolean {
  return collectLegacyOpenAICodexCronModelRefs(payload).length > 0;
}

function migrateLegacyOpenAICodexModelRefs(
  payload: UnknownRecord,
  shouldMigrate: (modelRef: string, legacyModelRef: string) => boolean,
): boolean {
  let mutated = false;

  const model = readLegacyOpenAICodexCronModelRoute(payload.model);
  if (
    model &&
    shouldMigrate(model.canonicalModelRef, model.legacyModelRef) &&
    payload.model !== model.canonicalModelRef
  ) {
    payload.model = model.canonicalModelRef;
    mutated = true;
  }

  const fallbacks = payload.fallbacks;
  if (Array.isArray(fallbacks)) {
    const next = fallbacks.map((fallback) => {
      const route = readLegacyOpenAICodexCronModelRoute(fallback);
      return route && shouldMigrate(route.canonicalModelRef, route.legacyModelRef)
        ? route.canonicalModelRef
        : fallback;
    });
    if (next.some((fallback, index) => fallback !== fallbacks[index])) {
      payload.fallbacks = next;
      mutated = true;
    }
  }

  return mutated;
}

/** Normalize legacy cron payload channel/provider and model reference fields in place. */
export function migrateLegacyCronPayload(
  payload: UnknownRecord,
  options: {
    migrateCodexModelRefs?: boolean;
    shouldMigrateCodexModelRef?: (modelRef: string, legacyModelRef: string) => boolean;
  } = {},
): boolean {
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

  const shouldMigrateCodexModelRef =
    options.migrateCodexModelRefs === true
      ? (options.shouldMigrateCodexModelRef ?? (() => true))
      : () => false;
  if (migrateLegacyOpenAICodexModelRefs(payload, shouldMigrateCodexModelRef)) {
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

export function classifyUnresolvedAgentTurnShellToolPrompt(
  payload: UnknownRecord,
): UnresolvedAgentTurnShellToolPromptKind | null {
  if (payload.kind !== "agentTurn") {
    return null;
  }
  const message = readString(payload.message);
  if (typeof message !== "string") {
    return null;
  }
  const parsed = parseLegacyAgentTurnCommandMessage(message);
  const shellToolAccess = hasShellToolAccess(payload.toolsAllow);
  if (parsed && !shellToolAccess) {
    return "commandPromptWithoutShellAccess";
  }
  if (shellToolAccess && SHELL_COMMAND_MESSAGE_RE.test(message)) {
    return "shellToolPrompt";
  }
  return null;
}
