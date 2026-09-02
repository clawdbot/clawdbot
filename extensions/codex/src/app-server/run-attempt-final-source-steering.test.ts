import { describe, expect, it, vi } from "vitest";
import { dynamicToolBuildState } from "./dynamic-tool-build-state.js";
import {
  createCodexRuntimePlanFixture,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  createTestParams,
  fastWait,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

const activeRunRegistrationMocks = vi.hoisted(() => ({
  setActiveEmbeddedRun: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    setActiveEmbeddedRun: (
      ...args: Parameters<typeof actual.setActiveEmbeddedRun>
    ): ReturnType<typeof actual.setActiveEmbeddedRun> => {
      activeRunRegistrationMocks.setActiveEmbeddedRun(...args);
      return actual.setActiveEmbeddedRun(...args);
    },
  };
});

setupRunAttemptTestHooks();

describe("Codex final-source steering", () => {
  it("interrupts grace only for a real inbound user message", async () => {
    activeRunRegistrationMocks.setActiveEmbeddedRun.mockClear();
    const messageTool = createRuntimeDynamicTool("message");
    messageTool.parameters = {
      type: "object",
      properties: {
        action: { type: "string" },
        message: { type: "string" },
        final: { type: "boolean" },
      },
      additionalProperties: false,
    };
    messageTool.execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "Sent." }],
      details: {
        ok: true,
        messageId: "source-reply-steering",
        sourceReplyRoute: "current-source",
      },
    }));
    dynamicToolBuildState.openClawCodingToolsFactory = () => [messageTool];
    const harness = createStartedThreadHarness();
    const params = createTestParams();
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.sourceReplyDeliveryMode = "message_tool_only";
    setCodexTestModelSupportsTools(params, true);
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    let handle:
      | {
          queueMessage: (
            text: string,
            options?: { debounceMs?: number; isInboundUserMessage?: boolean },
          ) => Promise<unknown>;
        }
      | undefined;
    await vi.waitFor(() => {
      handle = activeRunRegistrationMocks.setActiveEmbeddedRun.mock.calls.findLast(
        (call) => call[0] === params.sessionId,
      )?.[1] as typeof handle;
      expect(handle).toBeDefined();
    }, fastWait);

    await expect(
      harness.handleServerRequest({
        id: "request-final-source-reply-steering",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-final-source-reply-steering",
          namespace: null,
          tool: "message",
          arguments: { action: "send", message: "done", final: true },
        },
      }),
    ).resolves.toMatchObject({ success: true });

    await expect(handle!.queueMessage("internal progress", { debounceMs: 0 })).rejects.toThrow(
      "admission sealed",
    );
    expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);

    const inbound = handle!.queueMessage("next user turn", {
      debounceMs: 0,
      isInboundUserMessage: true,
    });
    await harness.waitForMethod("turn/interrupt");
    await expect(inbound).rejects.toThrow("queue cancelled");
    await run;
    expect(harness.requests.filter(({ method }) => method === "turn/interrupt")).toHaveLength(1);
  });
});
