/**
 * Adapts Codex runtime events to the host-owned trajectory recorder.
 */
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { attemptTerminal, type EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { flattenCodexDynamicToolFunctions, type CodexDynamicToolSpec } from "./protocol.js";

type CodexPromptSubmittedData = {
  threadId: string;
  turnId: string;
  prompt: string;
  imagesCount: number;
};

/** Runtime trajectory recorder used by Codex run attempts and event projectors. */
export type CodexTrajectoryRecorder = {
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  recordToolResult: (data: Record<string, unknown>) => void;
  recordPromptSubmitted: (
    data: CodexPromptSubmittedData,
    origin?: NonNullable<EmbeddedRunAttemptParams["inputProvenance"]>,
  ) => void;
  flush: () => Promise<void>;
};

type CodexTrajectoryInit = {
  attempt: EmbeddedRunAttemptParams;
  cwd: string;
  developerInstructions?: string;
  prompt?: string;
  trajectoryRecorder?: CodexHostTrajectoryRecorder | null;
  tools?: CodexDynamicToolSpec[];
  env?: NodeJS.ProcessEnv;
  warn?: (message: string, fields: Record<string, unknown>) => void;
};

const INPUT_PROVENANCE_KINDS = new Set(["external_user", "inter_session", "internal_system"]);

export type CodexHostTrajectoryRecorder = {
  recordEvent: (type: string, data?: Record<string, unknown>) => void;
  recordToolResult: (data: Record<string, unknown>) => void;
  flush: () => Promise<void>;
};

/** Creates a trajectory recorder when trajectory capture is enabled for the environment. */
export function createCodexTrajectoryRecorder(
  params: CodexTrajectoryInit,
): CodexTrajectoryRecorder | null {
  const env = params.env ?? process.env;
  const enabled = parseTrajectoryEnabled(env);
  if (!enabled) {
    return null;
  }

  // The host owns SQLite target resolution and identity validation; it hands
  // back a recorder only for a committed session row. Re-deriving that here
  // from a session-file string silently drops every capture once the host
  // stops emitting the legacy `sqlite:` marker.
  if (!params.trajectoryRecorder) {
    params.warn?.("codex trajectory capture requires the SQLite host recorder", {
      sessionId: params.attempt.sessionId,
      reason: "sqlite-recorder-unavailable",
    });
    return null;
  }
  const recorder = params.trajectoryRecorder;

  return {
    recordEvent: (type, data) => {
      recorder.recordEvent(type, data);
    },
    recordToolResult: (data) => {
      recorder.recordToolResult(data);
    },
    recordPromptSubmitted: (data, origin) => {
      const projectedOrigin = projectInputProvenance(origin);
      recorder.recordEvent("prompt.submitted", {
        ...data,
        ...(projectedOrigin ? { origin: projectedOrigin } : {}),
      });
    },
    flush: async () => {
      await recorder.flush();
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
          parameters: tool.inputSchema,
        },
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function projectInputProvenance(provenance: unknown): Record<string, string> | undefined {
  if (!provenance || typeof provenance !== "object") {
    return undefined;
  }
  const record = provenance as Record<string, unknown>;
  if (typeof record.kind !== "string" || !INPUT_PROVENANCE_KINDS.has(record.kind)) {
    return undefined;
  }
  // The host recorder owns persistence pseudonymization. This adapter only
  // projects recognized provenance fields across the runtime boundary.
  const sanitized: Record<string, string> = { kind: record.kind };
  for (const key of [
    "originSessionId",
    "sourceSessionKey",
    "sourceChannel",
    "sourceTool",
  ] as const) {
    const value = record[key];
    if (typeof value === "string") {
      sanitized[key] = value;
    }
  }
  return sanitized;
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
