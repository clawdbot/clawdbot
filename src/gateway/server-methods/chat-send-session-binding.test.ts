import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as dispatch from "../../auto-reply/dispatch.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext } from "../../infra/agent-run-registry.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createChatRunState } from "../server-chat-state.js";
import * as chatDispatch from "./chat-send-agent-dispatch.js";
import { handleChatSend } from "./chat-send-handler.js";
import type { GatewayRequestContext } from "./types.js";

type DispatchOptions = Parameters<typeof dispatch.dispatchInboundMessageWithProjectedDispatcher>[0];

it.each(["removed", "replaced", "aborted", "released", "terminal", "rotated", "queued"] as const)(
  "keeps prepared-session binding with its exact admission: %s",
  async (closure) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const runId = "retained-preparation";
      const sessionKey = "agent:main:binding";
      const scope = { agentId: "main", sessionKey };
      const entered = createDeferred<DispatchOptions>();
      const release = createDeferred();
      const observeDispatch = vi.spyOn(chatDispatch, "startChatDispatch");
      const holdDispatch = vi
        .spyOn(dispatch, "dispatchInboundMessageWithProjectedDispatcher")
        .mockImplementation(async (options) => {
          entered.resolve(options);
          await release.promise;
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        });
      const context = {
        chatAbortControllers: new Map(),
        chatQueuedTurns: new Map(),
        chatRunState: createChatRunState(),
        dedupe: new Map(),
        agentRunSeq: new Map(),
        getRuntimeConfig,
        addChatRun: vi.fn(),
        removeChatRun: vi.fn(),
        broadcast: vi.fn(),
        broadcastToConnIds: vi.fn(),
        nodeSendToSession: vi.fn(),
        getSessionEventSubscriberConnIds: () => new Set<string>(),
        logGateway: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      } as unknown as GatewayRequestContext;
      let owned: Parameters<typeof chatDispatch.startChatDispatch>[0] | undefined;
      let reply: ReturnType<typeof createReplyOperation> | undefined;
      let successor: ReturnType<typeof registerChatAbortController> | undefined;
      let options: DispatchOptions | undefined;
      try {
        const respond = vi.fn();
        await handleChatSend({
          params: {
            sessionKey,
            message: "Keep this user turn in its session",
            idempotencyKey: runId,
          },
          req: { type: "req", id: runId, method: "chat.send" },
          respond,
          context,
          client: null,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          { runId, status: "started" },
          undefined,
          expect.anything(),
        );
        options = await entered.promise;
        owned = observeDispatch.mock.calls.at(-1)?.[0];
        const prepared = options.replyOptions?.onSessionPrepared;
        if (!owned || !prepared) {
          throw new Error("chat.send did not hand off its prepared-session callback");
        }
        const { admission, userTurn } = owned;
        const original = admission.activeRunAbort.entry;
        expect(original?.sessionId).toBe(runId);
        // This focused test controls preparation; the native WS test proves its real producer.
        await upsertSessionEntryCore(scope, {
          sessionId: "committed-session",
          updatedAt: Date.now(),
        });
        const committed = loadExactSessionEntryReadOnly(scope);
        if (!committed) {
          throw new Error("session writer did not commit");
        }
        const binding = {
          sessionKey,
          sessionId: committed.entry.sessionId,
          storePath: owned.session.storePath,
        };
        prepared(binding);
        prepared(binding);
        prepared({ ...binding, sessionKey: "agent:main:unrelated", sessionId: "foreign" });

        if (closure === "queued") {
          expect(original?.sessionId).toBe(binding.sessionId);
          expect(admission.admittedSessionId).toBe(runId);
          expect(options.replyOptions?.turnAdoptionLifecycle?.onDeferred?.()).toBe(true);
          expect(context.chatQueuedTurns.get(runId)?.sessionId).toBe(binding.sessionId);
          await userTurn.persist();
          expect(await loadTranscriptEvents({ ...scope, ...binding })).toContainEqual(
            expect.objectContaining({ message: expect.objectContaining({ role: "user" }) }),
          );
          admission.cleanupAdmittedRun({ force: true });
          expect(context.chatQueuedTurns.has(runId)).toBe(true);
        } else if (closure === "removed" || closure === "replaced") {
          admission.activeRunAbort.cleanup({ force: true });
          if (closure === "replaced") {
            successor = registerChatAbortController({
              chatAbortControllers: context.chatAbortControllers,
              runId,
              sessionKey,
              sessionId: "successor-session",
              timeoutMs: 60_000,
            });
          }
        } else if (closure === "aborted") {
          admission.activeRunAbort.controller.abort();
        } else if (closure === "released") {
          admission.gatewayWorkAdmission.release();
        } else if (closure === "terminal") {
          reply = createReplyOperation({
            sessionKey,
            sessionId: binding.sessionId,
            resetTriggered: false,
            upstreamAbortSignal: admission.activeRunAbort.controller.signal,
          });
          reply.complete();
          expect(admission.activeRunAbort.controller.signal.aborted).toBe(false);
        } else {
          rotateAgentEventLifecycleGeneration();
        }
        // No await after closure: release must fence even before its promise settles.
        expect(() => prepared({ ...binding, sessionId: "late-session" })).toThrow();
        expect(original?.sessionId).toBe(binding.sessionId);
        expect(successor?.entry?.sessionId).toBe(
          closure === "replaced" ? "successor-session" : undefined,
        );
        if (closure !== "queued") {
          await upsertSessionEntryCore(scope, { sessionId: "late-session", updatedAt: Date.now() });
          await userTurn.persist();
          expect(
            await loadTranscriptEvents({
              ...scope,
              sessionId: "late-session",
              storePath: binding.storePath,
            }),
          ).toEqual([]);
        }
      } finally {
        options?.replyOptions?.turnAdoptionLifecycle?.onSettled?.();
        reply?.complete();
        successor?.cleanup({ force: true });
        release.resolve();
        if (owned) {
          await vi.waitFor(() => expect(context.chatAbortControllers.has(runId)).toBe(false));
          owned.admission.cleanupAdmittedRun({ force: true });
          clearAgentRunContext(runId, owned.admission.lifecycleGeneration);
        }
        holdDispatch.mockRestore();
        observeDispatch.mockRestore();
      }
    });
  },
);
