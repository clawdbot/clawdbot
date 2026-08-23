import "./runs.js";
import type { EmbeddedAgentQueueHandle } from "./run-state.js";

type RunHandle = EmbeddedAgentQueueHandle;

export function createEmbeddedRunHandle(
  overrides: {
    abort?: () => void;
    isAbortable?: boolean;
    isCompacting?: boolean;
    isStreaming?: boolean;
    isStopped?: () => boolean;
    messageInjection?: RunHandle["messageInjection"];
    runId?: string;
    queueMessage?: RunHandle["queueMessage"];
    supportsQueueMessageImages?: boolean;
    supportsTranscriptCommitWait?: boolean;
  } = {},
): RunHandle {
  // Minimal handle fixture with overrideable lifecycle probes for registry
  // behavior; individual tests supply queue/abort behavior when needed.
  const abort = overrides.abort ?? (() => {});
  return {
    runId: overrides.runId,
    queueMessage: overrides.queueMessage ?? (async () => {}),
    ...(overrides.messageInjection ? { messageInjection: overrides.messageInjection } : {}),
    isStreaming: () => overrides.isStreaming ?? true,
    ...(overrides.isStopped ? { isStopped: overrides.isStopped } : {}),
    ...(overrides.isAbortable !== undefined
      ? { isAbortable: () => overrides.isAbortable !== false }
      : {}),
    isCompacting: () => overrides.isCompacting ?? false,
    supportsQueueMessageImages: overrides.supportsQueueMessageImages,
    supportsTranscriptCommitWait: overrides.supportsTranscriptCommitWait,
    abort,
  };
}

type EmbeddedRunsTestApi = {
  persistForceClearedEmbeddedRunTerminalState(params: {
    sessionId: string;
    sessionKey: string;
    startedAt?: number;
    storePath: string;
    updatedAt: number;
  }): Promise<void>;
  resetActiveEmbeddedRuns(): void;
};

function getTestApi(): EmbeddedRunsTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.embeddedRunsTestApi")
  ];
  if (!api) {
    throw new Error("embedded runs test API is unavailable");
  }
  return api as EmbeddedRunsTestApi;
}

export const testing = getTestApi();
