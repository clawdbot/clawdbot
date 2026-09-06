// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../agents/prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireAgentRunPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { EmbeddedPreparedModelRuntimeHost } from "./embedded-prepared-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

describe("EmbeddedPreparedModelRuntimeHost", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-model-runtime" });
    resetPreparedModelRuntimeHarness(state);
  });

  it("reuses its configured publication across two actual run admissions", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } };
    const host = new EmbeddedPreparedModelRuntimeHost();
    host.publish(config);
    await host.waitUntilReady();

    const input = {
      agentId: "default",
      config,
      agentDir: state.agentDir("default"),
      inheritedAuthDir: state.agentDir("default"),
      workspaceDir: "/tmp/unused-workspace",
      runtimePluginSelections: [{ provider: "openai", modelId: "gpt-5.5", agentId: "default" }],
    };
    const first = await acquireAgentRunPreparedModelRuntime(input);
    first.release();
    const second = await acquireAgentRunPreparedModelRuntime(input);
    second.release();

    expect(second.snapshot).toBe(first.snapshot);
    expect(mocks.ensureOpenClawModelsJson).not.toHaveBeenCalled();
  });
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});
