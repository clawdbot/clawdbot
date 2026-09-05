// Legacy cron payload migration for provider/channel aliases and OpenAI Codex model refs.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue as readString,
} from "../../../../packages/normalization-core/src/string-coerce.js";
import {
  classifyCronAgentTurnShellPrompt,
  hasCronShellToolAccess,
  parseCronAgentTurnCommandPrompt,
  type CronAgentTurnShellPromptKind,
} from "../../../cron/agent-turn-command-prompt.js";
import { toCanonicalOpenAIModelRef } from "../shared/codex-route-model-ref.js";
import {
  IMAGE_INSPECTION_TOOL_NAME_MIGRATION,
  migrateLegacyToolNameList,
  TASK_SUGGESTION_TOOL_NAME_MIGRATION,
} from "../shared/legacy-tool-name-migration.js";

type UnknownRecord = Record<string, unknown>;

const LEGACY_DELIVERY_HINT_FIELDS = [
  "deliver",
  "bestEffortDeliver",
  "channel",
  "provider",
  "to",
  "threadId",
] as const;

export function normalizePayloadKind(payload: UnknownRecord) {
  const raw = normalizeOptionalLowercaseString(payload.kind) ?? "";
  if (raw === "agentturn") {
    if (payload.kind !== "agentTurn") {
      payload.kind = "agentTurn";
      return true;
    }
    return false;
  }
  if (raw === "systemevent") {
    if (payload.kind !== "systemEvent") {
      payload.kind = "systemEvent";
      return true;
    }
    return false;
  }
  return false;
}

export function inferPayloadIfMissing(raw: UnknownRecord) {
  const message = normalizeOptionalString(raw.message) ?? "";
  const text = normalizeOptionalString(raw.text) ?? "";
  const command = normalizeOptionalString(raw.command) ?? "";
  if (message) {
    raw.payload = { kind: "agentTurn", message };
    return true;
  }
  if (text) {
    raw.payload = { kind: "systemEvent", text };
    return true;
  }
  if (command) {
    raw.payload = { kind: "systemEvent", text: command };
    return true;
  }
  return false;
}

export function copyTopLevelAgentTurnFields(raw: UnknownRecord, payload: UnknownRecord) {
  let mutated = false;

  const copyTrimmedString = (field: "model" | "thinking") => {
    const existing = normalizeOptionalString(payload[field]);
    if (existing) {
      return;
    }
    const value = normalizeOptionalString(raw[field]);
    if (value) {
      payload[field] = value;
      mutated = true;
    }
  };
  copyTrimmedString("model");
  copyTrimmedString("thinking");

  if (
    typeof payload.timeoutSeconds !== "number" &&
    typeof raw.timeoutSeconds === "number" &&
    Number.isFinite(raw.timeoutSeconds)
  ) {
    payload.timeoutSeconds = Math.max(0, Math.floor(raw.timeoutSeconds));
    mutated = true;
  }

  if (
    typeof payload.allowUnsafeExternalContent !== "boolean" &&
    typeof raw.allowUnsafeExternalContent === "boolean"
  ) {
    payload.allowUnsafeExternalContent = raw.allowUnsafeExternalContent;
    mutated = true;
  }

  if (typeof payload.deliver !== "boolean" && typeof raw.deliver === "boolean") {
    payload.deliver = raw.deliver;
    mutated = true;
  }
  const channel = normalizeOptionalString(raw.channel);
  if (typeof payload.channel !== "string" && channel) {
    payload.channel = channel;
    mutated = true;
  }
  const to = normalizeOptionalString(raw.to);
  if (typeof payload.to !== "string" && to) {
    payload.to = to;
    mutated = true;
  }
  const rawThreadId = normalizeOptionalString(raw.threadId);
  if (
    !("threadId" in payload) &&
    ((typeof raw.threadId === "number" && Number.isFinite(raw.threadId)) || Boolean(rawThreadId))
  ) {
    payload.threadId = rawThreadId ?? raw.threadId;
    mutated = true;
  }
  if (
    typeof payload.bestEffortDeliver !== "boolean" &&
    typeof raw.bestEffortDeliver === "boolean"
  ) {
    payload.bestEffortDeliver = raw.bestEffortDeliver;
    mutated = true;
  }
  const provider = normalizeOptionalString(raw.provider);
  if (typeof payload.provider !== "string" && provider) {
    payload.provider = provider;
    mutated = true;
  }

  return mutated;
}

export function stripLegacyTopLevelFields(raw: UnknownRecord) {
  if ("model" in raw) {
    delete raw.model;
  }
  if ("thinking" in raw) {
    delete raw.thinking;
  }
  if ("timeoutSeconds" in raw) {
    delete raw.timeoutSeconds;
  }
  if ("allowUnsafeExternalContent" in raw) {
    delete raw.allowUnsafeExternalContent;
  }
  if ("message" in raw) {
    delete raw.message;
  }
  if ("text" in raw) {
    delete raw.text;
  }
  if ("deliver" in raw) {
    delete raw.deliver;
  }
  if ("channel" in raw) {
    delete raw.channel;
  }
  if ("to" in raw) {
    delete raw.to;
  }
  if ("threadId" in raw) {
    delete raw.threadId;
  }
  if ("bestEffortDeliver" in raw) {
    delete raw.bestEffortDeliver;
  }
  if ("provider" in raw) {
    delete raw.provider;
  }
  if ("command" in raw) {
    delete raw.command;
  }
  if ("timeout" in raw) {
    delete raw.timeout;
  }
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

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
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

  if (migrateLegacyToolNameList(payload.toolsAllow, TASK_SUGGESTION_TOOL_NAME_MIGRATION)) {
    mutated = true;
  }
  if (migrateLegacyToolNameList(payload.toolsAllow, IMAGE_INSPECTION_TOOL_NAME_MIGRATION)) {
    mutated = true;
  }

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
  const parsed = parseCronAgentTurnCommandPrompt(message);
  if (!parsed) {
    return false;
  }
  if (!hasCronShellToolAccess(payload.toolsAllow)) {
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
): CronAgentTurnShellPromptKind | null {
  return classifyCronAgentTurnShellPrompt(payload);
}
