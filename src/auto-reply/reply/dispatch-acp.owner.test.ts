import { expect, it, vi } from "vitest";
import { getAcpSessionManager, testing } from "../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../acp/control-plane/manager.lifecycle.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import { registerPendingAgentQuestion } from "../../agents/harness/gateway-question.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { tryDispatchAcpReplyCore } from "./dispatch-acp.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

it.each(
  ["agent:free-harness:acp:bound", "global"].flatMap((sessionKey) =>
    [false, true].map((unconfirmedQuestion) => ({ sessionKey, unconfirmedQuestion })),
  ),
)(
  "preserves ACP target $sessionKey and input ownership (unconfirmed=$unconfirmedQuestion)",
  async ({ sessionKey, unconfirmedQuestion }) => {
    await withOpenClawTestState({ label: "acp-dispatch-owner" }, async (state) => {
      const cfg = {
        agents: {
          ownership: "explicit" as const,
          entries: { main: {}, work: {} },
          defaults: { workspace: state.workspaceDir },
        },
        session: { scope: "global" as const },
        acp: { backend: "synthetic" },
        plugins: { enabled: false },
      };
      await state.writeConfig(cfg);
      const agentId = sessionKey === "global" ? "work" : "free-harness";
      let turns = 0;
      const recordProcessed = vi.fn();
      const claim = unconfirmedQuestion
        ? registerPendingAgentQuestion({
            sessionKey,
            questionId: "ask_77777777777777777777777777777777",
            questions: [
              { id: "choice", header: "Choice", question: "Continue?", isOther: true, options: [] },
            ],
            answer: Promise.resolve({ status: "pending" }),
            gatewayCall: async () => {
              throw new Error("resolve response lost");
            },
          })
        : undefined;
      claim?.attachRegistration(Promise.resolve());
      registerAcpRuntimeBackend({
        id: "synthetic",
        runtime: {
          ownerAwareSessions: 1,
          async ensureSession(input) {
            return {
              ...input,
              backend: "synthetic",
              runtimeSessionName: `${input.agentId}/${input.sessionKey}`,
            };
          },
          async *runTurn({ handle }) {
            turns += 1;
            yield { type: "text_delta", text: `${handle.agentId} reply` };
            yield { type: "done" };
          },
          async cancel() {},
          async close() {},
        },
      });
      testing.resetAcpSessionManagerForTests();
      const manager = getAcpSessionManager();
      const delivered: string[] = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          if (payload.text) {
            delivered.push(payload.text);
          }
        },
      });
      try {
        await manager.initializeSession({
          cfg,
          sessionKey,
          agentId,
          agent: "fixture",
          mode: "persistent",
        });
        const sourceOwner = sessionKey === "global" ? "work" : "main";
        const result = await tryDispatchAcpReplyCore({
          cfg,
          sessionKey,
          ctx: buildTestCtx({
            AgentId: sourceOwner,
            SessionKey: `agent:${sourceOwner}:main`,
            BodyForAgent: "hello",
            Provider: "webchat",
            Surface: "webchat",
          }),
          dispatcher,
          inboundAudio: false,
          shouldSendToolSummaries: false,
          shouldSendFullToolDetails: false,
          shouldRouteToOriginating: false,
          bypassForCommand: false,
          recordProcessed,
          markIdle: () => {},
        });
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
        expect(result).not.toBeNull();
        expect(turns).toBe(unconfirmedQuestion ? 0 : 1);
        if (unconfirmedQuestion) {
          expect(delivered).toEqual([expect.stringContaining("confirmation was lost")]);
          expect(result?.queuedFinal).toBe(true);
          expect(recordProcessed).toHaveBeenCalledWith("error", {
            reason: "acp_question_answer_unconfirmed",
            error: expect.stringContaining("not sent again"),
          });
        } else {
          expect(delivered.join("")).toContain(`${agentId} reply`);
        }
        expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey })).toBeUndefined();
      } finally {
        claim?.dispose();
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
        await disposeAcpSessionManagerInstance(manager, "test-complete");
        testing.resetAcpSessionManagerForTests();
        unregisterAcpRuntimeBackend("synthetic");
      }
    });
  },
);
