import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";
import {
  createCodexDynamicToolExecutionRegistry,
  resolveCodexDynamicToolDirectNames,
} from "./run-attempt-tools.js";

function createAttemptParams(
  overrides: Partial<EmbeddedRunAttemptParams> = {},
): EmbeddedRunAttemptParams {
  return overrides as EmbeddedRunAttemptParams;
}

describe("resolveCodexDynamicToolDirectNames", () => {
  it("preserves conditional ring-zero and message tools", () => {
    const ringZeroParams = createAttemptParams({ toolsAllow: ["openclaw"] });
    const messageParams = createAttemptParams({ sourceReplyDeliveryMode: "message_tool_only" });

    expect(resolveCodexDynamicToolDirectNames(ringZeroParams, true)).toEqual(["openclaw"]);
    expect(resolveCodexDynamicToolDirectNames(messageParams)).toEqual(["message"]);
  });
});

describe("createCodexDynamicToolExecutionRegistry", () => {
  it("publishes call ownership before a synchronous reentrant replay", async () => {
    const registry = createCodexDynamicToolExecutionRegistry();
    const call = { threadId: "thread-1", turnId: "turn-1", callId: "call-1" };
    const ownerResponse: CodexDynamicToolRuntimeResponse = { success: false, contentItems: [] };
    let replayedExecution: Promise<CodexDynamicToolRuntimeResponse> | undefined;

    const owner = registry.claim(call, async () => {
      replayedExecution = registry.claim(call, async () => ({
        success: true,
        contentItems: [],
      })).execution;
      return ownerResponse;
    });

    expect(replayedExecution).toBe(owner.execution);
    await expect(owner.execution).resolves.toBe(ownerResponse);
  });
});
