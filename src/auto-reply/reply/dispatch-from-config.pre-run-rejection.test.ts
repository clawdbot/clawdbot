// Proves the pre-run directive rejection handoff against the real diagnostic
// stream: the real directive owner records the closed rejection code on the
// reply operation run state, the real dispatch finalizer maps it to a skipped
// terminal outcome, and the real message.processed event carries the reason.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAgentHarnesses } from "../../agents/harness/registry.js";
import { onDiagnosticEvent } from "../../infra/diagnostic-events.js";
import {
  createDispatcher,
  diagnosticMocks,
  mocks,
  parseGenericThreadSessionInfo,
  sessionBindingMocks,
  sessionStoreMocks,
  setDiscordTestRegistry,
  threadInfoMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { prepareReplyConversation } from "./prompt-session-context.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;
let resetReplyRunRegistry: () => void;

type ProcessedDiagnosticEvent = {
  type: string;
  outcome?: string;
  reason?: string;
  error?: string;
};

const DIRECTIVE_BODY = "/model openai/gpt-5.6-luna -s";
const SESSION_KEY = "agent:main:session";

function makeTypingController() {
  return {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };
}

describe("dispatchReplyFromConfig pre-run directive rejection", () => {
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
  });

  // The real diagnostic stream plus full dispatch bootstraps run well over the
  // 120s shard default on CPU-contended CI runners, so this proof test carries
  // its own ceiling instead of timing out as a false failure.
  it(
    "reports a rejected model directive as a skipped turn with its closed code",
    { timeout: 300_000 },
    async () => {
      diagnosticMocks.logMessageProcessed.mockClear();
      const runState: ReplyOperationRunState = {};

      // The rejection must come from the real directive owner, so the resolver
      // mirrors the production getReply call with a restricted model policy and
      // the same replyOptions the dispatch turn threaded in.
      const cfg = {
        agents: { defaults: { modelPolicy: { allow: ["anthropic/*"] } } },
      } as Parameters<typeof dispatchReplyFromConfig>[0]["cfg"];
      const ctx = buildTestCtx({
        Body: DIRECTIVE_BODY,
        BodyForAgent: DIRECTIVE_BODY,
        BodyForCommands: DIRECTIVE_BODY,
        CommandBody: DIRECTIVE_BODY,
        CommandAuthorized: true,
        From: "user1",
        To: "telegram:+2000",
        Surface: "telegram",
        ChatType: "private",
        SessionKey: SESSION_KEY,
      });
      const sessionEntry = { sessionId: "session-1", updatedAt: 1 };

      const processedEvents: ProcessedDiagnosticEvent[] = [];
      const unsubscribe = onDiagnosticEvent((event) => {
        if (event.type === "message.processed") {
          processedEvents.push(event as ProcessedDiagnosticEvent);
        }
      });
      diagnosticMocks.forwardToRealPipeline = true;
      try {
        await dispatchReplyFromConfig({
          ctx,
          cfg,
          dispatcher: createDispatcher(),
          replyOptions: { [REPLY_OPERATION_RUN_STATE]: runState },
          replyResolver: async (resolverCtx, resolverOpts) => {
            const result = await resolveReplyDirectives({
              // The dispatch turn hands the resolver an already-finalized ctx; the
              // test harness builds a plain MsgContext, so this narrows it to the
              // same shape the production caller provides.
              ctx: resolverCtx as Parameters<typeof resolveReplyDirectives>[0]["ctx"],
              cfg,
              agentId: "main",
              agentDir: "/tmp/main-agent",
              workspaceDir: "/tmp/workspace",
              agentCfg: {},
              sessionCtx: {
                Body: DIRECTIVE_BODY,
                BodyStripped: DIRECTIVE_BODY,
                BodyForAgent: DIRECTIVE_BODY,
                CommandBody: DIRECTIVE_BODY,
                commandText: DIRECTIVE_BODY,
                agentText: DIRECTIVE_BODY,
                rawText: DIRECTIVE_BODY,
                Provider: "telegram",
                Surface: "telegram",
              } as never,
              conversation: prepareReplyConversation({
                ctx: {},
                sessionEntry,
              }),
              sessionEntry,
              sessionStore: { [SESSION_KEY]: sessionEntry },
              sessionKey: SESSION_KEY,
              sessionScope: "per-sender",
              isGroup: false,
              triggerBodyNormalized: DIRECTIVE_BODY,
              resetTriggered: false,
              commandAuthorized: true,
              defaultProvider: "anthropic",
              defaultModel: "claude-opus-4-6",
              aliasIndex: { byAlias: new Map(), byKey: new Map() },
              provider: "anthropic",
              model: "claude-opus-4-6",
              hasResolvedHeartbeatModelOverride: false,
              typing: makeTypingController(),
              preparedModelCatalog: {
                entries: [{ provider: "anthropic", id: "claude-opus-4-6", name: "Opus" }],
                routeVariants: [],
              },
              opts: resolverOpts,
            });
            if (result.kind !== "reply") {
              throw new Error("expected the rejected directive to answer the turn");
            }
            return result.reply;
          },
        });
      } finally {
        unsubscribe();
        diagnosticMocks.forwardToRealPipeline = false;
      }

      expect(runState.preRunRejection).toEqual({
        code: "model-policy-rejected",
        errorText: expect.stringContaining("is not allowed"),
      });
      expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "skipped",
          reason: "model-policy-rejected",
          error: expect.stringContaining("is not allowed"),
        }),
      );
      expect(processedEvents).toEqual([
        expect.objectContaining({
          type: "message.processed",
          outcome: "skipped",
          reason: "model-policy-rejected",
          error: expect.stringContaining("is not allowed"),
        }),
      ]);
    },
  );
});
