import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn((_: string) => true),
    runAfterToolCall: vi.fn(async () => {}),
  },
  BeforeToolCallBlockedError: class BeforeToolCallBlockedError extends Error {
    reason: string;

    constructor(reason: string) {
      super(reason);
      this.name = "BeforeToolCallBlockedError";
      this.reason = reason;
    }
  },
  isToolWrappedWithBeforeToolCallHook: vi.fn(() => false),
  consumeAdjustedParamsForToolCall: vi.fn((_: string) => undefined as unknown),
  runBeforeToolCallHook: vi.fn(async ({ params }: { params: unknown }) => ({
    blocked: false,
    params,
  })),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

vi.mock("./pi-tools.before-tool-call.js", () => ({
  BeforeToolCallBlockedError: hookMocks.BeforeToolCallBlockedError,
  buildBlockedToolResult: ({ reason }: { reason: string }) => ({
    content: [{ type: "text", text: reason }],
    details: { status: "blocked", deniedReason: "plugin-before-tool-call", reason },
  }),
  consumeAdjustedParamsForToolCall: hookMocks.consumeAdjustedParamsForToolCall,
  isBeforeToolCallBlockedError: (error: unknown) =>
    error instanceof hookMocks.BeforeToolCallBlockedError,
  isToolWrappedWithBeforeToolCallHook: hookMocks.isToolWrappedWithBeforeToolCallHook,
  runBeforeToolCallHook: hookMocks.runBeforeToolCallHook,
}));

function createReadTool() {
  return {
    name: "read",
    label: "Read",
    description: "reads",
    parameters: Type.Object({}),
    execute: vi.fn(async () => ({ content: [], details: { ok: true } })),
  } satisfies AgentTool;
}

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

describe("pi tool definition adapter after_tool_call", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockClear();
    hookMocks.runner.runAfterToolCall.mockClear();
    hookMocks.runner.runAfterToolCall.mockResolvedValue(undefined);
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockClear();
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(false);
    hookMocks.consumeAdjustedParamsForToolCall.mockClear();
    hookMocks.consumeAdjustedParamsForToolCall.mockReturnValue(undefined);
    hookMocks.runBeforeToolCallHook.mockClear();
    hookMocks.runBeforeToolCallHook.mockImplementation(async ({ params }) => ({
      blocked: false,
      params,
    }));
  });

  // Regression guard: after_tool_call is handled exclusively by
  // handleToolExecutionEnd in the subscription handler to prevent
  // duplicate invocations in embedded runs.
  it("does not fire after_tool_call from the adapter (handled by subscription handler)", async () => {
    const defs = toToolDefinitions([createReadTool()]);
    const def = defs[0];
    if (!def) {
      throw new Error("missing tool definition");
    }
    await def.execute("call-ok", { path: "/tmp/file" }, undefined, undefined, extensionContext);

    expect(hookMocks.runner.runAfterToolCall).not.toHaveBeenCalled();
  });

  it("does not fire after_tool_call from the adapter on error", async () => {
    const tool = {
      name: "bash",
      label: "Bash",
      description: "throws",
      parameters: Type.Object({}),
      execute: vi.fn(async () => {
        throw new Error("boom");
      }),
    } satisfies AgentTool;

    const defs = toToolDefinitions([tool]);
    const def = defs[0];
    if (!def) {
      throw new Error("missing tool definition");
    }
    await def.execute("call-err", { cmd: "ls" }, undefined, undefined, extensionContext);

    expect(hookMocks.runner.runAfterToolCall).not.toHaveBeenCalled();
  });

  it("does not consume adjusted params in adapter for wrapped tools", async () => {
    hookMocks.isToolWrappedWithBeforeToolCallHook.mockReturnValue(true);
    const defs = toToolDefinitions([createReadTool()]);
    const def = defs[0];
    if (!def) {
      throw new Error("missing tool definition");
    }
    await def.execute(
      "call-wrapped",
      { path: "/tmp/file" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(hookMocks.runBeforeToolCallHook).not.toHaveBeenCalled();
    expect(hookMocks.consumeAdjustedParamsForToolCall).not.toHaveBeenCalled();
  });
});
