// Qa Lab plugin module implements suite runtime agent session behavior.
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  listSessionEntries,
  loadTranscriptEventsSync,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  isRecord,
  normalizeOptionalString as readNonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createDirectReplyTranscriptSentinelScanner,
  extractGatewayMessageText,
} from "./gateway-log-sentinel.js";
import { liveTurnTimeoutMs } from "./suite-runtime-agent-common.js";
import type {
  QaRawSessionStoreEntry,
  QaSkillStatusEntry,
  QaSuiteRuntimeEnv,
} from "./suite-runtime-types.js";

type QaGatewayCallEnv = Pick<
  QaSuiteRuntimeEnv,
  "gateway" | "primaryModel" | "alternateModel" | "providerMode"
>;

type QaSessionTranscriptSeedParams = {
  label?: string;
  messages: readonly {
    role: "assistant" | "user";
    text: string;
    timestamp: number;
  }[];
  sessionId: string;
  sessionKey: string;
  updatedAt: number;
};

const SESSION_STORE_FTS_SETTLE_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000] as const;
const MAX_COMPACTION_SUMMARIES = 16;
const MAX_SUCCESSFUL_TOOL_CALL_EVENTS = 64;

type QaSessionTranscriptSummary = {
  assistantMirrors?: Array<{ identity: string; text: string }>;
  assistantToolCallCounts: Record<string, number>;
  compactionSummaries: string[];
  completedToolCallCounts: Record<string, number>;
  eventCursor: number;
  userMessageCount: number;
  successfulToolCallCounts: Record<string, number>;
  successfulToolCallEvents?: Array<{ name: string; timestamp: number; toolCallId: string }>;
  finalText: string;
  hasDirectReplySelfMessage: boolean;
  lastAssistantContentTypes?: string[];
  lastAssistantErrorMessage?: string;
  lastAssistantStopReason?: string;
  lastAssistantToolNames?: string[];
  lastMessageRole?: string;
};

type QaSessionTranscriptSummaryOptions = {
  afterEventCursor?: number;
  allowEmpty?: boolean;
};

function isSessionStoreFtsSettleRace(error: unknown) {
  const text = formatErrorMessage(error);
  return (
    text.includes("SQLite integrity_check failed") &&
    text.includes("fts5: checksum mismatch") &&
    text.includes("session_transcript_fts")
  );
}

function readSessionTranscriptEventMessage(event: unknown) {
  return isRecord(event) && isRecord(event.message) ? event.message : undefined;
}

function readAssistantToolCalls(message: Record<string, unknown>): Array<{
  id?: string;
  name: string;
}> {
  if (!Array.isArray(message.content)) {
    return [];
  }
  return message.content.flatMap((block) => {
    if (!isRecord(block)) {
      return [];
    }
    const type = readNonEmptyString(block.type);
    if (type !== "toolCall" && type !== "toolUse" && type !== "tool_use") {
      return [];
    }
    const name = readNonEmptyString(block.name);
    return name ? [{ id: readNonEmptyString(block.id), name }] : [];
  });
}

function summarizeSessionTranscriptEvents(
  events: unknown[],
  sessionKey: string,
  eventCursor = events.length,
): QaSessionTranscriptSummary {
  const scanner = createDirectReplyTranscriptSentinelScanner();
  const assistantMirrors: Array<{ identity: string; text: string }> = [];
  const assistantToolCallCounts: Record<string, number> = {};
  const completedToolCallCounts: Record<string, number> = {};
  const compactionSummaries: string[] = [];
  const successfulToolCallCounts: Record<string, number> = {};
  const successfulToolCallEvents: NonNullable<
    QaSessionTranscriptSummary["successfulToolCallEvents"]
  > = [];
  const assistantToolNamesByCallId = new Map<string, string>();
  const completedToolCallIds = new Set<string>();
  const successfulToolCallIds = new Set<string>();
  let finalText = "";
  let lastAssistantContentTypes: string[] = [];
  let lastAssistantErrorMessage: string | undefined;
  let lastAssistantStopReason: string | undefined;
  let lastAssistantToolNames: string[] = [];
  let lastMessageRole: string | undefined;
  let userMessageCount = 0;

  for (const event of events) {
    if (isRecord(event) && event.type === "compaction") {
      const summary = readNonEmptyString(event.summary);
      if (summary) {
        if (compactionSummaries.length === MAX_COMPACTION_SUMMARIES) {
          compactionSummaries.shift();
        }
        compactionSummaries.push(summary);
      }
      continue;
    }
    const message = readSessionTranscriptEventMessage(event);
    if (!message) {
      continue;
    }
    lastMessageRole = readNonEmptyString(message.role);
    if (message.role === "user") {
      userMessageCount += 1;
      continue;
    }
    if (message.role === "toolResult") {
      const toolCallId = readNonEmptyString(message.toolCallId);
      const toolName = readNonEmptyString(message.toolName);
      if (
        toolCallId &&
        toolName &&
        assistantToolNamesByCallId.get(toolCallId) === toolName &&
        !completedToolCallIds.has(toolCallId)
      ) {
        completedToolCallIds.add(toolCallId);
        completedToolCallCounts[toolName] = (completedToolCallCounts[toolName] ?? 0) + 1;
      }
      if (
        toolCallId &&
        toolName &&
        message.isError === false &&
        assistantToolNamesByCallId.get(toolCallId) === toolName &&
        !successfulToolCallIds.has(toolCallId)
      ) {
        successfulToolCallIds.add(toolCallId);
        successfulToolCallCounts[toolName] = (successfulToolCallCounts[toolName] ?? 0) + 1;
        if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) {
          // Keep owner-authenticated result chronology bounded for long-lived QA sessions.
          if (successfulToolCallEvents.length === MAX_SUCCESSFUL_TOOL_CALL_EVENTS) {
            successfulToolCallEvents.shift();
          }
          successfulToolCallEvents.push({
            name: toolName,
            timestamp: message.timestamp,
            toolCallId,
          });
        }
      }
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }
    const text = extractGatewayMessageText(message);
    if (text) {
      finalText = text;
    }
    const openClawMeta = isRecord(message["__openclaw"]) ? message["__openclaw"] : undefined;
    const mirrorIdentity = readNonEmptyString(openClawMeta?.mirrorIdentity);
    if (mirrorIdentity && text) {
      assistantMirrors.push({ identity: mirrorIdentity, text });
    }
    lastAssistantContentTypes = Array.isArray(message.content)
      ? message.content.flatMap((block) => {
          const type = isRecord(block) ? readNonEmptyString(block.type) : undefined;
          return type ? [type] : [];
        })
      : [];
    lastAssistantErrorMessage = readNonEmptyString(message.errorMessage);
    lastAssistantStopReason = readNonEmptyString(message.stopReason);
    const assistantToolCalls = readAssistantToolCalls(message);
    lastAssistantToolNames = assistantToolCalls.map((toolCall) => toolCall.name);
    for (const toolCall of assistantToolCalls) {
      assistantToolCallCounts[toolCall.name] = (assistantToolCallCounts[toolCall.name] ?? 0) + 1;
      if (toolCall.id) {
        assistantToolNamesByCallId.set(toolCall.id, toolCall.name);
      }
    }
    scanner.recordMessage(message);
  }

  if (events.length === 0) {
    throw new Error(`session transcript is empty for ${sessionKey}`);
  }

  return {
    ...(assistantMirrors.length > 0 ? { assistantMirrors } : {}),
    assistantToolCallCounts,
    compactionSummaries,
    completedToolCallCounts,
    eventCursor,
    userMessageCount,
    successfulToolCallCounts,
    ...(successfulToolCallEvents.length > 0 ? { successfulToolCallEvents } : {}),
    finalText,
    hasDirectReplySelfMessage: scanner.findings().length > 0,
    ...(lastAssistantContentTypes.length > 0 ? { lastAssistantContentTypes } : {}),
    ...(lastAssistantErrorMessage ? { lastAssistantErrorMessage } : {}),
    ...(lastAssistantStopReason ? { lastAssistantStopReason } : {}),
    ...(lastAssistantToolNames.length > 0 ? { lastAssistantToolNames } : {}),
    ...(lastMessageRole ? { lastMessageRole } : {}),
  };
}

function emptySessionTranscriptSummary(eventCursor: number): QaSessionTranscriptSummary {
  return {
    assistantToolCallCounts: {},
    compactionSummaries: [],
    completedToolCallCounts: {},
    eventCursor,
    userMessageCount: 0,
    successfulToolCallCounts: {},
    finalText: "",
    hasDirectReplySelfMessage: false,
  };
}

async function createSession(env: QaGatewayCallEnv, label: string, key?: string) {
  const created = (await env.gateway.call(
    "sessions.create",
    {
      label,
      ...(key ? { key } : {}),
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 60_000),
    },
  )) as { key?: string };
  const sessionKey = created.key?.trim();
  if (!sessionKey) {
    throw new Error("sessions.create returned no key");
  }
  return sessionKey;
}

async function readEffectiveTools(env: QaGatewayCallEnv, sessionKey: string) {
  const payload = (await env.gateway.call(
    "tools.effective",
    {
      sessionKey,
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 90_000),
    },
  )) as { groups?: Array<{ tools?: Array<{ id?: string }> }> };
  const ids = new Set<string>();
  for (const group of payload.groups ?? []) {
    for (const tool of group.tools ?? []) {
      if (tool.id?.trim()) {
        ids.add(tool.id.trim());
      }
    }
  }
  return ids;
}

async function readSkillStatus(env: QaGatewayCallEnv, agentId = "qa") {
  const payload = (await env.gateway.call(
    "skills.status",
    {
      agentId,
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 45_000),
    },
  )) as { skills?: QaSkillStatusEntry[] };
  return payload.skills ?? [];
}

function qaSessionRuntimeEnv(tempRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
  };
}

async function seedQaSessionTranscript(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  params: QaSessionTranscriptSeedParams,
): Promise<void> {
  const sessionId = params.sessionId.trim();
  const sessionKey = params.sessionKey.trim();
  if (!sessionId || !sessionKey) {
    throw new Error("seedQaSessionTranscript requires sessionId and sessionKey");
  }
  if (params.messages.length === 0) {
    throw new Error("seedQaSessionTranscript requires at least one message");
  }

  const runtimeEnv = qaSessionRuntimeEnv(env.gateway.tempRoot);
  const storePath = resolveStorePath(undefined, {
    agentId: "qa",
    env: runtimeEnv,
  });
  const label = params.label?.trim();
  await upsertSessionEntry({
    agentId: "qa",
    env: runtimeEnv,
    sessionKey,
    storePath,
    entry: {
      sessionId,
      updatedAt: params.updatedAt,
      ...(label ? { origin: { label } } : {}),
    },
  });

  for (const seed of params.messages) {
    const appended = await appendSessionTranscriptMessageByIdentity({
      agentId: "qa",
      env: runtimeEnv,
      sessionId,
      sessionKey,
      storePath,
      now: seed.timestamp,
      message: {
        role: seed.role,
        timestamp: seed.timestamp,
        content: [{ type: "text", text: seed.text }],
      },
    });
    if (!appended?.appended) {
      throw new Error(`failed to seed QA session transcript for ${sessionKey}`);
    }
  }
}

async function readRawQaSessionStore(
  env: { gateway: Pick<QaSuiteRuntimeEnv["gateway"], "tempRoot"> },
  options: {
    agentId?: string;
    readEntries?: typeof listSessionEntries;
    retryDelaysMs?: readonly number[];
  } = {},
) {
  const runtimeEnv = qaSessionRuntimeEnv(env.gateway.tempRoot);
  const agentId = readNonEmptyString(options.agentId) ?? "qa";
  const readEntries = options.readEntries ?? listSessionEntries;
  const retryDelaysMs = options.retryDelaysMs ?? SESSION_STORE_FTS_SETTLE_RETRY_DELAYS_MS;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return Object.fromEntries(
        readEntries({ agentId, env: runtimeEnv }).map(({ sessionKey, entry }) => [
          sessionKey,
          entry as QaRawSessionStoreEntry,
        ]),
      );
    } catch (error) {
      if (!isSessionStoreFtsSettleRace(error) || attempt === retryDelaysMs.length) {
        throw error;
      }
      // Child completion can publish before its transcript writer has settled the FTS state.
      await sleep(retryDelaysMs[attempt]);
    }
  }
  throw new Error("QA session store read failed after FTS settle retries");
}

async function readSessionTranscriptSummary(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  sessionKey: string,
  options: QaSessionTranscriptSummaryOptions = {},
): Promise<QaSessionTranscriptSummary> {
  const normalizedSessionKey = sessionKey.trim();
  if (!normalizedSessionKey) {
    throw new Error("readSessionTranscriptSummary requires a session key");
  }
  const store = await readRawQaSessionStore(env);
  const entry = store[normalizedSessionKey];
  const sessionId = readNonEmptyString(entry?.sessionId);
  if (!sessionId) {
    if (options.allowEmpty === true) {
      return emptySessionTranscriptSummary(0);
    }
    throw new Error(`session transcript entry not found for ${normalizedSessionKey}`);
  }
  const events = loadTranscriptEventsSync({
    agentId: "qa",
    env: qaSessionRuntimeEnv(env.gateway.tempRoot),
    sessionId,
    sessionKey: normalizedSessionKey,
  });
  const afterEventCursor = options.afterEventCursor ?? 0;
  if (
    !Number.isSafeInteger(afterEventCursor) ||
    afterEventCursor < 0 ||
    afterEventCursor > events.length
  ) {
    throw new Error(
      `invalid session transcript event cursor ${afterEventCursor} for ${normalizedSessionKey} with ${events.length} event(s)`,
    );
  }
  const selectedEvents = events.slice(afterEventCursor);
  if (selectedEvents.length === 0 && options.allowEmpty === true) {
    return emptySessionTranscriptSummary(events.length);
  }
  return summarizeSessionTranscriptEvents(selectedEvents, normalizedSessionKey, events.length);
}

export {
  createSession,
  readEffectiveTools,
  readRawQaSessionStore,
  readSessionTranscriptSummary,
  readSkillStatus,
  seedQaSessionTranscript,
};
