import { describe, expect, it, vi } from "vitest";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const prepareSimpleCompletionModelForAgentMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
}));

vi.mock("../agents/simple-completion-runtime.js", () => ({
  prepareSimpleCompletionModelForAgent: prepareSimpleCompletionModelForAgentMock,
  completeWithPreparedSimpleCompletionModel: vi.fn(),
}));

const { planCrestodianCommandWithConfiguredModel } = await import("./assistant.js");

describe("Crestodian configured-model planner", () => {
  it("skips the configured model path when no config file exists", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: false,
      raw: null,
      parsed: {},
      sourceConfig: {},
      resolved: {},
      valid: true,
      runtimeConfig: {},
      config: {},
      issues: [],
      warnings: [],
    });

    await expect(
      planCrestodianCommandWithConfiguredModel({
        input: "please set up my model",
        overview: {
          config: {
            path: "/tmp/openclaw.json",
            exists: false,
            valid: true,
            issues: [],
            hash: null,
          },
          agents: [],
          defaultAgentId: "main",
          tools: {
            codex: { command: "codex", found: false },
            claude: { command: "claude", found: false },
            apiKeys: { openai: false, anthropic: false },
          },
          gateway: {
            url: "ws://127.0.0.1:18789",
            source: "local loopback",
            reachable: false,
          },
          references: {
            docsUrl: "https://docs.openclaw.ai",
            sourceUrl: "https://github.com/openclaw/openclaw",
          },
        },
      }),
    ).resolves.toBeNull();

    expect(prepareSimpleCompletionModelForAgentMock).not.toHaveBeenCalled();
  });
});
