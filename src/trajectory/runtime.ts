import fs from "node:fs";
import path from "node:path";
import { sanitizeDiagnosticPayload } from "../agents/payload-redaction.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "../agents/queued-file-writer.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import type { TrajectoryEvent, TrajectoryToolDefinition } from "./types.js";

type TrajectoryRuntimeInit = {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId: string;
  sessionKey?: string;
  sessionFile?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  writer?: QueuedFileWriter;
};

type TrajectoryRuntimeRecorder = {
  enabled: true;
  filePath: string;
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  flush: () => Promise<void>;
};

const writers = new Map<string, QueuedFileWriter>();
export const TRAJECTORY_RUNTIME_FILE_MAX_BYTES = 50 * 1024 * 1024;
export const TRAJECTORY_RUNTIME_EVENT_MAX_BYTES = 256 * 1024;
const MAX_TRAJECTORY_WRITERS = 100;

type TrajectoryPointerOpenFlagConstants = Pick<
  typeof fs.constants,
  "O_CREAT" | "O_TRUNC" | "O_WRONLY"
> &
  Partial<Pick<typeof fs.constants, "O_NOFOLLOW">>;

export function safeTrajectorySessionFileName(sessionId: string): string {
  const safe = sessionId.replaceAll(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  return /[A-Za-z0-9]/u.test(safe) ? safe : "session";
}

export function resolveTrajectoryPointerOpenFlags(
  constants: TrajectoryPointerOpenFlagConstants = fs.constants,
): number {
  const noFollow = constants.O_NOFOLLOW;
  return (
    constants.O_CREAT |
    constants.O_TRUNC |
    constants.O_WRONLY |
    (typeof noFollow === "number" ? noFollow : 0)
  );
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

export function resolveTrajectoryFilePath(params: {
  env?: NodeJS.ProcessEnv;
  sessionFile?: string;
  sessionId: string;
}): string {
  const env = params.env ?? process.env;
  const dirOverride = env.OPENCLAW_TRAJECTORY_DIR?.trim();
  if (dirOverride) {
    return resolveContainedPath(
      resolveUserPath(dirOverride),
      `${safeTrajectorySessionFileName(params.sessionId)}.jsonl`,
    );
  }
  if (!params.sessionFile) {
    return path.join(
      process.cwd(),
      `${safeTrajectorySessionFileName(params.sessionId)}.trajectory.jsonl`,
    );
  }
  return params.sessionFile.endsWith(".jsonl")
    ? `${params.sessionFile.slice(0, -".jsonl".length)}.trajectory.jsonl`
    : `${params.sessionFile}.trajectory.jsonl`;
}

export function resolveTrajectoryPointerFilePath(sessionFile: string): string {
  return sessionFile.endsWith(".jsonl")
    ? `${sessionFile.slice(0, -".jsonl".length)}.trajectory-path.json`
    : `${sessionFile}.trajectory-path.json`;
}

function writeTrajectoryPointerBestEffort(params: {
  filePath: string;
  sessionFile?: string;
  sessionId: string;
}): void {
  if (!params.sessionFile) {
    return;
  }
  const pointerPath = resolveTrajectoryPointerFilePath(params.sessionFile);
  try {
    const pointerDir = path.resolve(path.dirname(pointerPath));
    if (fs.lstatSync(pointerDir).isSymbolicLink()) {
      return;
    }
    try {
      if (fs.lstatSync(pointerPath).isSymbolicLink()) {
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return;
      }
    }
    const fd = fs.openSync(pointerPath, resolveTrajectoryPointerOpenFlags(), 0o600);
    try {
      fs.writeFileSync(
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
      fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Pointer files are best-effort; the runtime sidecar itself is authoritative.
  }
}

function trimTrajectoryWriterCache(): void {
  while (writers.size >= MAX_TRAJECTORY_WRITERS) {
    const oldestKey = writers.keys().next().value;
    if (!oldestKey) {
      return;
    }
    writers.delete(oldestKey);
  }
}

function truncateOversizedTrajectoryEvent(
  event: TrajectoryEvent,
  line: string,
): string | undefined {
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) {
    return line;
  }
  const truncated = safeJsonStringify({
    ...event,
    data: {
      truncated: true,
      originalBytes: bytes,
      limitBytes: TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
      reason: "trajectory-event-size-limit",
    },
  });
  if (truncated && Buffer.byteLength(truncated, "utf8") <= TRAJECTORY_RUNTIME_EVENT_MAX_BYTES) {
    return truncated;
  }
  return undefined;
}

export function toTrajectoryToolDefinitions(
  tools: ReadonlyArray<{ name?: string; description?: string; parameters?: unknown }>,
): TrajectoryToolDefinition[] {
  return tools
    .flatMap((tool) => {
      const name = tool.name?.trim();
      if (!name) {
        return [];
      }
      return [
        {
          name,
          description: tool.description,
          parameters: sanitizeDiagnosticPayload(tool.parameters),
        },
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function createTrajectoryRuntimeRecorder(
  params: TrajectoryRuntimeInit,
): TrajectoryRuntimeRecorder | null {
  const env = params.env ?? process.env;
  // Trajectory capture is now default-on. The env var remains as an explicit
  // override so operators can still disable recording with OPENCLAW_TRAJECTORY=0.
  const enabled = parseBooleanValue(env.OPENCLAW_TRAJECTORY) ?? true;
  if (!enabled) {
    return null;
  }

  const filePath = resolveTrajectoryFilePath({
    env,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
  });
  if (!params.writer) {
    trimTrajectoryWriterCache();
  }
  const writer =
    params.writer ??
    getQueuedFileWriter(writers, filePath, {
      maxFileBytes: TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
    });
  writeTrajectoryPointerBestEffort({
    filePath,
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
  });
  let seq = 0;
  const traceId = params.sessionId;

  return {
    enabled: true,
    filePath,
    recordEvent: (type, data) => {
      const event: TrajectoryEvent = {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId,
        source: "runtime",
        type,
        ts: new Date().toISOString(),
        seq: (seq += 1),
        sourceSeq: seq,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        workspaceDir: params.workspaceDir,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.modelApi,
        data: data ? (sanitizeDiagnosticPayload(data) as Record<string, unknown>) : undefined,
      };
      const line = safeJsonStringify(event);
      if (!line) {
        return;
      }
      const boundedLine = truncateOversizedTrajectoryEvent(event, line);
      if (!boundedLine) {
        return;
      }
      writer.write(`${boundedLine}\n`);
    },
    flush: async () => {
      await writer.flush();
      if (!params.writer) {
        writers.delete(filePath);
      }
    },
  };
}
