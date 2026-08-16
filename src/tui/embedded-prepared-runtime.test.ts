import "../agents/prepared-model-runtime.test-harness.js";
import { beforeEach, describe, expect, it } from "vitest";
import { acquireAgentRunPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import {
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../agents/prepared-model-runtime.test-harness.js";
import { EmbeddedPreparedModelRuntimeHost } from "./embedded-prepared-runtime.js";

const mocks = getPreparedModelRuntimeMocks();

describe("EmbeddedPreparedModelRuntimeHost", () => {
  beforeEach(() => {
    resetPreparedModelRuntimeHarness();
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
      agentDir: "/tmp/unused-agent",
      inheritedAuthDir: "/tmp/unused-agent",
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
