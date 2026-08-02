import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSystemAgentOperation } from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.test-helpers.js";

const mocks = vi.hoisted(() => ({
  ensureOnboardingAgent: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("../commands/onboard-agent.js", () => ({
  ensureOnboardingAgent: mocks.ensureOnboardingAgent,
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

describe("system-agent setup transaction", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not provision an agent before a conflicting setup transaction", async () => {
    const config = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5" } },
        list: [{ id: "main", default: true }],
      },
    } satisfies OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "before",
      config,
      sourceConfig: config,
      runtimeConfig: config,
      issues: [],
    });
    const applySetup = vi.fn(async () => {
      throw new Error("OpenClaw config changed while AI access was being tested. Try setup again.");
    });
    const { runtime } = createSystemAgentTestRuntime();

    await expect(
      executeSystemAgentOperation({ kind: "setup", workspace: "/tmp/workspace" }, runtime, {
        approved: true,
        deps: {
          applySetup,
          loadOverview: async () => ({ defaultModel: "openai/gpt-5.5" }) as never,
          verifyInferenceConfig: async () => ({
            ok: true as const,
            modelRef: "openai/gpt-5.5",
            latencyMs: 5,
          }),
        },
      }),
    ).rejects.toThrow("config changed while AI access was being tested");

    expect(applySetup).toHaveBeenCalledOnce();
    expect(mocks.ensureOnboardingAgent).not.toHaveBeenCalled();
  });
});
