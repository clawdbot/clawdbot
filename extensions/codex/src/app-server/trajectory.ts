/**
 * Records optional Codex runtime trajectory sidecars with bounded, redacted
 * context and completion events.
 */
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveUserPath } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  appendRegularFile,
  resolveRegularFileAppendFlags,
} from "openclaw/plugin-sdk/security-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveCodexLocalRuntimeAttribution } from "./local-runtime-attribution.js";
import { flattenCodexDynamicToolFunctions, type CodexDynamicToolSpec } from "./protocol.js";

/** Runtime trajectory recorder used by Codex run attempts and event projectors. */
export type CodexTrajectoryRecorder = {
  filePath: string;
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
};

type CodexTrajectoryInit = {
  attempt: EmbeddedRunAttemptParams;
  cwd: string;
  developerInstructions?: string;
  prompt?: string;
  tools?: CodexDynamicToolSpec[];
  env?: NodeJS.ProcessEnv;
};

const SENSITIVE_FIELD_RE = /(?:authorization|cookie|credential|key|password|passwd|secret|token)/iu;
const PRIVATE_PAYLOAD_FIELD_RE = /(?:image|screenshot|attachment|fileData|dataUri)/iu;
const AUTHORIZATION_VALUE_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9+/._~=-]{8,}/giu;
const JWT_VALUE_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;
const COOKIE_PAIR_RE = /\b([A-Za-z][A-Za-z0-9_.-]{1,64})=([A-Za-z0-9+/._~%=-]{16,})(?=;|\s|$)/gu;
const TRAJECTORY_RUNTIME_FILE_MAX_BYTES = 50 * 1024 * 1024;
const TRAJECTORY_RUNTIME_EVENT_MAX_BYTES = 256 * 1024;
const TRAJECTORY_RUNTIME_OVERSIZE_PRESERVED_DATA_KEYS = ["usage", "promptCache"] as const;

type CodexTrajectoryOpenFlagConstants = Pick<
  typeof nodeFs.constants,
  "O_APPEND" | "O_CREAT" | "O_TRUNC" | "O_WRONLY"
> &
  Partial<Pick<typeof nodeFs.constants, "O_NOFOLLOW">>;

/** Resolves secure append flags for trajectory runtime files. */
export function resolveCodexTrajectoryAppendFlags(
  constants: CodexTrajectoryOpenFlagConstants = nodeFs.constants,
): number {
  return resolveRegularFileAppendFlags(constants);
}

/** Resolves secure create/truncate flags for trajectory pointer files. */
export function resolveCodexTrajectoryPointerFlags(
  constants: CodexTrajectoryOpenFlagConstants = nodeFs.constants,
): number {
  const noFollow = constants.O_NOFOLLOW;
  return (
    constants.O_CREAT |
    constants.O_TRUNC |
    constants.O_WRONLY |
    (typeof noFollow === "number" ? noFollow : 0)
  );
}

async function safeAppendTrajectoryFile(filePath: string, line: string): Promise<void> {
  await appendRegularFile({
    filePath,
    content: line,
    maxFileBytes: TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
    rejectSymlinkParents: true,
  });
}

function boundedTrajectoryLine(event: Record<string, unknown>): string | undefined {
  const line = JSON.stringify(event);
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) {
    return `${line}\n`;
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
  const buildTruncatedLine = (includeDroppedFields: boolean): string | undefined => {
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
    const truncated = JSON.stringify({ ...event, data });
    if (Buffer.byteLength(truncated, "utf8") <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) {
      return `${truncated}\n`;
    }
    return undefined;
  };

  let best = buildTruncatedLine(true) ?? buildTruncatedLine(false);
  if (!best) {
    return undefined;
  }

  for (const key of TRAJECTORY_RUNTIME_OVERSIZE_PRESERVED_DATA_KEYS) {
    if (!Object.hasOwn(originalData, key)) {
      continue;
    }
    preservedDataKeys.add(key);
    const next = buildTruncatedLine(true) ?? buildTruncatedLine(false);
    if (next) {
      best = next;
      continue;
    }
    preservedDataKeys.delete(key);
  }
  return best;
}

function resolveTrajectoryPointerFilePath(sessionFile: string): string {
  return sessionFile.endsWith(".jsonl")
    ? `${sessionFile.slice(0, -".jsonl".length)}.trajectory-path.json`
    : `${sessionFile}.trajectory-path.json`;
}

function writeTrajectoryPointerBestEffort(params: {
  filePath: string;
  sessionFile: string;
  sessionId: string;
}): void {
  const pointerPath = resolveTrajectoryPointerFilePath(params.sessionFile);
  try {
    const pointerDir = path.resolve(path.dirname(pointerPath));
    if (nodeFs.lstatSync(pointerDir).isSymbolicLink()) {
      return;
    }
    try {
      if (nodeFs.lstatSync(pointerPath).isSymbolicLink()) {
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return;
      }
    }
    const fd = nodeFs.openSync(pointerPath, resolveCodexTrajectoryPointerFlags(), 0o600);
    try {
      nodeFs.writeFileSync(
        fd,
        `${JSON.stringify(
          {
            traceSchema: "openclaw-trajectory-pointer",
            schemaVersion: 1,
            sessionId: params.sessionId,
            runtimeFile: params.filePath,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      nodeFs.fchmodSync(fd, 0o600);
    } finally {
      nodeFs.closeSync(fd);
    }
  } catch {
    // Pointer files are best-effort; the runtime sidecar itself is authoritative.
  }
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

  const filePath = resolveTrajectoryFilePath({
    env,
    sessionFile: params.attempt.sessionFile,
    sessionId: params.attempt.sessionId,
  });
  const ready = fs
    .mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
    .catch(() => undefined);
  writeTrajectoryPointerBestEffort({
    filePath,
    sessionFile: params.attempt.sessionFile,
    sessionId: params.attempt.sessionId,
  });
  let queue = Promise.resolve();
  let seq = 0;
  const attribution = resolveCodexLocalRuntimeAttribution(params.attempt);

  return {
    filePath,
    recordEvent: (type, data) => {
      const event = {
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
      };
      const line = boundedTrajectoryLine(event);
      if (!line) {
        return;
      }
      queue = queue
        .then(() => ready)
        .then(() => safeAppendTrajectoryFile(filePath, line))
        .catch(() => undefined);
    },
    flush: async () => {
      await queue;
    },
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
  recorder.recordEvent("model.completed", {
    threadId: params.threadId,
    turnId: params.turnId,
    timedOut: params.timedOut,
    yieldDetected: params.yieldDetected ?? false,
    aborted: params.result.aborted,
    promptError: normalizeCodexTrajectoryError(params.result.promptError),
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

function resolveTrajectoryFilePath(params: {
  env: NodeJS.ProcessEnv;
  sessionFile: string;
  sessionId: string;
}): string {
  const dirOverride = params.env.OPENCLAW_TRAJECTORY_DIR?.trim();
  if (dirOverride) {
    return resolveContainedPath(
      resolveUserPath(dirOverride),
      `${safeTrajectorySessionFileName(params.sessionId)}.jsonl`,
    );
  }
  return params.sessionFile.endsWith(".jsonl")
    ? `${params.sessionFile.slice(0, -".jsonl".length)}.trajectory.jsonl`
    : `${params.sessionFile}.trajectory.jsonl`;
}

function safeTrajectorySessionFileName(sessionId: string): string {
  const safe = sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  return /[A-Za-z0-9]/u.test(safe) ? safe : "session";
}

function resolveContainedPath(baseDir: string, fileName: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedFile = path.resolve(resolvedBase, fileName);
  const relative = path.relative(resolvedBase, resolvedFile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Trajectory file path escaped its configured directory");
  }
  return resolvedFile;
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
  // Trajectory files may be inspected outside the live process, so redact
  // credentials and private payloads before queueing the line for disk writes.
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
