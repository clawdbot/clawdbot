import { expect, it, vi } from "vitest";
import type { InternalSessionEntry } from "../../config/sessions.js";
import { deriveGatewaySessionLifecycleSnapshot } from "../../gateway/session-lifecycle-state.js";
import { emitAgentEvent, onAgentEvent, type AgentEventPayload } from "../../infra/agent-events.js";
import {
  createMinimalRunAgentTurnParams,
  setupAgentRunnerExecutionTestState,
  type EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";

vi.mock("../../gateway/session-utils.js", () => ({ loadSessionEntry: vi.fn() }));

const state = setupAgentRunnerExecutionTestState();

it.each(["embedded preparation", "fallback preparation"])(
  "times %s failure between successful turns without borrowing the previous start",
  async (failureBoundary) => {
    const { executeAgentTurn } = await import("./agent-runner-execution.js");
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const session: InternalSessionEntry = { sessionId: "session", updatedAt: now };
    const lifecycle: AgentEventPayload[] = [];
    const unsubscribe = onAgentEvent((event) => {
      if (event.stream !== "lifecycle" || event.sessionKey !== "main") {
        return;
      }
      lifecycle.push(event);
      Object.assign(session, deriveGatewaySessionLifecycleSnapshot({ session, event }));
    });
    const onAgentRunStart = vi.fn();
    const turn = createMinimalRunAgentTurnParams({ opts: { onAgentRunStart } });
    const run = (runId: string) =>
      executeAgentTurn({
        ...turn,
        opts: { ...turn.opts, runId },
        activeSessionStore: { main: session },
        getActiveSessionEntry: () => session,
      });
    const succeed = async (params: EmbeddedAgentParams) => {
      const data = { phase: "start", startedAt: now };
      emitAgentEvent({ runId: params.runId, sessionKey: "main", stream: "lifecycle", data });
      await params.onAgentEvent?.({ stream: "lifecycle", data });
      expect(session).toMatchObject({ status: "running", startedAt: now });
      expect(session.lastRunError).toBeUndefined();
      expect(session.runtimeMs).toBeUndefined();
      expect(session.endedAt).toBeUndefined();
      now += 11_192;
      return { payloads: [{ text: "done" }], meta: {} };
    };
    try {
      state.runEmbeddedAgentMock.mockImplementationOnce(succeed);
      await run("timing-previous");
      expect(session).toMatchObject({ status: "done", startedAt: 1_000_000, runtimeMs: 11_192 });

      now = 3_475_979;
      const rejectPreparation = async () => {
        now += 4_700;
        throw new Error("preparation failed before model start");
      };
      if (failureBoundary === "embedded preparation") {
        state.runEmbeddedAgentMock.mockImplementationOnce(rejectPreparation);
      } else {
        state.runEmbeddedAgentEntryMock.mockImplementationOnce(rejectPreparation);
      }
      const failed = await run("timing-failed");
      expect(failed.outcome.kind).toBe("rejected");
      expect(onAgentRunStart).toHaveBeenCalledTimes(1);
      expect(turn.typingSignals.signalRunStart).not.toHaveBeenCalled();
      expect(turn.typingSignals.signalExecutionActivity).not.toHaveBeenCalled();
      const failureEvents = lifecycle.filter((event) => event.runId === "timing-failed");
      expect(failureEvents).toHaveLength(1);
      expect.soft(failureEvents[0]?.data).toMatchObject({
        phase: "error",
        startedAt: 3_475_979,
        endedAt: 3_480_679,
      });
      expect.soft(session).toMatchObject({
        status: "failed",
        startedAt: 3_475_979,
        runtimeMs: 4_700,
        lastRunError: "preparation failed before model start",
      });

      now = 3_600_000;
      state.runEmbeddedAgentMock.mockImplementationOnce(succeed);
      await run("timing-recovered");
      expect(session).toMatchObject({
        status: "done",
        startedAt: 3_600_000,
        endedAt: 3_611_192,
        runtimeMs: 11_192,
      });
      expect(session.lastRunError).toBeUndefined();
      expect(onAgentRunStart).toHaveBeenCalledTimes(2);
      expect(lifecycle.map((event) => [event.runId, event.data.phase])).toEqual([
        ["timing-previous", "start"],
        ["timing-previous", "end"],
        ["timing-failed", "error"],
        ["timing-recovered", "start"],
        ["timing-recovered", "end"],
      ]);
    } finally {
      unsubscribe();
      clock.mockRestore();
    }
  },
);
