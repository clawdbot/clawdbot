import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { hasCodeModeRepairEvidence } from "./code-mode-repair-evidence.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";
import { installCodeModeRepairHook } from "./embedded-agent-runner/run/code-mode-repair.js";
import type { AfterToolOutcomeContext, Agent, AgentToolResult } from "./runtime/index.js";
import { jsonResult, ToolInputError } from "./tools/common.js";

function outcome(
  result: AgentToolResult<unknown>,
  sourceAssistantMessage: AfterToolOutcomeContext["assistantMessage"],
  toolCallId: string,
): AfterToolOutcomeContext {
  return {
    assistantMessage: sourceAssistantMessage,
    toolCall: {
      type: "toolCall",
      id: toolCallId,
      name: "exec",
      arguments: {},
    },
    args: {},
    result,
    isError: false,
    executionStarted: true,
    context: { systemPrompt: "", messages: [], tools: [] },
  } as unknown as AfterToolOutcomeContext;
}

function assistantMessage(timestamp: number): AfterToolOutcomeContext["assistantMessage"] {
  return {
    role: "assistant",
    content: [],
    timestamp,
  } as unknown as AfterToolOutcomeContext["assistantMessage"];
}

describe("Code Mode authenticated repair integration", () => {
  afterEach(() => {
    resetCodeModeTestState();
  });

  it("offers one repair from the real preflight result and completes the correction", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const preflight = pluginToolWithExecute(
      "fake_trusted_preflight",
      "Trusted preparation failure",
      async () => jsonResult({ unexpected: true }),
    );
    preflight.prepareBeforeToolCallParams = () => {
      throw new ToolInputError("trusted preparation rejected input");
    };
    applyCodeModeCatalog({
      tools: [...codeModeTools, preflight],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode-repair-integration",
      catalogRef,
      toolHookContext: {
        agentId: "main",
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode-repair-integration",
      },
    });
    const execTool = expectDefined(codeModeTools[0], "Code Mode exec test invariant");

    const failedResult = await execTool.execute("code-call-trusted-preflight", {
      code: `return await tools.callValue("fake_trusted_preflight", {});`,
    });
    const failedDetails = resultDetails(failedResult);
    expect(failedDetails).toMatchObject({
      status: "failed",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
    });
    expect(hasCodeModeRepairEvidence(failedDetails)).toBe(true);
    expect(preflight.execute).not.toHaveBeenCalled();

    const agent = {} as Agent;
    installCodeModeRepairHook({ agent });
    const offered = await agent.afterToolOutcome?.(
      outcome(failedResult, assistantMessage(1), "code-call-trusted-preflight"),
    );
    expect(offered).toMatchObject({
      terminate: false,
      details: { repair: { allowed: true, remainingAttempts: 1 } },
    });

    const correctedResult = await execTool.execute("code-call-corrected", {
      code: "return 42;",
    });
    const completed = await agent.afterToolOutcome?.(
      outcome(correctedResult, assistantMessage(2), "code-call-corrected"),
    );

    expect(completed).toBeUndefined();
    expect(resultDetails(correctedResult)).toMatchObject({ status: "completed", value: 42 });
  });
});
