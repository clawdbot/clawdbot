// Tests directive rejection through the shared resolver, finalizer, and diagnostic bus.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  onDiagnosticEvent,
  type DiagnosticMessageProcessedEvent,
} from "../../infra/diagnostic-events.js";
import {
  createDispatcher,
  diagnosticMocks,
  mocks,
  parseGenericThreadSessionInfo,
  resetPluginTtsAndThreadMocks,
  sessionBindingMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
  threadInfoMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { prepareReplyConversation } from "./prompt-session-context.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { buildTestCtx } from "./test-ctx.js";
import { createMockTypingController } from "./test-helpers.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let resetReplyRunRegistry: () => void;

const REJECTED_MODEL = "openai/REJECTED_PRIVATE_TOKEN";
const SESSION_KEY = "agent:main:session";
const cfg: OpenClawConfig = {
  diagnostics: { enabled: true },
  commands: { text: true },
  messages: { visibleReplies: "automatic" },
  agents: { defaults: { modelPolicy: { allow: ["anthropic/*"] } } },
};

function createDirectiveFixture() {
  const sessionEntry: SessionEntry = { sessionId: "session-1", updatedAt: 1 };
  const sessionStore = { [SESSION_KEY]: sessionEntry };
  const continueReply = vi.fn(async () => ({ text: "Agent reply." }));
  let messageId = 0;
  const dispatch = async (body: string) => {
    const runState: ReplyOperationRunState = {};
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Body: body,
      CommandBody: body,
      CommandAuthorized: true,
      From: "user1",
      To: "telegram:2000",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "direct",
      SessionKey: SESSION_KEY,
      MessageSid: String(++messageId),
    });
    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyOptions: { [REPLY_OPERATION_RUN_STATE]: runState },
      replyResolver: async (resolverCtx, resolverOpts) => {
        const finalizedCtx = finalizeInboundContext(resolverCtx);
        const result = await resolveReplyDirectives({
          ctx: finalizedCtx,
          cfg,
          agentId: "main",
          agentDir: "/tmp/main-agent",
          workspaceDir: "/tmp/workspace",
          agentCfg: cfg.agents?.defaults,
          sessionCtx: finalizedCtx,
          conversation: prepareReplyConversation({ ctx: finalizedCtx, sessionEntry }),
          sessionEntry,
          sessionStore,
          sessionKey: SESSION_KEY,
          sessionScope: "per-sender",
          isGroup: false,
          triggerBodyNormalized: body,
          resetTriggered: false,
          commandAuthorized: true,
          defaultProvider: "anthropic",
          defaultModel: "claude-opus-4-6",
          aliasIndex: { byAlias: new Map(), byKey: new Map() },
          provider: "anthropic",
          model: "claude-opus-4-6",
          hasResolvedHeartbeatModelOverride: false,
          typing: createMockTypingController(),
          preparedModelCatalog: {
            entries: [{ provider: "anthropic", id: "claude-opus-4-6", name: "Opus" }],
            routeVariants: [],
          },
          opts: resolverOpts,
        });
        return result.kind === "reply" ? result.reply : continueReply();
      },
    });
    return { runState, dispatcher };
  };
  return { dispatch, continueReply, sessionEntry };
}

describe("dispatchReplyFromConfig pre-run directive rejection", () => {
  let processedEvents: DiagnosticMessageProcessedEvent[];
  let unsubscribe: () => void;

  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
    const { testing } = await import("./reply-run-registry.test-support.js");
    resetReplyRunRegistry = () => testing.resetReplyRunRegistry();
  });

  beforeEach(() => {
    clearAgentHarnesses();
    resetReplyRunRegistry();
    setDiscordTestRegistry();
    resetInboundDedupe();
    resetPluginTtsAndThreadMocks();
    mocks.routeReply
      .mockReset()
      .mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
    threadInfoMocks.parseSessionThreadInfo
      .mockReset()
      .mockImplementation(parseGenericThreadSessionInfo);
    sessionBindingMocks.listBySession.mockReset().mockReturnValue([]);
    sessionBindingMocks.resolveByConversation.mockReset().mockReturnValue(null);
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.loadSessionStoreEntry
      .mockReset()
      .mockImplementation(() => sessionStoreMocks.currentEntry);
    sessionStoreMocks.readSessionEntry
      .mockReset()
      .mockImplementation(() => sessionStoreMocks.currentEntry);
    diagnosticMocks.logMessageProcessed.mockClear();
    diagnosticMocks.logMessageDispatchCompleted.mockClear();
    processedEvents = [];
    unsubscribe = onDiagnosticEvent((event) => {
      if (event.type === "message.processed") {
        processedEvents.push(event);
      }
    });
    diagnosticMocks.forwardToRealPipeline = true;
  });

  afterEach(() => {
    unsubscribe();
    diagnosticMocks.forwardToRealPipeline = false;
  });

  it.each([
    { body: `/model ${REJECTED_MODEL} -s`, reason: "model-selection-rejected" },
    { body: `please reply /model ${REJECTED_MODEL} -s`, reason: "session-directive-rejected" },
    { body: `/model ${REJECTED_MODEL} -s\n/think high`, reason: "session-directive-rejected" },
  ])("emits one safe skipped event for $body", async ({ body, reason }) => {
    const fixture = createDirectiveFixture();
    const { runState, dispatcher } = await fixture.dispatch(body);

    expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("is not allowed") }),
    );
    expect(fixture.continueReply).not.toHaveBeenCalled();
    expect(fixture.sessionEntry).toEqual({ sessionId: "session-1", updatedAt: 1 });
    expect(processedEvents).toEqual([
      expect.objectContaining({
        type: "message.processed",
        channel: "telegram",
        sessionKey: SESSION_KEY,
        messageId: "1",
        outcome: "skipped",
        reason,
      }),
    ]);
    expect(runState.preRunRejection).toBe(reason);
    expect(processedEvents[0]?.error).toBeUndefined();
    expect(JSON.stringify(processedEvents)).not.toContain(REJECTED_MODEL);
    for (const diagnostic of [
      diagnosticMocks.logMessageProcessed,
      diagnosticMocks.logMessageDispatchCompleted,
    ]) {
      expect(diagnostic).toHaveBeenCalledOnce();
      expect(diagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "skipped", reason }),
      );
      expect(diagnostic.mock.calls[0]?.[0].error).toBeUndefined();
    }
  });

  it("completes valid directives, ignored hints, and ordinary turns after a rejected turn", async () => {
    const fixture = createDirectiveFixture();
    await fixture.dispatch(`please reply /model ${REJECTED_MODEL} -s`);
    const bodies = [
      "/model anthropic/claude-opus-4-6 -s",
      "please reply /model anthropic/claude-opus-4-6 -s",
      "please reply\n/trace raw\n/reasoning on",
      "hello again",
    ];
    for (const body of bodies) {
      const { runState, dispatcher } = await fixture.dispatch(body);
      expect(runState.preRunRejection).toBeUndefined();
      expect(dispatcher.sendFinalReply).toHaveBeenCalledOnce();
    }
    expect(fixture.continueReply).toHaveBeenCalledTimes(3);
    expect(processedEvents.map(({ outcome, reason }) => ({ outcome, reason }))).toEqual([
      { outcome: "skipped", reason: "session-directive-rejected" },
      ...bodies.map(() => ({ outcome: "completed", reason: undefined })),
    ]);
    expect(fixture.sessionEntry.reasoningLevel).toBeUndefined();
    expect(fixture.sessionEntry.traceLevel).toBeUndefined();
  });

  it.each<{
    label: string;
    state: ReplyOperationRunState;
    failed?: true;
    outcome: string;
    reason?: string;
  }>([
    { label: "agent failure", state: {}, failed: true, outcome: "error" },
    {
      label: "queue cap",
      state: { admission: { status: "skipped", reason: "queue-cap" } },
      outcome: "skipped",
      reason: "queue-cap",
    },
    {
      label: "injection abort",
      state: { messageInjectionAborted: true },
      outcome: "skipped",
      reason: "reply_operation_aborted",
    },
    {
      label: "question refusal",
      state: { admission: { status: "skipped", reason: "question-response-refused" } },
      outcome: "error",
      reason: "question-response-refused",
    },
  ])(
    "preserves the terminal $label over a rejection fact",
    async ({ state, failed, outcome, reason }) => {
      const runState: ReplyOperationRunState = {
        ...state,
        preRunRejection: "session-directive-rejected",
      };
      await dispatchReplyFromConfig({
        ctx: buildTestCtx({ Body: "hello", SessionKey: SESSION_KEY }),
        cfg,
        dispatcher: createDispatcher(),
        replyOptions: { [REPLY_OPERATION_RUN_STATE]: runState },
        replyResolver: async (_ctx, opts) => {
          if (failed) {
            opts?.onAgentRunTerminalOutcome?.("failed");
          }
          return { text: "Existing terminal reply." };
        },
      });

      expect(processedEvents).toHaveLength(1);
      expect(processedEvents[0]).toMatchObject({ outcome });
      expect(processedEvents[0]?.reason).toBe(reason);
      expect(processedEvents[0]?.error).toBeUndefined();
    },
  );
});
