import type { InternalToolBatchCall } from "@openclaw/agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { markCodeModeControlTool } from "../../code-mode-control-tools.js";
import type { AgentTool } from "../../runtime/index.js";

const mocks = vi.hoisted(() => ({
  admitToolCallBatch: vi.fn(async (_calls: InternalToolBatchCall[]) => undefined),
}));

vi.mock("../../tool-loop-admission.js", () => ({
  admitToolCallBatch: mocks.admitToolCallBatch,
}));

import { createToolLoopBatchAdmission } from "./tool-loop-recovery.js";

function codeModeExecTool(): AgentTool {
  return markCodeModeControlTool({
    name: "exec",
    label: "exec",
    description: "code mode exec",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  });
}

function batchCall(id: string, args: Record<string, unknown>): InternalToolBatchCall {
  return {
    toolCall: { type: "toolCall", id, name: "exec", arguments: args },
    args,
    tool: codeModeExecTool(),
  };
}

describe("tool-loop recovery batch admission", () => {
  it("canonicalizes equivalent Code Mode exec aliases before loop detection", async () => {
    const admission = createToolLoopBatchAdmission({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      loopDetection: { enabled: true },
    });
    if (!admission) {
      throw new Error("Expected batch admission hook");
    }

    await admission({
      assistantMessage: {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 1,
      },
      calls: [batchCall("code-alias", { code: "return 1;" })],
      context: { systemPrompt: "", messages: [] },
    });
    await admission({
      assistantMessage: {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
      calls: [batchCall("command-alias", { command: "return 1;" })],
      context: { systemPrompt: "", messages: [] },
    });

    const admittedArgs = mocks.admitToolCallBatch.mock.calls.map(([calls]) => calls[0]?.args);
    expect(admittedArgs).toEqual([
      { code: "return 1;", command: "return 1;" },
      { command: "return 1;", code: "return 1;" },
    ]);
  });
});
