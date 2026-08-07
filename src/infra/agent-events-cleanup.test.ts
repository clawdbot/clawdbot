import { expect, test } from "vitest";
import { emitAgentEvent, onAgentEvent } from "./agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "./agent-run-registry.js";

test("clearAgentRunContext also cleans up seqByRun to prevent memory leak (#63643)", () => {
  registerAgentRunContext("run-leak", { sessionKey: "main" });
  emitAgentEvent({ runId: "run-leak", stream: "lifecycle", data: {} });
  emitAgentEvent({ runId: "run-leak", stream: "lifecycle", data: {} });

  clearAgentRunContext("run-leak");

  const seqs: number[] = [];
  const stop = onAgentEvent((evt) => {
    if (evt.runId === "run-leak") {
      seqs.push(evt.seq);
    }
  });
  emitAgentEvent({ runId: "run-leak", stream: "lifecycle", data: {} });
  stop();

  expect(seqs).toEqual([1]);
});
