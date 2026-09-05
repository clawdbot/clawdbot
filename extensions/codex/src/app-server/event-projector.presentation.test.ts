import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  vi,
  createParams,
  createProjector,
  buildEmptyToolTelemetry,
  readAttemptTerminal,
  embeddedAgentLog,
  forCurrentTurn,
  agentMessageDelta,
  turnCompleted,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector presentation settlement", () => {
  it.each(["released", "closed", "aborted", "rejected"] as const)(
    "projects the complete answer while presentation settlement is %s",
    async (ending) => {
      const gate = createDeferred<void>();
      const abortController = new AbortController();
      const delivered: string[] = [];
      const failure = new Error("presentation failed");
      const warning = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
      const projector = await createProjector(
        {
          ...(await createParams()),
          onAssistantMessageStart: async () => {
            delivered.push("start");
            await gate.promise;
          },
          onPartialReply: ({ text }) => {
            delivered.push(text ?? "");
          },
          onReasoningStream: () => {
            delivered.push("reasoning");
          },
          onReasoningEnd: () => {
            delivered.push("reasoning-end");
          },
        },
        { runAbortSignal: abortController.signal },
      );
      try {
        await projector.handleNotification(
          forCurrentTurn("item/started", {
            item: { type: "agentMessage", id: "msg-1", phase: "final_answer", text: "" },
          }),
        );
        await projector.handleNotification(agentMessageDelta("hel"));
        await projector.handleNotification(
          forCurrentTurn("item/reasoning/textDelta", {
            itemId: "reasoning-1",
            delta: "thinking",
          }),
        );
        await projector.handleNotification(agentMessageDelta("lo"));
        await projector.handleNotification(
          turnCompleted([
            { type: "agentMessage", id: "msg-1", phase: "final_answer", text: "hello, complete" },
          ]),
        );
        expect(projector.getCompletedTurnStatus()).toBe("completed");
        expect(projector.buildResult(buildEmptyToolTelemetry()).assistantTexts).toEqual([
          "hello, complete",
        ]);
        expect(delivered).toEqual(["start", "hel", "reasoning", "hello", "reasoning-end"]);
        if (ending === "closed") {
          await projector.closeProjection();
        } else if (ending === "aborted") {
          abortController.abort();
        }
        if (ending === "rejected") {
          gate.reject(failure);
        } else {
          gate.resolve();
        }
        await projector.presentation.drain();
        if (ending === "closed" || ending === "aborted") {
          await projector.handleNotification(agentMessageDelta("late"));
          await projector.presentation.drain();
        }
        expect(delivered).toEqual(["start", "hel", "reasoning", "hello", "reasoning-end"]);
        if (ending === "rejected") {
          expect(
            readAttemptTerminal(projector.buildResult(buildEmptyToolTelemetry())).promptError,
          ).toBeNull();
          expect(projector.getCompletedTurnStatus()).toBe("completed");
          expect(warning).toHaveBeenCalledWith(
            "codex app-server presentation callback failed",
            expect.objectContaining({ error: "Error: presentation failed" }),
          );
        }
      } finally {
        gate.resolve();
        await projector.presentation.drain();
        await projector.closeProjection();
      }
    },
  );
});
