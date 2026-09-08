import type { InternalToolBatchCall } from "@openclaw/agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { markCodeModeControlTool } from "../../code-mode-control-tools.js";
import type { AgentTool } from "../../runtime/index.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";

const mocks = vi.hoisted(() => ({
  attachedLifecycles: [] as Array<{
    commitReadyCalls: (calls: readonly { toolCallId: string; args: unknown }[]) => void;
    releaseSkippedCalls: (ids: readonly string[]) => void;
  }>,
  committedArgs: [] as unknown[],
  releasedIds: [] as string[][],
  admitToolCallBatch: vi.fn(async (_calls: InternalToolBatchCall[]) => ({
    commitReadyCalls(readyCalls: readonly { toolCallId: string; args: unknown }[]) {
      mocks.committedArgs.push(...readyCalls.map((call) => call.args));
    },
    releaseSkippedCalls(ids: readonly string[]) {
      mocks.releasedIds.push([...ids]);
    },
  })),
}));

vi.mock("../../tool-loop-admission.js", () => ({
  admitToolCallBatch: mocks.admitToolCallBatch,
}));
vi.mock("../../runtime/internal-hooks.js", () => ({
  attachInternalToolBatchLifecycle: (
    result: object,
    lifecycle: (typeof mocks.attachedLifecycles)[number],
  ) => {
    mocks.attachedLifecycles.push(lifecycle);
    return result;
  },
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
    mocks.committedArgs.length = 0;
    mocks.releasedIds.length = 0;
    mocks.attachedLifecycles.length = 0;
    const admission = createToolLoopBatchAdmission({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      loopDetection: { enabled: true },
    });
    if (!admission) {
      throw new Error("Expected batch admission hook");
    }

    const first = await admission({
      assistantMessage: {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "test",
        model: "test",
        usage: createZeroUsageFixture(),
        stopReason: "toolUse",
        timestamp: 1,
      },
      calls: [batchCall("code-alias", { code: "return 1;" })],
      context: { systemPrompt: "", messages: [] },
    });
    const firstLifecycle = mocks.attachedLifecycles[0];
    firstLifecycle?.commitReadyCalls([
      { toolCallId: "code-alias", args: { code: "return 1;", command: "return 1;" } },
    ]);
    firstLifecycle?.releaseSkippedCalls([]);
    const second = await admission({
      assistantMessage: {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "test",
        model: "test",
        usage: createZeroUsageFixture(),
        stopReason: "toolUse",
        timestamp: 2,
      },
      calls: [batchCall("command-alias", { command: "return 1;" })],
      context: { systemPrompt: "", messages: [] },
    });
    const secondLifecycle = mocks.attachedLifecycles[1];
    secondLifecycle?.commitReadyCalls([
      { toolCallId: "command-alias", args: { command: "return 1;", code: "return 1;" } },
    ]);
    secondLifecycle?.releaseSkippedCalls([]);

    const admittedArgs = mocks.admitToolCallBatch.mock.calls.map(([calls]) => calls[0]?.args);
    expect(admittedArgs).toEqual([
      { code: "return 1;", command: "return 1;" },
      { command: "return 1;", code: "return 1;" },
    ]);
    expect(mocks.committedArgs).toEqual(admittedArgs);
    expect(mocks.releasedIds).toEqual([[], []]);
    expect(first).toEqual({});
    expect(second).toEqual({});
    expect(firstLifecycle?.commitReadyCalls).not.toBe(secondLifecycle?.commitReadyCalls);
    expect(mocks.attachedLifecycles).toHaveLength(2);
  });
});
