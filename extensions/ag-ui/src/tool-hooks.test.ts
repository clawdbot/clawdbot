import { EventType } from "@ag-ui/core";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handleBeforeToolCall, handleToolResultPersist } from "./hooks.js";
import { claimRun, endRun, markClientToolNames, setRunWriter } from "./tool-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_KEY = "hook-test-session";
const OWNER = "run-owner-a";

function createMockWriter() {
  const events: Array<{ type: EventType } & Record<string, unknown>> = [];
  const writer = (event: { type: EventType } & Record<string, unknown>) => {
    events.push(event);
  };
  return { events, writer };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tool event hooks", () => {
  let mock: ReturnType<typeof createMockWriter>;

  beforeEach(() => {
    mock = createMockWriter();
    claimRun({ sessionKey: SESSION_KEY, owner: OWNER });
    setRunWriter({
      sessionKey: SESSION_KEY,
      owner: OWNER,
      writer: mock.writer,
      messageId: "msg-001",
    });
  });

  afterEach(() => {
    endRun(SESSION_KEY, OWNER);
  });

  // -------------------------------------------------------------------------
  // Client tools
  // -------------------------------------------------------------------------

  // Marked client/frontend + state-writer tools are SKIPPED by the hook — the
  // HTTP handler emits them via its pendingToolCalls path (or intercepts state
  // writers as STATE_SNAPSHOTs). The writer is registered on every turn so
  // BACKEND tools render, so the hook must not also emit the client tools or
  // they'd be double-rendered.
  describe("client tools (skipped by the hook)", () => {
    beforeEach(() => {
      markClientToolNames(SESSION_KEY, ["get_weather"]);
    });

    it("emits nothing for a marked client tool", () => {
      handleBeforeToolCall(
        { toolName: "get_weather", params: { city: "Tokyo" } },
        { sessionKey: SESSION_KEY },
      );

      expect(mock.events).toHaveLength(0);
    });

    it("emits nothing even when params are empty", () => {
      handleBeforeToolCall({ toolName: "get_weather", params: {} }, { sessionKey: SESSION_KEY });

      expect(mock.events).toHaveLength(0);
    });

    it("pushes no pending id, so a later tool_result_persist is a no-op", () => {
      handleBeforeToolCall(
        { toolName: "get_weather", toolCallId: "call-1" },
        { sessionKey: SESSION_KEY },
      );
      handleToolResultPersist({}, { sessionKey: SESSION_KEY });

      expect(mock.events).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Server tools
  // -------------------------------------------------------------------------

  describe("server tools", () => {
    it("emits TOOL_CALL_START + TOOL_CALL_ARGS on before_tool_call, then TOOL_CALL_RESULT + TOOL_CALL_END on persist", () => {
      handleBeforeToolCall(
        { toolName: "search_db", params: { query: "test" }, toolCallId: "call-search" },
        { sessionKey: SESSION_KEY },
      );

      // After before_tool_call: START + ARGS only (no END yet)
      expect(mock.events).toHaveLength(2);
      expect(mock.events[0]!.type).toBe(EventType.TOOL_CALL_START);
      expect(mock.events[0]!.toolCallName).toBe("search_db");
      expect(mock.events[1]!.type).toBe(EventType.TOOL_CALL_ARGS);
      expect(mock.events[1]!.delta).toBe(JSON.stringify({ query: "test" }));

      const toolCallId = mock.events[0]!.toolCallId as string;
      expect(toolCallId).toBe("call-search");

      // After tool_result_persist: RESULT + END, correlated on the same host id
      handleToolResultPersist({ toolCallId }, { sessionKey: SESSION_KEY });

      expect(mock.events).toHaveLength(4);
      expect(mock.events[2]!.type).toBe(EventType.TOOL_CALL_RESULT);
      expect(mock.events[2]!.toolCallId).toBe(toolCallId);
      expect(mock.events[2]!.messageId).toBe(`msg-tool-${toolCallId}`);
      expect(mock.events[3]!.type).toBe(EventType.TOOL_CALL_END);
      expect(mock.events[3]!.toolCallId).toBe(toolCallId);
    });

    it("does not emit RESULT/END when the host supplied no toolCallId", () => {
      // Call persist without an id — there is nothing to correlate the result to.
      handleToolResultPersist({}, { sessionKey: SESSION_KEY });

      expect(mock.events).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // A2UI detection
  // -------------------------------------------------------------------------

  describe("A2UI tool results", () => {
    it("emits ACTIVITY_SNAPSHOT for A2UI tool results", () => {
      handleBeforeToolCall(
        { toolName: "demo_tool", params: { runs: [] }, toolCallId: "call-a2ui" },
        { sessionKey: SESSION_KEY },
      );

      const toolCallId = mock.events[0]!.toolCallId as string;

      const a2uiJson = JSON.stringify({
        a2ui_operations: [
          { version: "v0.9", createSurface: { surfaceId: "demo-surface" } },
          { version: "v0.9", updateComponents: { surfaceId: "demo-surface", components: [] } },
        ],
      });

      handleToolResultPersist(
        { toolCallId, message: { content: [{ type: "text", text: a2uiJson }] } },
        { sessionKey: SESSION_KEY },
      );

      // Events: START, ARGS, RESULT, ACTIVITY_SNAPSHOT, END
      expect(mock.events).toHaveLength(5);
      expect(mock.events[2]!.type).toBe(EventType.TOOL_CALL_RESULT);
      expect(mock.events[2]!.content).toBe(a2uiJson);

      expect(mock.events[3]!.type).toBe(EventType.ACTIVITY_SNAPSHOT);
      expect(mock.events[3]!.activityType).toBe("a2ui-surface");
      expect(mock.events[3]!.replace).toBe(true);
      expect(mock.events[3]!.messageId).toContain("a2ui-surface-demo-surface-");
      expect(mock.events[3]!.messageId).toContain(toolCallId as string);

      expect(mock.events[4]!.type).toBe(EventType.TOOL_CALL_END);
    });

    it("does not emit ACTIVITY_SNAPSHOT for non-A2UI results", () => {
      handleBeforeToolCall(
        { toolName: "search_db", params: { q: "test" }, toolCallId: "call-plain" },
        { sessionKey: SESSION_KEY },
      );

      handleToolResultPersist(
        {
          toolCallId: "call-plain",
          message: { content: [{ type: "text", text: "plain result" }] },
        },
        { sessionKey: SESSION_KEY },
      );

      // Events: START, ARGS, RESULT, END (no ACTIVITY_SNAPSHOT)
      expect(mock.events).toHaveLength(4);
      expect(mock.events[2]!.type).toBe(EventType.TOOL_CALL_RESULT);
      expect(mock.events[2]!.content).toBe("plain result");
      expect(mock.events[3]!.type).toBe(EventType.TOOL_CALL_END);
    });

    it("populates TOOL_CALL_RESULT content from event.message", () => {
      handleBeforeToolCall(
        { toolName: "my_tool", params: {}, toolCallId: "call-content" },
        { sessionKey: SESSION_KEY },
      );

      handleToolResultPersist(
        {
          toolCallId: "call-content",
          message: { content: [{ type: "text", text: "actual content" }] },
        },
        { sessionKey: SESSION_KEY },
      );

      const resultEvent = mock.events.find((e) => e.type === EventType.TOOL_CALL_RESULT);
      expect(resultEvent?.content).toBe("actual content");
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("does nothing when sessionKey is undefined (before_tool_call)", () => {
      handleBeforeToolCall(
        { toolName: "get_weather", params: { city: "Tokyo" } },
        { sessionKey: undefined },
      );

      expect(mock.events).toHaveLength(0);
    });

    it("does nothing when sessionKey is undefined (tool_result_persist)", () => {
      handleToolResultPersist({}, { sessionKey: undefined });

      expect(mock.events).toHaveLength(0);
    });

    it("does nothing when no writer is registered", () => {
      endRun(SESSION_KEY, OWNER);

      // Supply an id so this proves the writer gate rather than the id gate.
      handleBeforeToolCall(
        { toolName: "get_weather", params: { city: "Tokyo" }, toolCallId: "call-1" },
        { sessionKey: SESSION_KEY },
      );

      expect(mock.events).toHaveLength(0);
    });

    it("uses the host's toolCallId verbatim so concurrent calls stay distinct", () => {
      // Unmarked (backend/server) tools — the hook emits START for each, keyed on
      // the id the host supplied. Inventing ids here (or tracking them on a LIFO
      // stack) attaches result A to call B once the host runs tools in parallel.
      handleBeforeToolCall(
        { toolName: "tool_a", params: { x: 1 }, toolCallId: "host-a" },
        { sessionKey: SESSION_KEY },
      );
      handleBeforeToolCall(
        { toolName: "tool_b", params: { y: 2 }, toolCallId: "host-b" },
        { sessionKey: SESSION_KEY },
      );

      const ids = mock.events
        .filter((e) => e.type === EventType.TOOL_CALL_START)
        .map((e) => e.toolCallId);
      expect(ids).toEqual(["host-a", "host-b"]);
    });

    it("emits nothing when the host supplied no toolCallId", () => {
      // No id means no correlation is possible, so the card is skipped rather
      // than rendered against a fabricated id a later result can never match.
      handleBeforeToolCall({ toolName: "tool_a", params: { x: 1 } }, { sessionKey: SESSION_KEY });

      expect(mock.events).toHaveLength(0);
    });

    it("accepts the toolCallId from the hook context", () => {
      // The host passes the id on the context for some hook shapes; both spellings
      // must correlate to the same card.
      handleBeforeToolCall(
        { toolName: "tool_a", params: { x: 1 } },
        { sessionKey: SESSION_KEY, toolCallId: "ctx-a" },
      );
      handleToolResultPersist({}, { sessionKey: SESSION_KEY, toolCallId: "ctx-a" });

      const ids = mock.events.map((e) => e.toolCallId);
      expect(new Set(ids)).toEqual(new Set(["ctx-a"]));
      expect(mock.events.map((e) => e.type)).toEqual([
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_RESULT,
        EventType.TOOL_CALL_END,
      ]);
    });
  });
});
