/**
 * Records optional Codex runtime trajectory events with bounded, redacted
 * context and completion payloads.
 */
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { parseSqliteSessionFileMarker } from "openclaw/plugin-sdk/session-store-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { attemptTerminal, type EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { resolveCodexLocalRuntimeAttribution } from "./local-runtime-attribution.js";
import { flattenCodexDynamicToolFunctions, type CodexDynamicToolSpec } from "./protocol.js";

/** Runtime trajectory recorder used by Codex run attempts and event projectors. */
export type CodexTrajectoryRecorder = {
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
};

type CodexTrajectoryInit = {
  attempt: EmbeddedRunAttemptParams;
  cwd: string;
  developerInstructions?: string;
  prompt?: string;
  trajectoryRecorder?: CodexHostTrajectoryRecorder | null;
  trajectorySessionFile?: string;
  tools?: CodexDynamicToolSpec[];
  env?: NodeJS.ProcessEnv;
  warn?: (message: string, fields: Record<string, unknown>) => void;
};

const SENSITIVE_FIELD_RE = /(?:authorization|cookie|credential|key|password|passwd|secret|token)/iu;
const PRIVATE_PAYLOAD_FIELD_RE = /(?:image|screenshot|attachment|fileData|dataUri)/iu;
const AUTHORIZATION_VALUE_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9+/._~=-]{8,}/giu;
const JWT_VALUE_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;
const COOKIE_PAIR_RE = /\b([A-Za-z][A-Za-z0-9_.-]{1,64})=([A-Za-z0-9+/._~%=-]{16,})(?=;|\s|$)/gu;
const TRAJECTORY_RUNTIME_EVENT_MAX_BYTES = 256 * 1024;
const TRAJECTORY_RUNTIME_OVERSIZE_PRESERVED_DATA_KEYS = ["usage", "promptCache"] as const;

type CodexTrajectorySink = {
  flush: () => Promise<void>;
  write: (event: CodexTrajectoryEvent) => void;
};

export type CodexHostTrajectoryRecorder = {
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
};

type CodexTrajectoryEvent = Record<string, unknown> & {
  data?: Record<string, unknown>;
  type: string;
};

function boundedTrajectoryEvent(event: Record<string, unknown>): CodexTrajectoryEvent | undefined {
  const line = JSON.stringify(event);
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) {
    return event as CodexTrajectoryEvent;
  }

  const originalData =
    event.data && typeof event.data === "object" && !Array.isArray(event.data)
      ? (event.data as Record<string, unknown>)
      : {};
  const originalDataKeys = Object.keys(originalData);
  const preservedDataKeys = new Set<string>();
  const baseData = {
    truncated: true,
    originalBytes: bytes,
    limitBytes: TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
    reason: "trajectory-event-size-limit",
  };
  const buildTruncatedEvent = (includeDroppedFields: boolean): CodexTrajectoryEvent | undefined => {
    const data: Record<string, unknown> = { ...baseData };
    for (const key of TRAJECTORY_RUNTIME_OVERSIZE_PRESERVED_DATA_KEYS) {
      if (preservedDataKeys.has(key)) {
        data[key] = originalData[key];
      }
    }
    if (includeDroppedFields) {
      const droppedFields = originalDataKeys.filter((key) => !preservedDataKeys.has(key));
      if (droppedFields.length > 0) {
        data.droppedFields = droppedFields;
      }
    }
    const truncatedEvent = { ...event, data };
    const truncated = JSON.stringify(truncatedEvent);
    if (Buffer.byteLength(truncated, "utf8") <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) {
      return truncatedEvent as CodexTrajectoryEvent;
    }
    return undefined;
  };

  let best = buildTruncatedEvent(true) ?? buildTruncatedEvent(false);
  if (!best) {
    return undefined;
  }

  for (const key of TRAJECTORY_RUNTIME_OVERSIZE_PRESERVED_DATA_KEYS) {
    if (!Object.hasOwn(originalData, key)) {
      continue;
    }
    preservedDataKeys.add(key);
    const next = buildTruncatedEvent(true) ?? buildTruncatedEvent(false);
    if (next) {
      best = next;
      continue;
    }
    preservedDataKeys.delete(key);
  }
  return best;
}

function createCodexHostTrajectorySink(params: {
  recorder: CodexHostTrajectoryRecorder;
}): CodexTrajectorySink {
  return {
    write: (event) => {
      params.recorder.recordEvent(event.type, event.data);
    },
    flush: async () => {
      await params.recorder.flush();
    },
  };
}

/** Creates a trajectory recorder when trajectory capture is enabled for the environment. */
export function createCodexTrajectoryRecorder(
  params: CodexTrajectoryInit,
): CodexTrajectoryRecorder | null {
  const env = params.env ?? process.env;
  const enabled = parseTrajectoryEnabled(env);
  if (!enabled) {
    return null;
  }

  const sessionFile = params.trajectorySessionFile ?? params.attempt.sessionFile;
  const sqliteMarker = parseSqliteSessionFileMarker(sessionFile);
  if (!sqliteMarker || sqliteMarker.sessionId !== params.attempt.sessionId) {
    params.warn?.("codex trajectory capture requires a matching SQLite session target", {
      sessionId: params.attempt.sessionId,
      reason: sqliteMarker ? "session-id-mismatch" : "non-sqlite-session-target",
    });
    return null;
  }
  if (!params.trajectoryRecorder) {
    params.warn?.("codex trajectory capture requires the SQLite host recorder", {
      sessionId: params.attempt.sessionId,
      reason: "sqlite-recorder-unavailable",
    });
    return null;
  }
  const sink = createCodexHostTrajectorySink({ recorder: params.trajectoryRecorder });
  let seq = 0;
  const attribution = resolveCodexLocalRuntimeAttribution(params.attempt);

  return {
    recordEvent: (type, data) => {
      const event = boundedTrajectoryEvent({
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: params.attempt.sessionId,
        source: "runtime",
        type,
        ts: new Date().toISOString(),
        seq: (seq += 1),
        sourceSeq: seq,
        sessionId: params.attempt.sessionId,
        sessionKey: params.attempt.sessionKey,
        runId: params.attempt.runId,
        workspaceDir: params.cwd,
        provider: attribution.provider,
        modelId: params.attempt.modelId,
        modelApi: attribution.api,
        data: data ? sanitizeValue(data) : undefined,
      });
      if (event) {
        sink.write(event);
      }
    },
    flush: sink.flush,
  };
}

/** Records compiled prompt/tool context at the start of a Codex runtime attempt. */
export function recordCodexTrajectoryContext(
  recorder: CodexTrajectoryRecorder | null,
  params: CodexTrajectoryInit,
): void {
  if (!recorder) {
    return;
  }
  recorder.recordEvent("context.compiled", {
    systemPrompt: params.developerInstructions,
    prompt: params.prompt ?? params.attempt.prompt,
    imagesCount: params.attempt.images?.length ?? 0,
    tools: toTrajectoryToolDefinitions(params.tools),
  });
}

/** Records final Codex model completion metadata and assistant snapshots. */
export function recordCodexTrajectoryCompletion(
  recorder: CodexTrajectoryRecorder | null,
  params: {
    attempt: EmbeddedRunAttemptParams;
    result: EmbeddedRunAttemptResult;
    threadId: string;
    turnId: string;
    timedOut: boolean;
    yieldDetected?: boolean;
  },
): void {
  if (!recorder) {
    return;
  }
  const terminal = attemptTerminal.project(params.result.terminal);
  recorder.recordEvent("model.completed", {
    threadId: params.threadId,
    turnId: params.turnId,
    timedOut: params.timedOut,
    yieldDetected: params.yieldDetected ?? false,
    aborted: terminal.aborted,
    promptError: normalizeCodexTrajectoryError(terminal.promptError),
    usage: params.result.attemptUsage,
    assistantTexts: params.result.assistantTexts,
    messagesSnapshot: params.result.messagesSnapshot,
  });
}

function parseTrajectoryEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.OPENCLAW_TRAJECTORY?.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  return true;
}

function toTrajectoryToolDefinitions(
  tools: readonly CodexDynamicToolSpec[] | undefined,
): Array<{ name: string; description?: string; parameters?: unknown }> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }
  return flattenCodexDynamicToolFunctions(tools)
    .flatMap((tool) => {
      const name = tool.name?.trim();
      if (!name) {
        return [];
      }
      return [
        {
          name,
          description: tool.description,
          parameters: sanitizeValue(tool.inputSchema),
        },
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function sanitizeValue(value: unknown, depth = 0, key = ""): unknown {
  // Trajectory exports may leave the live process, so redact credentials and
  // private payloads before passing events to the SQLite host recorder.
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (SENSITIVE_FIELD_RE.test(key)) {
      return "<redacted>";
    }
    if (value.startsWith("data:") && value.length > 256) {
      return `<redacted data-uri ${value.slice(0, value.indexOf(",")).length} chars>`;
    }
    if (PRIVATE_PAYLOAD_FIELD_RE.test(key) && value.length > 256) {
      return "<redacted payload>";
    }
    const redacted = redactSensitiveString(value);
    return redacted.length > 20_000 ? `${truncateUtf16Safe(redacted, 20_000)}…` : redacted;
  }
  if (depth >= 6) {
    return "<truncated>";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => sanitizeValue(entry, depth + 1, key));
  }
  if (typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [keyLocal, child] of Object.entries(value).slice(0, 100)) {
      next[keyLocal] = sanitizeValue(child, depth + 1, keyLocal);
    }
    return next;
  }
  return JSON.stringify(value);
}

function redactSensitiveString(value: string): string {
  return value
    .replace(AUTHORIZATION_VALUE_RE, "$1 <redacted>")
    .replace(JWT_VALUE_RE, "<redacted-jwt>")
    .replace(COOKIE_PAIR_RE, "$1=<redacted>");
}

/** Converts arbitrary prompt errors into trajectory-safe text. */
export function normalizeCodexTrajectoryError(value: unknown): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "Unknown error";
  }
}
