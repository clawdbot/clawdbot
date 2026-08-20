// Regression proof for #118489: the real Codex event projector can persist an
// exact failed tool result while the failing item's lifecycle stays active.
import {
  buildEmptyToolTelemetry,
  createParams,
  createProjector,
  describe,
  expect,
  forCurrentTurn,
  it,
  registerCodexEventProjectorTestLifecycle,
  turnCompleted,
  TURN_ID,
} from "./event-projector.test-harness.js";

registerCodexEventProjectorTestLifecycle();

describe("CodexAppServerEventProjector #118489 residual failed-tool shapes", () => {
  it("persists an exact failed tool result while the failing item stays active", async () => {
    const projector = await createProjector({
      ...(await createParams()),
    });
    const failingItem = {
      type: "dynamicToolCall",
      id: "call-fail",
      namespace: null,
      tool: "read",
      arguments: { path: "missing.txt" },
      status: "inProgress",
      contentItems: null,
      success: null,
      durationMs: null,
    };
    await projector.handleNotification(forCurrentTurn("item/started", { item: failingItem }));
    projector.recordDynamicToolCall({
      callId: "call-fail",
      tool: "read",
      arguments: { path: "missing.txt" },
    });
    projector.recordDynamicToolResult({
      callId: "call-fail",
      tool: "read",
      success: false,
      terminalType: "error",
      sideEffectEvidence: false,
      contentItems: [{ type: "inputText", text: "ENOENT: no such file or directory" }],
    });
    // Bridge failure: the turn snapshot carries the exact failed result, but
    // item/completed for the failing tool is never processed. The Codex
    // app-server contract maps dynamic tool items by call id
    // (openai/codex codex-rs/app-server-protocol/src/protocol/event_mapping.rs:
    // ThreadItem::DynamicToolCall { id: response.call_id }), so the active item
    // id below is the same id the finalizer matches against the requested call.
    await projector.handleNotification(
      turnCompleted([
        {
          type: "dynamicToolCall",
          id: "call-fail",
          turnId: TURN_ID,
          tool: "read",
          status: "completed",
          contentItems: [{ type: "inputText", text: "ENOENT: no such file or directory" }],
          success: false,
          durationMs: 1,
        },
      ]),
    );

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.itemLifecycle).toEqual({
      startedCount: 1,
      completedCount: 0,
      activeCount: 1,
      activeItemIds: ["call-fail"],
    });
    expect(result.messagesSnapshot).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "call-fail",
        toolName: "read",
        isError: true,
      }),
    );
    expect(result.messagesSnapshot).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: [expect.objectContaining({ type: "toolCall", id: "call-fail", name: "read" })],
      }),
    );
    expect(result.lastToolError).toMatchObject({ toolName: "read" });
  });
});
