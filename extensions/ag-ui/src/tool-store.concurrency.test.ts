// Two requests from the same device and thread share one session key. The
// tool-stream state is therefore owned by a run, not by the session: a second
// run must not take over the first run's writer, and neither run's teardown may
// remove the other's state.
import { EventType } from "@ag-ui/core";
import { describe, it, expect } from "vitest";
import { handleBeforeToolCall, handleToolResultPersist } from "./hooks.js";
import {
  claimRun,
  endRun,
  ownsRun,
  getWriter,
  markClientToolNames,
  markStateWriterNames,
  isClientTool,
  setRunWriter,
  wasClientToolCalled,
} from "./tool-store.js";

const SESSION_KEY = "shared-session";

function createMockWriter() {
  const events: Array<{ type: EventType } & Record<string, unknown>> = [];
  return {
    events,
    writer: (event: { type: EventType } & Record<string, unknown>) => {
      events.push(event);
    },
  };
}

function claim(owner: string, writer: ReturnType<typeof createMockWriter>["writer"]) {
  if (!claimRun({ sessionKey: SESSION_KEY, owner })) {
    return false;
  }
  setRunWriter({ sessionKey: SESSION_KEY, owner, writer, messageId: `msg-${owner}` });
  return true;
}

describe("tool-stream state is scoped to one run per session", () => {
  it("refuses a second claim while the first run holds the session", () => {
    const a = createMockWriter();
    const b = createMockWriter();

    expect(claim("run-a", a.writer)).toBe(true);
    expect(claim("run-b", b.writer)).toBe(false);
    expect(ownsRun(SESSION_KEY, "run-a")).toBe(true);
    expect(ownsRun(SESSION_KEY, "run-b")).toBe(false);

    endRun(SESSION_KEY, "run-a");
  });

  it("keeps the first run's writer — a rejected run cannot capture the stream", () => {
    const a = createMockWriter();
    const b = createMockWriter();
    claim("run-a", a.writer);
    claim("run-b", b.writer);

    // The session's writer must still be run A's, so A's tool events cannot be
    // redirected into B's response.
    getWriter(SESSION_KEY)?.({ type: EventType.RUN_STARTED });
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(0);

    endRun(SESSION_KEY, "run-a");
  });

  it("does not let a rejected run's teardown clear the holder's state", () => {
    const a = createMockWriter();
    claim("run-a", a.writer);
    claim("run-b", createMockWriter().writer);

    // B lost the claim; its finally block must be a no-op here.
    endRun(SESSION_KEY, "run-b");
    expect(ownsRun(SESSION_KEY, "run-a")).toBe(true);
    expect(getWriter(SESSION_KEY)).toBeDefined();

    endRun(SESSION_KEY, "run-a");
    expect(getWriter(SESSION_KEY)).toBeUndefined();
  });

  it("routes tool events to the holding run only", () => {
    const a = createMockWriter();
    const b = createMockWriter();
    claim("run-a", a.writer);
    claim("run-b", b.writer);

    handleBeforeToolCall(
      { toolName: "get_weather", params: {}, toolCallId: "call-1" },
      { sessionKey: SESSION_KEY },
    );

    expect(a.events.map((e) => e.type)).toContain(EventType.TOOL_CALL_START);
    expect(b.events).toHaveLength(0);

    endRun(SESSION_KEY, "run-a");
  });

  it("scopes client-tool marks to the run", () => {
    const a = createMockWriter();
    claim("run-a", a.writer);
    markClientToolNames(SESSION_KEY, ["change_background"]);
    expect(isClientTool(SESSION_KEY, "change_background")).toBe(true);

    // Releasing the run drops its state; a later run starts clean rather than
    // inheriting the previous run's marks.
    endRun(SESSION_KEY, "run-a");
    const b = createMockWriter();
    claim("run-b", b.writer);
    expect(isClientTool(SESSION_KEY, "change_background")).toBe(false);

    endRun(SESSION_KEY, "run-b");
  });

  it("attaches no writer until the owner wires one", () => {
    // claimRun reserves before response headers exist, so there is a window with
    // an owner but no writer. Hooks must find nothing to write to rather than
    // emitting into a half-built response.
    expect(claimRun({ sessionKey: SESSION_KEY, owner: "run-a" })).toBe(true);
    getWriter(SESSION_KEY)?.({ type: EventType.RUN_STARTED });
    const a = createMockWriter();
    setRunWriter({ sessionKey: SESSION_KEY, owner: "run-a", writer: a.writer, messageId: "m" });
    getWriter(SESSION_KEY)?.({ type: EventType.RUN_STARTED });
    expect(a.events).toHaveLength(1);

    // A non-owner cannot hijack the writer slot.
    const b = createMockWriter();
    setRunWriter({ sessionKey: SESSION_KEY, owner: "run-b", writer: b.writer, messageId: "m" });
    getWriter(SESSION_KEY)?.({ type: EventType.RUN_FINISHED });
    expect(b.events).toHaveLength(0);
    expect(a.events).toHaveLength(2);

    endRun(SESSION_KEY, "run-a");
  });

  it("does not mark the run client-driven when the handler's own state writer fires", () => {
    // State writers live in `clientTools` so the hooks skip emitting their
    // TOOL_CALL_* events, but the HANDLER executes them and then runs a
    // narration turn. Flagging them as client-driven suppresses that narration,
    // so the user sees state change with no confirmation text.
    const a = createMockWriter();
    claim("run-a", a.writer);
    markClientToolNames(SESSION_KEY, ["change_background", "set_notes"]);
    markStateWriterNames(SESSION_KEY, ["set_notes"]);

    handleBeforeToolCall(
      { toolName: "set_notes", params: { notes: "hi" }, toolCallId: "call-sw" },
      { sessionKey: SESSION_KEY },
    );
    expect(a.events).toHaveLength(0); // still skipped by the hook
    expect(wasClientToolCalled(SESSION_KEY)).toBe(false); // but run continues

    // A real browser tool still ends the run.
    handleBeforeToolCall(
      { toolName: "change_background", params: {}, toolCallId: "call-ct" },
      { sessionKey: SESSION_KEY },
    );
    expect(wasClientToolCalled(SESSION_KEY)).toBe(true);

    endRun(SESSION_KEY, "run-a");
  });

  it("emits nothing when no run holds the session", () => {
    expect(getWriter(SESSION_KEY)).toBeUndefined();
    // Hooks must be inert rather than throwing when state was already released.
    expect(() =>
      handleToolResultPersist(
        { message: { content: [{ type: "text", text: "ok" }] } },
        { sessionKey: SESSION_KEY },
      ),
    ).not.toThrow();
  });
});
