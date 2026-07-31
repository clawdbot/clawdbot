import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeAppServerClient, ServerRequestHandler } from "./client.js";
import type { ClaudeDynamicToolBridge } from "./dynamic-tools.js";
import { emitNativeToolWatchdogEvent, registerToolCallHandler } from "./run-attempt.js";
import type { DynamicToolCallParams, DynamicToolCallResponse } from "./types.js";

// registerToolCallHandler feeds the gateway's stalled-session watchdog
// (src/logging/diagnostic-run-activity.ts touches lastProgressAt on
// tool.execution.*). Without these events, a turn doing many sequential
// dynamic tool calls with little/no intervening assistant text never
// refreshes its progress marker past the initial embedded_run:started
// touch, making a genuinely busy turn indistinguishable from a hang and
// triggering the gateway's stuck-session-recovery abort (openclaw-7f5).

function makeFakeClient(): {
  client: ClaudeAppServerClient;
  dispatch: (req: { method: string; params?: unknown }) => Promise<unknown>;
} {
  let handler: ServerRequestHandler | undefined;
  const client = {
    onServerRequest(next: ServerRequestHandler) {
      handler = next;
      return () => {
        handler = undefined;
      };
    },
  } as unknown as ClaudeAppServerClient;
  return {
    client,
    dispatch: async (req) => {
      if (!handler) {
        throw new Error("no handler registered");
      }
      return await handler({ id: 1, method: req.method, params: req.params as never });
    },
  };
}

function makeFakeBridge(
  impl: (call: DynamicToolCallParams) => Promise<DynamicToolCallResponse>,
): ClaudeDynamicToolBridge {
  return {
    specs: [],
    telemetry: {
      didSendViaMessagingTool: false,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      messagingToolSourceReplyPayloads: [],
      toolMediaUrls: [],
      toolAudioAsVoice: false,
    },
    handleToolCall: impl,
  } as unknown as ClaudeDynamicToolBridge;
}

const CALL: DynamicToolCallParams = {
  threadId: "thread-1",
  turnId: "turn-1",
  callId: "call-1",
  tool: "Bash",
  arguments: { command: "echo hi" },
};

const IDENTITY = {
  agentId: "main",
  runId: "run-1",
  sessionId: "session-1",
  sessionKey: "agent:main:direct:eddie",
};

async function collectToolExecutionEvents(
  run: () => Promise<unknown>,
): Promise<DiagnosticEventPayload[]> {
  const events: DiagnosticEventPayload[] = [];
  const unsubscribe = onInternalDiagnosticEvent((event) => {
    if (event.type.startsWith("tool.execution.")) {
      events.push(event);
    }
  });
  try {
    await run();
    await waitForDiagnosticEventsDrained();
  } finally {
    unsubscribe();
  }
  return events;
}

describe("registerToolCallHandler diagnostics", () => {
  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("emits tool.execution.started then tool.execution.completed for a successful call", async () => {
    const { client, dispatch } = makeFakeClient();
    const bridge = makeFakeBridge(async () => ({ contentItems: [], success: true }));
    registerToolCallHandler(client, bridge, { threadId: "thread-1", turnId: "turn-1" }, IDENTITY);

    const events = await collectToolExecutionEvents(() =>
      dispatch({ method: "item/tool/call", params: CALL }),
    );

    expect(events.map((e) => e.type)).toEqual([
      "tool.execution.started",
      "tool.execution.completed",
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        agentId: IDENTITY.agentId,
        runId: IDENTITY.runId,
        sessionId: IDENTITY.sessionId,
        sessionKey: IDENTITY.sessionKey,
        toolName: "Bash",
        toolCallId: "call-1",
      });
    }
  });

  it("emits tool.execution.error and rethrows when the bridge call fails", async () => {
    const { client, dispatch } = makeFakeClient();
    const bridge = makeFakeBridge(async () => {
      throw new Error("tool call blew up");
    });
    registerToolCallHandler(client, bridge, { threadId: "thread-1", turnId: "turn-1" }, IDENTITY);

    let caught: unknown;
    const events = await collectToolExecutionEvents(async () => {
      try {
        await dispatch({ method: "item/tool/call", params: CALL });
      } catch (error) {
        caught = error;
      }
    });

    expect((caught as Error)?.message).toBe("tool call blew up");
    expect(events.map((e) => e.type)).toEqual(["tool.execution.started", "tool.execution.error"]);
    const errorEvent = events[1] as Extract<
      DiagnosticEventPayload,
      { type: "tool.execution.error" }
    >;
    expect(errorEvent.errorCategory).toBe("claude_dynamic_tool_error");
    expect(errorEvent.toolCallId).toBe("call-1");
  });

  it("does not claim a request for a different turn (no diagnostics emitted)", async () => {
    const { client, dispatch } = makeFakeClient();
    const bridge = makeFakeBridge(async () => ({ contentItems: [], success: true }));
    registerToolCallHandler(client, bridge, { threadId: "thread-1", turnId: "turn-1" }, IDENTITY);

    const events = await collectToolExecutionEvents(async () => {
      const result = await dispatch({
        method: "item/tool/call",
        params: { ...CALL, turnId: "some-other-turn" },
      });
      expect(result).toBeUndefined();
    });

    expect(events).toEqual([]);
  });
});

// Native (claude_code preset) tool items never reach registerToolCallHandler —
// they execute inside the SDK subprocess. emitNativeToolWatchdogEvent covers
// them from the item/started / item/completed stream projection instead, so a
// turn doing long native Bash/Edit/Read work still advances the gateway's
// progress marker (openclaw-apo; the frozen-progress force-abort was confirmed
// live against production on 2026-07-19).
describe("emitNativeToolWatchdogEvent", () => {
  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  const NATIVE_ITEM = { id: "item-9", type: "toolCall", name: "Bash" };

  it("emits started/completed spans with duration for native tool items", async () => {
    const spans = new Map<string, number>();
    const events = await collectToolExecutionEvents(async () => {
      emitNativeToolWatchdogEvent("started", NATIVE_ITEM, IDENTITY, spans);
      emitNativeToolWatchdogEvent("completed", NATIVE_ITEM, IDENTITY, spans);
    });
    expect(events.map((e) => e.type)).toEqual([
      "tool.execution.started",
      "tool.execution.completed",
    ]);
    const completed = events[1] as DiagnosticEventPayload & {
      durationMs?: number;
      toolName?: string;
      toolCallId?: string;
    };
    expect(completed.toolName).toBe("Bash");
    expect(completed.toolCallId).toBe("item-9");
    expect(typeof completed.durationMs).toBe("number");
    expect(spans.size).toBe(0); // span closed
  });

  it("emits tool.execution.error for a failed native item", async () => {
    const spans = new Map<string, number>();
    const events = await collectToolExecutionEvents(async () => {
      emitNativeToolWatchdogEvent("started", NATIVE_ITEM, IDENTITY, spans);
      emitNativeToolWatchdogEvent("completed", { ...NATIVE_ITEM, error: "boom" }, IDENTITY, spans);
    });
    expect(events.map((e) => e.type)).toEqual(["tool.execution.started", "tool.execution.error"]);
    expect((events[1] as DiagnosticEventPayload & { errorCategory?: string }).errorCategory).toBe(
      "claude_native_tool_error",
    );
  });

  it("ignores dynamic tool items (the bridge seam already emits those)", async () => {
    const spans = new Map<string, number>();
    const events = await collectToolExecutionEvents(async () => {
      emitNativeToolWatchdogEvent(
        "started",
        { id: "d1", type: "dynamicToolCall", name: "exec" },
        IDENTITY,
        spans,
      );
      emitNativeToolWatchdogEvent(
        "completed",
        { id: "d1", type: "dynamicToolCall", name: "exec" },
        IDENTITY,
        spans,
      );
    });
    expect(events).toEqual([]);
    expect(spans.size).toBe(0);
  });

  it("ignores non-tool items (assistant messages, reasoning)", async () => {
    const spans = new Map<string, number>();
    const events = await collectToolExecutionEvents(async () => {
      emitNativeToolWatchdogEvent("started", { id: "m1", type: "agentMessage" }, IDENTITY, spans);
    });
    expect(events).toEqual([]);
  });

  it("handles mcpToolCall items and missing ids without a span", async () => {
    const spans = new Map<string, number>();
    const events = await collectToolExecutionEvents(async () => {
      emitNativeToolWatchdogEvent(
        "completed",
        { type: "mcpToolCall", name: "vestige_search" },
        IDENTITY,
        spans,
      );
    });
    expect(events.map((e) => e.type)).toEqual(["tool.execution.completed"]);
    const done = events[0] as DiagnosticEventPayload & { durationMs?: number; toolCallId?: string };
    expect(done.toolCallId).toBe("unknown");
    expect(done.durationMs).toBe(0); // no span without an item id
  });
});
