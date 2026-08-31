import { beforeEach, describe, expect, expectTypeOf, test } from "vitest";
import {
  emitAgentActivityEvent,
  type AgentCommandOutputEventData,
  type AgentItemEventData,
  type AgentPatchSummaryEventData,
} from "./agent-activity-events.js";
import {
  type AgentApprovalEventData,
  type AgentEventPayload,
  onAgentEvent,
  resetAgentEventsForTest,
} from "./agent-events.js";

describe("agent activity events", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });

  test("emits every activity stream with shared sequencing and context", () => {
    const itemData: AgentItemEventData = {
      itemId: "item-1",
      phase: "start",
      kind: "tool",
      title: "Read",
      status: "running",
    };
    const approvalData: AgentApprovalEventData = {
      phase: "requested",
      kind: "exec",
      status: "pending",
      title: "Approve",
    };
    const commandData: AgentCommandOutputEventData = {
      itemId: "command-1",
      phase: "delta",
      title: "Command",
      toolCallId: "tool-1",
      output: "working",
    };
    const patchData: AgentPatchSummaryEventData = {
      itemId: "patch-1",
      phase: "end",
      title: "Patch",
      toolCallId: "tool-2",
      added: ["new.ts"],
      modified: [],
      deleted: [],
      summary: "Added new.ts",
    };
    const events: AgentEventPayload[] = [];
    const unsubscribe = onAgentEvent((event) => events.push(event));

    emitAgentActivityEvent({
      runId: "run-1",
      sessionKey: "session-1",
      stream: "item",
      data: itemData,
    });
    emitAgentActivityEvent({
      runId: "run-1",
      sessionKey: "session-1",
      stream: "approval",
      data: approvalData,
    });
    emitAgentActivityEvent({
      runId: "run-1",
      sessionKey: "session-1",
      stream: "command_output",
      data: commandData,
    });
    emitAgentActivityEvent({
      runId: "run-1",
      sessionKey: "",
      stream: "patch",
      data: patchData,
    });

    expect(
      events.map(({ runId, seq, stream, sessionKey }) => ({ runId, seq, stream, sessionKey })),
    ).toEqual([
      { runId: "run-1", seq: 1, stream: "item", sessionKey: "session-1" },
      { runId: "run-1", seq: 2, stream: "approval", sessionKey: "session-1" },
      { runId: "run-1", seq: 3, stream: "command_output", sessionKey: "session-1" },
      { runId: "run-1", seq: 4, stream: "patch", sessionKey: undefined },
    ]);
    expect(events.map((event) => event.data)).toEqual([
      itemData,
      approvalData,
      commandData,
      patchData,
    ]);
    expect(events[0]?.data).toBe(itemData);
    unsubscribe();
  });

  test("rejects mismatched stream and payload pairs", () => {
    type ItemData = Extract<
      Parameters<typeof emitAgentActivityEvent>[0],
      { stream: "item" }
    >["data"];

    expectTypeOf<AgentApprovalEventData>().not.toMatchTypeOf<ItemData>();
  });
});
