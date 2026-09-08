import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import {
  getConversationSession,
  normalizeSessionDeliveryState,
  patchSessionEntry,
} from "../../plugin-sdk/session-store-runtime.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { tryFastAbortFromMessage } from "./abort.js";
import { handleStopCommand } from "./commands-session-abort.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";
import { clearSessionQueues, enqueueFollowupRun, getFollowupQueueDepth } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

const dirs = createSuiteTempRootTracker({ prefix: "openclaw-stop-owner-" });
const sessionKey = "agent:main:slack:group:g12345678";

beforeAll(() => dirs.setup());
afterAll(() => dirs.cleanup());
afterEach(() => {
  clearSessionQueues([sessionKey]);
  testing.resetReplyRunRegistry();
});

async function setupStop() {
  const root = await dirs.make("case");
  const storePath = path.join(root, "sessions.json");
  const cfg = { session: { store: storePath }, commands: { allowFrom: { "*": ["*"] } } };
  const entry = { sessionId: "session-a", updatedAt: Date.now() };
  await replaceSessionEntry({ storePath, sessionKey }, entry);
  const ctx = buildTestCtx({
    Body: "/stop",
    CommandBody: "/stop",
    RawBody: "/stop",
    Provider: "slack",
    Surface: "slack",
    From: "slack:U12345678",
    To: "slack:G12345678",
    SenderId: "U12345678",
    CommandSource: "native",
    CommandAuthorized: true,
    SessionKey: "slack:slash:U12345678",
    CommandTargetSessionKey: sessionKey,
  });
  const isCommandTargetCurrent = () =>
    loadSessionEntry({ storePath, sessionKey })?.sessionId === entry.sessionId;
  const params: HandleCommandsParams = {
    cfg,
    ctx,
    command: {
      commandBodyNormalized: "/stop",
      rawBodyNormalized: "/stop",
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "U12345678",
      channel: "slack",
      surface: "slack",
      ownerList: [],
    },
    agentId: "main",
    directives: parseInlineSessionDirectives(""),
    elevated: { enabled: false, allowed: false, failures: [] },
    sessionKey: ctx.SessionKey ?? "",
    sessionStore: { [sessionKey]: entry },
    storePath,
    workspaceDir: root,
    defaultGroupActivation: () => "always",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedBlockStreamingBreak: "text_end",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-test",
    contextTokens: 1000,
    isGroup: true,
    opts: { isCommandTargetCurrent },
  };
  return { cfg, ctx, entry, params, storePath, isCommandTargetCurrent };
}

describe.each(["fast", "command"] as const)("%s Stop current owner", (pathKind) => {
  it("retires an idle MCP runtime on explicit Stop", async () => {
    const state = await setupStop();
    const { getOrCreateSessionMcpRuntime } =
      await import("../../agents/agent-bundle-mcp-manager.test-support.js");
    const { getSessionMcpRuntimeManagerForTesting } =
      await import("../../agents/agent-bundle-mcp-manager-api.js");
    const manager = getSessionMcpRuntimeManagerForTesting();
    try {
      await getOrCreateSessionMcpRuntime({
        sessionId: state.entry.sessionId,
        sessionKey,
        workspaceDir: state.params.workspaceDir,
        cfg: { mcp: { servers: {} } },
        manifestRegistry: { plugins: [] },
      });
      if (pathKind === "fast") {
        await tryFastAbortFromMessage({
          ctx: state.ctx,
          cfg: state.cfg,
          isCommandTargetCurrent: state.isCommandTargetCurrent,
        });
      } else {
        await handleStopCommand(state.params, true);
      }
      expect(manager.peekSession({ sessionId: state.entry.sessionId })).toBeUndefined();
    } finally {
      await manager.disposeAll();
    }
  });

  it("stops the selected agent's global session in an explicit roster", async () => {
    const state = await setupStop();
    const agentId = "selected";
    const globalKey = "global";
    const storePath = path.join(
      state.params.workspaceDir,
      "agents",
      agentId,
      "sessions",
      "sessions.json",
    );
    const cfg = {
      ...state.cfg,
      agents: { ownership: "explicit" as const, entries: { other: {}, [agentId]: {} } },
      session: {
        scope: "global" as const,
        store: path.join(
          state.params.workspaceDir,
          "agents",
          "{agentId}",
          "sessions",
          "sessions.json",
        ),
      },
    };
    const scope = { agentId, storePath, sessionKey: globalKey };
    await replaceSessionEntry(scope, state.entry);
    const ctx = { ...state.ctx, AgentId: agentId, CommandTargetSessionKey: globalKey };
    const isCommandTargetCurrent = () =>
      loadSessionEntry(scope)?.sessionId === state.entry.sessionId;
    const operation = createReplyOperation({
      sessionKey: globalKey,
      sessionId: state.entry.sessionId,
      resetTriggered: false,
    });
    operation.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
    try {
      const result = await (pathKind === "fast"
        ? tryFastAbortFromMessage({ cfg, ctx, isCommandTargetCurrent })
        : handleStopCommand(
            {
              ...state.params,
              cfg,
              ctx,
              agentId,
              sessionKey: globalKey,
              sessionStore: { [globalKey]: state.entry },
              storePath,
              opts: { isCommandTargetCurrent },
            },
            true,
          ));
      expect(operation.abortSignal.aborted).toBe(true);
      expect(result).toMatchObject(
        pathKind === "fast"
          ? { handled: true, aborted: true }
          : { shouldContinue: false, reply: { text: "⚙️ Agent was aborted." } },
      );
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: state.entry.sessionId,
        abortedLastRun: true,
      });
    } finally {
      operation.complete();
      clearSessionQueues([globalKey]);
    }
  });

  it("does not reclaim a conversation reassigned after abort preparation", async () => {
    const state = await setupStop();
    const nextKey = `${sessionKey}:thread:123.456`;
    const address = {
      agentId: "main",
      storePath: state.storePath,
      channel: "slack",
      accountId: "default",
      kind: "group" as const,
      peerId: "g12345678",
      threadId: "123.456",
    };
    const delivery = normalizeSessionDeliveryState({
      context: {
        channel: "slack",
        accountId: "default",
        to: "group:g12345678",
        threadId: "123.456",
      },
    });
    await replaceSessionEntry(
      { storePath: state.storePath, sessionKey },
      { ...state.entry, updatedAt: 100, chatType: "group", delivery },
    );
    const operation = createReplyOperation({
      sessionKey,
      sessionId: state.entry.sessionId,
      resetTriggered: false,
    });
    operation.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
    let reassigned = false;
    state.isCommandTargetCurrent = () => {
      const current = getConversationSession(address);
      if (
        !reassigned &&
        operation.abortSignal.aborted &&
        (pathKind === "fast" || state.params.sessionStore?.[sessionKey]?.abortedLastRun === true)
      ) {
        reassigned = true;
        // A separate synchronous writer commits while abort's prepared patch yields.
        queueMicrotask(() => {
          replaceSessionEntrySync(
            { storePath: state.storePath, sessionKey: nextKey },
            { sessionId: "session-b", updatedAt: 200, chatType: "group", delivery },
          );
        });
      }
      return current?.sessionKey === sessionKey;
    };
    state.params.opts = { isCommandTargetCurrent: state.isCommandTargetCurrent };
    const failure = await (
      pathKind === "fast" ? tryFastAbortFromMessage(state) : handleStopCommand(state.params, true)
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(operation.abortSignal.aborted).toBe(true);
    expect(reassigned).toBe(true);
    expect(getConversationSession(address)).toEqual({
      sessionKey: nextKey,
      sessionId: "session-b",
    });
    expect(loadSessionEntry({ storePath: state.storePath, sessionKey })?.abortedLastRun).not.toBe(
      true,
    );
    if (failure) {
      expect(failure).toMatchObject({
        message: "The selected session changed before it could be stopped.",
      });
    }
    operation.complete();
  });

  it("skips stale abort bookkeeping after waiting for a replacement writer", async () => {
    const state = await setupStop();
    const entered = createDeferred();
    const release = createDeferred();
    const writer = patchSessionEntry({
      storePath: state.storePath,
      sessionKey,
      update: async () => {
        entered.resolve();
        await release.promise;
        return { sessionId: "session-b", updatedAt: Date.now() };
      },
    });
    await entered.promise;
    const operation = createReplyOperation({
      sessionKey,
      sessionId: "session-a",
      resetTriggered: false,
    });
    operation.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
    const stopping =
      pathKind === "fast" ? tryFastAbortFromMessage(state) : handleStopCommand(state.params, true);
    expect(operation.abortSignal.aborted).toBe(true);
    release.resolve();
    await writer;
    await stopping;
    expect(loadSessionEntry({ storePath: state.storePath, sessionKey })).toMatchObject({
      sessionId: "session-b",
    });
    expect(loadSessionEntry({ storePath: state.storePath, sessionKey })?.abortedLastRun).toBe(
      false,
    );
    operation.complete();
  });

  it("completes cancellation when its own abort releases the live publisher", async () => {
    const state = await setupStop();
    const operation = createReplyOperation({
      sessionKey,
      sessionId: "session-a",
      resetTriggered: false,
    });
    operation.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
    state.isCommandTargetCurrent = () => !operation.abortSignal.aborted;
    state.params.opts = { isCommandTargetCurrent: state.isCommandTargetCurrent };
    const result = await (pathKind === "fast"
      ? tryFastAbortFromMessage(state)
      : handleStopCommand(state.params, true));
    expect(operation.abortSignal.aborted).toBe(true);
    expect(result).toMatchObject(
      pathKind === "fast" ? { handled: true, aborted: true } : { shouldContinue: false },
    );
    expect(
      loadSessionEntry({ storePath: state.storePath, sessionKey })?.abortedLastRun,
    ).toBeUndefined();
    operation.complete();
  });

  it("preserves a replacement run and its queued input after dispatch handoff", async () => {
    const state = await setupStop();
    const admitted = createReplyOperation({
      sessionKey,
      sessionId: "session-a",
      resetTriggered: false,
    });
    const dispatch = createDeferred();
    expect(state.isCommandTargetCurrent()).toBe(true);
    const pending = dispatch.promise.then(async () =>
      pathKind === "fast" ? tryFastAbortFromMessage(state) : handleStopCommand(state.params, true),
    );
    admitted.complete();
    await replaceSessionEntry(
      { storePath: state.storePath, sessionKey },
      {
        sessionId: "session-b",
        updatedAt: Date.now(),
      },
    );
    const replacement = createReplyOperation({
      sessionKey,
      sessionId: "session-b",
      resetTriggered: false,
    });
    replacement.attachBackend({ kind: "embedded", cancel: () => {}, isStreaming: () => true });
    enqueueFollowupRun(
      sessionKey,
      createQueueTestRun({ prompt: "next conversation" }),
      { mode: "collect", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
      "none",
    );
    dispatch.resolve();
    const result = await pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(replacement.abortSignal.aborted).toBe(false);
    expect(result).toBeInstanceOf(Error);
    expect(getFollowupQueueDepth(sessionKey)).toBe(1);
    expect(
      loadSessionEntry({ storePath: state.storePath, sessionKey })?.abortedLastRun,
    ).toBeUndefined();
    replacement.complete();
  });
});
