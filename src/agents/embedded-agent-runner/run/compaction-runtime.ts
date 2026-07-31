import type { resolveContextEngine } from "../../../context-engine/registry.js";
import { resolveCompactionSuccessorTranscript } from "../../../context-engine/types.js";
import { log } from "../logger.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";

type ContextEngine = Awaited<ReturnType<typeof resolveContextEngine>>;
type SessionPromptState = ReturnType<typeof createEmbeddedRunSessionPromptState>;

export function createEmbeddedRunCompactionRuntime(input: {
  runParams: PreparedEmbeddedRunInput["runParams"];
  contextEngine: ContextEngine;
  hookRunner: PreparedEmbeddedRunInput["hookRunner"];
  hookContext: PreparedEmbeddedRunInput["hookContext"];
  sessionPromptState: SessionPromptState;
}) {
  const { runParams: params, contextEngine, hookRunner, hookContext, sessionPromptState } = input;
  const resolveActiveHookContext = () => ({
    ...hookContext,
    sessionId: sessionPromptState.sessionId,
  });
  const adoptCompactionTranscript = async (
    compactResult: Awaited<ReturnType<ContextEngine["compact"]>>,
  ): Promise<string | undefined> => {
    const previousSessionId = sessionPromptState.sessionId;
    const nextSessionTarget = compactResult.result?.sessionTarget;
    const successor = resolveCompactionSuccessorTranscript(compactResult);
    await sessionPromptState.adoptSessionTarget(
      nextSessionTarget && successor.sessionId
        ? {
            ...nextSessionTarget,
            sessionId: nextSessionTarget.sessionId ?? successor.sessionId,
          }
        : nextSessionTarget,
    );
    if (
      !nextSessionTarget &&
      successor.sessionFile &&
      successor.sessionFile !== sessionPromptState.sessionFile
    ) {
      sessionPromptState.sessionFile = successor.sessionFile;
    }
    sessionPromptState.adoptSessionId(successor.sessionId);
    return successor.sessionId && successor.sessionId !== previousSessionId
      ? previousSessionId
      : undefined;
  };
  const onCompactionHookMessages = async (payload: {
    phase: "before" | "after";
    messages: string[];
  }) => {
    const messages = payload.messages.filter((message) => message.trim().length > 0);
    if (messages.length === 0) {
      return;
    }
    await params.onAgentEvent?.({
      stream: "compaction",
      data: {
        phase: payload.phase === "before" ? "start" : "end",
        ...(payload.phase === "after" ? { completed: true } : {}),
        messages,
      },
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
  };
  const runOwnsCompactionBeforeHook = async (reason: string) => {
    if (contextEngine.info.ownsCompaction !== true || !hookRunner?.hasHooks("before_compaction")) {
      return;
    }
    try {
      await hookRunner.runBeforeCompaction(
        { messageCount: -1, sessionFile: sessionPromptState.sessionFile },
        resolveActiveHookContext(),
      );
    } catch (error) {
      log.warn(`before_compaction hook failed during ${reason}: ${String(error)}`);
    }
  };
  const runOwnsCompactionAfterHook = async (
    reason: string,
    compactResult: Awaited<ReturnType<ContextEngine["compact"]>>,
    previousSessionId?: string,
  ) => {
    if (
      contextEngine.info.ownsCompaction !== true ||
      !compactResult.ok ||
      !compactResult.compacted ||
      !hookRunner?.hasHooks("after_compaction")
    ) {
      return;
    }
    try {
      await hookRunner.runAfterCompaction(
        {
          messageCount: -1,
          compactedCount: -1,
          tokenCount: compactResult.result?.tokensAfter,
          sessionFile:
            resolveCompactionSuccessorTranscript(compactResult).sessionFile ??
            sessionPromptState.sessionFile,
          ...(previousSessionId ? { previousSessionId } : {}),
        },
        resolveActiveHookContext(),
      );
    } catch (error) {
      log.warn(`after_compaction hook failed during ${reason}: ${String(error)}`);
    }
  };

  return {
    adoptCompactionTranscript,
    onCompactionHookMessages,
    runOwnsCompactionBeforeHook,
    runOwnsCompactionAfterHook,
  };
}
