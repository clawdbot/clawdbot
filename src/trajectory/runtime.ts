import fs from "node:fs";
import path from "node:path";
import { sanitizeDiagnosticPayload } from "../agents/payload-redaction.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "../agents/queued-file-writer.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import {
  TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
  TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
  resolveTrajectoryPointerOpenFlags,
} from "./paths.js";
import type { TrajectoryEvent, TrajectoryToolDefinition } from "./types.js";

export {
  TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
  TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
  resolveTrajectoryPointerOpenFlags,
  safeTrajectorySessionFileName,
} from "./paths.js";

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
const MAX_TRAJECTORY_WRITERS = 100;

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
