import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { resolveCodexDynamicToolDirectNames } from "./run-attempt-tools.js";
import { createCodexTestModel } from "./test-support.js";

function createParams(): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    contextTokenBudget: 150_000,
    contextWindowInfo: {
      tokens: 150_000,
      referenceTokens: 200_000,
      source: "agentContextTokens",
    },
    thinkLevel: "medium",
    disableTools: false,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

describe("resolveCodexDynamicToolDirectNames", () => {
  it("forces structured_output direct for swarm collectors", () => {
    const params = createParams();
    params.swarmCollector = true;
    params.swarmOutputSchema = {
      type: "object",
      required: ["sentinel"],
      properties: { sentinel: { type: "string" } },
      additionalProperties: false,
    };

    expect(resolveCodexDynamicToolDirectNames(params)).toEqual(["structured_output"]);
  });

  it("does not force structured_output without collector schema", () => {
    const params = createParams();
    params.swarmCollector = true;

    expect(resolveCodexDynamicToolDirectNames(params)).toEqual([]);
  });

  it("does not force structured_output for native final-schema collectors", () => {
    const params = createParams();
    params.provider = "openai";
    params.swarmCollector = true;
    params.swarmOutputSchema = { type: "object" };
    params.onSwarmStructuredOutputState = async () => {};

    expect(resolveCodexDynamicToolDirectNames(params)).toEqual([]);
  });
});
