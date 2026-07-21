import { describe, expect, it, vi } from "vitest";
import type { SystemAgentOperation } from "./operation-types.js";
import { createSystemAgentTestRuntime } from "./system-agent.test-helpers.js";

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  readConfigFileSnapshot: vi.fn(async () => {
    const config = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5" } },
        list: [{ id: "main", default: true }],
      },
    };
    return {
      path: "/tmp/openclaw.json",
      exists: true,
      raw: `${JSON.stringify(config)}\n`,
      parsed: config,
      sourceConfig: config,
      resolved: config,
      valid: true,
      runtimeConfig: config,
      config,
      hash: "mock-hash",
      issues: [],
      warnings: [],
      legacyIssues: [],
    };
  }),
}));

vi.mock("../agents/agent-create.js", () => ({
  createAgent: mocks.createAgent,
  hasValidRawAgentIdCharacters: (value: string) => /[a-z0-9]/iu.test(value),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

const { executeSystemAgentOperation } = await import("./operations.js");

describe("system-agent raw agent ids", () => {
  it.each([
    {
      label: "create-agent",
      operation: { kind: "create-agent", agentId: "###", workspace: "/tmp/work" } as const,
    },
    {
      label: "setup",
      operation: { kind: "setup", agentId: "###", workspace: "/tmp/work" } as const,
    },
  ])("rejects invalid input at the $label entry point", async ({ operation }) => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const applySetup = vi.fn();

    await expect(
      executeSystemAgentOperation(operation as SystemAgentOperation, runtime, {
        approved: true,
        deps: {
          applySetup,
          createAgent: mocks.createAgent,
          loadOverview: async () => ({ defaultModel: "openai/gpt-5.5" }) as never,
          verifyInferenceConfig: async () => ({
            ok: true as const,
            modelRef: "openai/gpt-5.5",
            latencyMs: 5,
          }),
        },
      }),
    ).rejects.toThrow("no valid id characters");

    expect(mocks.createAgent).not.toHaveBeenCalled();
    expect(applySetup).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] running:");
  });
});
