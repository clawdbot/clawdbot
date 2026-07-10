import { describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../wizard/prompts.js";
import { runCrestodianModelSetup } from "./model-setup.js";

const mocks = vi.hoisted(() => {
  const committedConfigs: Array<Record<string, unknown>> = [];
  return {
    appendAudit: vi.fn(),
    committedConfigs,
    commitConfig: vi.fn(
      async (params: {
        transform: (
          currentConfig: Record<string, unknown>,
          context: { snapshot: { valid: boolean; hash: string } },
        ) =>
          | Promise<{ nextConfig: Record<string, unknown> }>
          | { nextConfig: Record<string, unknown> };
      }) => {
        const transformed = await params.transform(
          {
            agents: { defaults: { workspace: "/configured/work" } },
            gateway: { port: 19001 },
          },
          { snapshot: { valid: true, hash: "current" } },
        );
        committedConfigs.push(transformed.nextConfig);
        return {
          nextConfig: transformed.nextConfig,
          path: "/tmp/openclaw.json",
          previousHash: "current",
          persistedHash: "after",
        };
      },
    ),
    readSnapshot: vi.fn().mockResolvedValueOnce({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "before",
      config: { agents: { defaults: { workspace: "/configured/work" } } },
      sourceConfig: { agents: { defaults: { workspace: "/configured/work" } } },
    }),
    runModelAuth: vi.fn(async () => ({
      agents: {
        defaults: {
          workspace: "/configured/work",
          model: { primary: "openai/gpt-5.5" },
        },
      },
    })),
  };
});

vi.mock("./audit.js", () => ({
  appendCrestodianAuditEntry: mocks.appendAudit,
}));

vi.mock("../plugins/install-record-commit.js", () => ({
  transformConfigWithPendingPluginInstalls: mocks.commitConfig,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/default/workspace",
}));

vi.mock("../wizard/setup.shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wizard/setup.shared.js")>();
  return {
    ...actual,
    readSetupConfigFileSnapshot: mocks.readSnapshot,
  };
});

vi.mock("../wizard/setup.model-auth.js", () => ({
  runSetupModelAuthStep: mocks.runModelAuth,
}));

describe("runCrestodianModelSetup", () => {
  it("preserves concurrent config and audits the commit-time snapshot", async () => {
    const prompter = {} as WizardPrompter;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const result = await runCrestodianModelSetup({
      prompter,
      runtime,
    });

    expect(mocks.runModelAuth).toHaveBeenCalledWith({
      config: { agents: { defaults: { workspace: "/configured/work" } } },
      opts: {},
      prompter,
      runtime,
      workspaceDir: "/configured/work",
    });
    expect(mocks.commitConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        afterWrite: { mode: "auto" },
        writeOptions: { allowConfigSizeDrop: false },
        transform: expect.any(Function),
      }),
    );
    expect(mocks.committedConfigs).toEqual([
      {
        agents: {
          defaults: {
            workspace: "/configured/work",
            model: { primary: "openai/gpt-5.5" },
          },
        },
        gateway: { port: 19001 },
      },
    ]);
    expect(mocks.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "models.setup",
        configHashBefore: "current",
        configHashAfter: "after",
        details: {
          workspace: "/configured/work",
          model: "openai/gpt-5.5",
        },
      }),
    );
    expect(result).toEqual({ model: "openai/gpt-5.5" });
  });
});
