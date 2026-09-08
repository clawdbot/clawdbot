// Exercise history preparation and prompt submission together: child state belongs after history.
import { Type } from "typebox";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../../internal-runtime-context.js";
import type { SubagentRunRecord } from "../../subagents/registry/subagent-registry.types.js";
import type { AnyAgentTool } from "../../tools/common.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const tempPaths: string[] = [];
const sessionKey = "agent:main:runtime-facts";
let registry: typeof import("../../subagents/registry/subagent-registry.test-helpers.js");

async function captureAttempt(codeModeOverride: boolean) {
  resetEmbeddedAttemptHarness();
  getHoisted().createOpenClawCodingToolsMock.mockReturnValue([
    {
      name: "sessions_spawn",
      label: "Spawn",
      description: "Spawn a child agent",
      parameters: Type.Object({ task: Type.String() }),
      execute: async () => ({ content: [], details: undefined }),
    } satisfies AnyAgentTool,
  ]);
  let captured: { systemPrompt: string | undefined; messages: unknown[] } | undefined;
  const result = await createContextEngineAttemptRunner({
    contextEngine: createContextEngineBootstrapAndAssemble(),
    sessionKey,
    tempPaths,
    attemptOverrides: {
      codeModeOverride,
      disableTools: false,
      trigger: "user",
      transcriptPrompt: "hello",
      sessionPersistence: "detached",
    },
    sessionPrompt: async (session) => {
      captured = {
        systemPrompt: session.agent.state.systemPrompt,
        messages: structuredClone(session.messages),
      };
    },
  });
  expect(result.terminal.kind).toBe("ok");
  if (!captured) {
    throw new Error("Expected a provider submission after history and prompt preparation");
  }
  return captured;
}

function expectSubagentCarrier(messages: unknown[], state: string) {
  expect(messages).toContainEqual(
    expect.objectContaining({
      role: "custom",
      customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
      display: false,
      content: expect.stringContaining(state),
    }),
  );
}

describe("subagent facts through full attempt history preparation", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
    registry = await import("../../subagents/registry/subagent-registry.test-helpers.js");
  });
  beforeEach(() => registry.resetSubagentRegistryForTests());
  afterEach(async () => {
    registry.resetSubagentRegistryForTests();
    await cleanupTempPaths(tempPaths);
  });

  it.each([false, true])(
    "preserves the complete system prompt across child state with codeMode=%s",
    async (codeModeOverride) => {
      const run = {
        runId: "run-worker",
        childSessionKey: "agent:main:subagent:worker",
        controllerSessionKey: sessionKey,
        requesterSessionKey: sessionKey,
        requesterDisplayKey: "main",
        task: "Inspect fixtures",
        label: "Worker",
        cleanup: "keep",
        createdAt: Date.now(),
        execution: { status: "queued" },
      } satisfies SubagentRunRecord;
      registry.addSubagentRunForTests(run);
      const queued = await captureAttempt(codeModeOverride);
      registry.addSubagentRunForTests({
        ...run,
        execution: { status: "running", startedAt: Date.now() },
      });
      const running = await captureAttempt(codeModeOverride);
      registry.resetSubagentRegistryForTests();
      const empty = await captureAttempt(codeModeOverride);

      expect(queued.systemPrompt).toContain("system prompt");
      expect(running.systemPrompt).toBe(queued.systemPrompt);
      expect(empty.systemPrompt).toBe(queued.systemPrompt);
      expect(queued.systemPrompt).not.toContain("run-worker");
      expectSubagentCarrier(queued.messages, "status=queued");
      expectSubagentCarrier(running.messages, "status=running");
      expectSubagentCarrier(empty.messages, "## Active Subagents\nnone");
    },
  );
});
