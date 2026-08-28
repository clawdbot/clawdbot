/** Real embedded subscriber/catalog executor shared by bridge lifecycle regressions. */
import { createDiagnosticEmbeddedRunOwner } from "../logging/diagnostic-run-activity.js";
import { createCodeModeTools } from "./code-mode.js";
import { prepareEmbeddedAttemptStream } from "./embedded-agent-runner/run/attempt-stream-prepare.js";
import type { EmbeddedRunAttemptParams } from "./embedded-agent-runner/run/types.js";
import { clearActiveEmbeddedRun } from "./embedded-agent-runner/runs.js";
import { createStubSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { clearToolSearchCatalog, createToolSearchCatalogRef } from "./tool-search.js";

export function createSubscribedCodeModeHarness(params: {
  name: string;
  onBlockReplyFlush?: () => Promise<void>;
  onToolResult?: EmbeddedRunAttemptParams["onToolResult"];
  onBlockReply?: EmbeddedRunAttemptParams["onBlockReply"];
  onPartialReply?: EmbeddedRunAttemptParams["onPartialReply"];
  timeoutMs?: number;
  observeToolTerminal?: EmbeddedRunAttemptParams["observeToolTerminal"];
  onToolStreamBoundary?: EmbeddedRunAttemptParams["onToolStreamBoundary"];
}) {
  const runId = `run-code-mode-${params.name}`;
  const sessionId = `session-code-mode-${params.name}`;
  const sessionKey = `agent:main:${params.name}`;
  const config = {
    tools: { codeMode: { enabled: true, timeoutMs: params.timeoutMs ?? 1_500 } },
  } as never;
  const catalogRef = createToolSearchCatalogRef();
  const runAbortController = new AbortController();
  const { session, emit } = createStubSessionHarness();
  const activeSession = Object.assign(session, {
    agent: { hasQueuedMessages: () => false },
    isStreaming: false,
    messages: [],
    pendingMessageCount: 0,
  });
  const stream = prepareEmbeddedAttemptStream({
    attempt: {
      config,
      runId,
      sessionId,
      sessionKey,
      onToolResult: params.onToolResult,
      observeToolTerminal: params.observeToolTerminal,
      onToolStreamBoundary: params.onToolStreamBoundary,
      onPartialReply: params.onPartialReply,
      blockReplyBreak: "message_end",
    } as never,
    activeSession: activeSession as never,
    hookRunner: undefined as never,
    hookAgentId: "main",
    diagnosticTrace: {} as never,
    diagnosticOwner: createDiagnosticEmbeddedRunOwner({ sessionId, sessionKey, runId }),
    clientToolCallSlots: [],
    toolSearchTargetTranscriptProjections: [],
    isReplaySafeTool: () => false,
    runAbortController,
    abortRun: () => runAbortController.abort(),
    markExternalAbort: () => undefined,
    getRunState: () => ({
      aborted: runAbortController.signal.aborted,
      promptError: undefined,
      timedOut: false,
      yieldDetected: false,
    }),
    hasDeliveredSourceReply: () => false,
    markSourceReplyDelivered: () => undefined,
    onBlockReply: params.onBlockReply,
    onBlockReplyFlush: params.onBlockReplyFlush,
    sandboxSessionKey: sessionKey,
    subscriptionToolTrust: {
      builtinToolNames: new Set(),
      replaySafeToolNames: new Set(),
      trustedLocalMediaToolNames: new Set(),
    },
  });
  const context = {
    config,
    runtimeConfig: config,
    sessionId,
    sessionKey,
    runId,
    catalogRef,
    abortSignal: runAbortController.signal,
    executeTool: stream.toolSearchCatalogExecutor,
  };
  return {
    ...context,
    emit,
    tools: createCodeModeTools(context),
    runAbortController,
    subscription: stream.subscription,
    dispose: () => {
      clearToolSearchCatalog(context);
      stream.subscription.unsubscribe();
      clearActiveEmbeddedRun(sessionId, stream.queueHandle, sessionKey);
    },
  };
}
