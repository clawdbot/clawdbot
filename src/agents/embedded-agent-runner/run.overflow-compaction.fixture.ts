/**
 * Test fixtures for embedded-run overflow compaction scenarios.
 */
import type { ContextEngineSessionTarget } from "../../context-engine/types.js";
import { isAgentToolReplaySafe } from "../tool-replay-safety.js";
import { buildAttemptReplayMetadata } from "./run/incomplete-turn.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

const DEFAULT_OVERFLOW_ERROR_MESSAGE =
  "request_too_large: Request size exceeds model context window";

export function makeOverflowError(message: string = DEFAULT_OVERFLOW_ERROR_MESSAGE): Error {
  return new Error(message);
}

export function makeCompactionSuccess(params: {
  summary: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  sessionId?: string;
  sessionFile?: string;
  sessionTarget?: ContextEngineSessionTarget;
}) {
  return {
    ok: true as const,
    compacted: true as const,
    result: {
      summary: params.summary,
      ...(params.firstKeptEntryId ? { firstKeptEntryId: params.firstKeptEntryId } : {}),
      ...(params.tokensBefore !== undefined ? { tokensBefore: params.tokensBefore } : {}),
      ...(params.tokensAfter !== undefined ? { tokensAfter: params.tokensAfter } : {}),
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      ...(params.sessionFile !== undefined ? { sessionFile: params.sessionFile } : {}),
      ...(params.sessionTarget !== undefined ? { sessionTarget: params.sessionTarget } : {}),
    },
  };
}

export function makeAttemptResult(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  const toolMetas = (overrides.toolMetas ?? []).map((entry) =>
    Object.assign({}, entry, {
      replaySafe: entry.replaySafe ?? isAgentToolReplaySafe({ name: entry.toolName }),
    }),
  );
  const didSendViaMessagingTool = overrides.didSendViaMessagingTool ?? false;
  const messagingToolSentTexts = overrides.messagingToolSentTexts ?? [];
  const messagingToolSentMediaUrls = overrides.messagingToolSentMediaUrls ?? [];
  const messagingToolSentTargets = overrides.messagingToolSentTargets ?? [];
  const successfulCronAdds = overrides.successfulCronAdds;
  const acceptedSessionSpawns = overrides.acceptedSessionSpawns ?? [];
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: "test-session",
    assistantTexts: ["Hello!"],
    acceptedSessionSpawns,
    lastAssistant: undefined,
    currentAttemptCompletedAssistant:
      overrides.currentAttemptCompletedAssistant ?? overrides.currentAttemptAssistant,
    messagesSnapshot: [],
    replayMetadata:
      overrides.replayMetadata ??
      buildAttemptReplayMetadata({
        toolMetas,
        didSendViaMessagingTool,
        messagingToolSentTexts,
        messagingToolSentMediaUrls,
        messagingToolSentTargets,
        acceptedSessionSpawns,
        successfulCronAdds,
      }),
    itemLifecycle: {
      startedCount: 0,
      completedCount: 0,
      activeCount: 0,
    },
    didSendViaMessagingTool,
    messagingToolSentTexts,
    messagingToolSentMediaUrls,
    messagingToolSentTargets,
    cloudCodeAssistFormatError: false,
    ...overrides,
    toolMetas,
  };
}

type MockRunEmbeddedAttempt = {
  mockResolvedValueOnce: (value: EmbeddedRunAttemptResult) => unknown;
};

type MockCompactDirect = {
  mockResolvedValueOnce: (value: {
    ok: true;
    compacted: true;
    result: {
      summary: string;
      firstKeptEntryId?: string;
      tokensBefore?: number;
      tokensAfter?: number;
      sessionId?: string;
      sessionFile?: string;
      sessionTarget?: ContextEngineSessionTarget;
    };
  }) => unknown;
};

export function mockOverflowRetrySuccess(params: {
  runEmbeddedAttempt: MockRunEmbeddedAttempt;
  compactDirect: MockCompactDirect;
  overflowMessage?: string;
}) {
  const overflowError = makeOverflowError(params.overflowMessage);

  params.runEmbeddedAttempt.mockResolvedValueOnce(
    makeAttemptResult({ promptError: overflowError }),
  );
  params.runEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

  params.compactDirect.mockResolvedValueOnce(
    makeCompactionSuccess({
      summary: "Compacted session",
      firstKeptEntryId: "entry-5",
      tokensBefore: 150000,
    }),
  );

  return overflowError;
}

export function queueOverflowAttemptWithOversizedToolOutput(
  runEmbeddedAttempt: MockRunEmbeddedAttempt,
  overflowError: Error = makeOverflowError(),
): Error {
  runEmbeddedAttempt.mockResolvedValueOnce(
    makeAttemptResult({
      promptError: overflowError,
      messagesSnapshot: [
        {
          role: "toolResult",
          content: [{ type: "text", text: "x".repeat(80_000) }],
        } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
      ],
    }),
  );
  return overflowError;
}
