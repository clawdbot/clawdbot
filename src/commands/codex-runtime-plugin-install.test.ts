import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  loadInstalledPluginIndexInstallRecords: vi.fn(),
  repairMissingPluginInstallsForIds: vi.fn(),
  ensureOnboardingPluginInstalled: vi.fn(),
}));

type MissingPluginInstallRepairCall = {
  pluginIds: string[];
  env?: NodeJS.ProcessEnv;
};

function readOnlyMissingPluginInstallRepairCall(): MissingPluginInstallRepairCall {
  expect(mocks.repairMissingPluginInstallsForIds).toHaveBeenCalledOnce();
  const calls = mocks.repairMissingPluginInstallsForIds.mock.calls as unknown as Array<
    [MissingPluginInstallRepairCall]
  >;
  const call = calls[0]?.[0];
  if (!call) {
    throw new Error("Expected missing plugin install repair call");
  }
  return call;
}

vi.mock("./doctor/shared/missing-configured-plugin-install.js", () => ({
  repairMissingPluginInstallsForIds: mocks.repairMissingPluginInstallsForIds,
}));

vi.mock("../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: mocks.loadInstalledPluginIndexInstallRecords,
}));
vi.mock("./onboarding-plugin-install.js", () => ({
  ensureOnboardingPluginInstalled: mocks.ensureOnboardingPluginInstalled,
}));
describe("Codex runtime plugin install repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: [],
      warnings: [],
    });
    mocks.ensureOnboardingPluginInstalled.mockResolvedValue({
      cfg: {},
      installed: false,
      pluginId: "codex",
      status: "failed",
    });
  });

  it("surfaces non-fatal ClawHub repair notices to warning-only callers", async () => {
    const reviewNotice = "REVIEW RECOMMENDED - ClawHub has not completed a fresh clean check";
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: ['Repaired missing configured plugin "codex".'],
      warnings: [],
      notices: [reviewNotice],
    });

    const { repairCodexRuntimePluginInstallForModelSelection } =
      await import("./codex-runtime-plugin-install.js");
    const result = await repairCodexRuntimePluginInstallForModelSelection({
      cfg: {},
      model: "openai/gpt-5.5",
      env: {},
    });

    const repairCall = readOnlyMissingPluginInstallRepairCall();
    expect(repairCall.pluginIds).toStrictEqual(["codex"]);
    expect(repairCall.env).toStrictEqual({});
    expect(result).toStrictEqual({
      required: true,
      changes: ['Repaired missing configured plugin "codex".'],
      warnings: [reviewNotice],
    });
  });

  it.each([
    ["plugins disabled", { plugins: { enabled: false } }],
    ["denylisted", { plugins: { deny: ["codex"] } }],
    ["not allowlisted", { plugins: { allow: ["other"] } }],
  ])("does not report an existing Codex install as usable when %s", async (_label, cfg) => {
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      codex: { source: "npm", installPath: process.cwd() },
    });
    const { ensureCodexRuntimePluginForModelSelection } =
      await import("./codex-runtime-plugin-install.js");

    const result = await ensureCodexRuntimePluginForModelSelection({
      cfg,
      model: "openai/gpt-5.5",
      prompter: {} as never,
      runtime: {} as never,
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      message: expect.stringContaining("Codex runtime is required but unavailable"),
    });
    expect("cfg" in result).toBe(false);
  });

  it("enables an allowed existing Codex install", async () => {
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      codex: { source: "npm", installPath: process.cwd() },
    });
    const cfg: OpenClawConfig = {
      plugins: {
        allow: ["codex"],
        entries: { codex: { enabled: false } },
      },
    };
    const { ensureCodexRuntimePluginForModelSelection } =
      await import("./codex-runtime-plugin-install.js");

    const result = await ensureCodexRuntimePluginForModelSelection({
      cfg,
      model: "openai/gpt-5.5",
      prompter: {} as never,
      runtime: {} as never,
    });

    expect(result).toMatchObject({
      ok: true,
      required: true,
      cfg: { plugins: { entries: { codex: { enabled: true } } } },
    });
  });

  it("preserves the actionable installer error for setup callers", async () => {
    mocks.ensureOnboardingPluginInstalled.mockResolvedValueOnce({
      cfg: {},
      installed: false,
      pluginId: "codex",
      status: "failed",
      error: "npm registry returned EAI_AGAIN while fetching @openclaw/codex",
    });
    const { ensureCodexRuntimePluginForModelSelection } =
      await import("./codex-runtime-plugin-install.js");

    const result = await ensureCodexRuntimePluginForModelSelection({
      cfg: {},
      model: "openai/gpt-5.5",
      prompter: {} as never,
      runtime: {} as never,
    });

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      message: expect.stringContaining(
        "npm registry returned EAI_AGAIN while fetching @openclaw/codex",
      ),
    });
  });

  const sensitiveFixture = ["fixture", "credential"].join("-");
  it.each([
    {
      status: "failed" as const,
      error: `Install failed: https://user:${sensitiveFixture}@registry.example.test/pkg?token=${sensitiveFixture}\u001b[2K`,
    },
    {
      status: "timed_out" as const,
      error: undefined,
    },
  ])("formats a sanitized actionable $status failure for required Codex", async (failure) => {
    mocks.ensureOnboardingPluginInstalled.mockResolvedValueOnce({
      cfg: {},
      installed: false,
      pluginId: "codex",
      status: failure.status,
      ...(failure.error ? { error: failure.error } : {}),
    });
    const { ensureCodexRuntimePluginForModelSelection } =
      await import("./codex-runtime-plugin-install.js");

    const result = await ensureCodexRuntimePluginForModelSelection({
      cfg: {},
      model: "openai/gpt-5.5",
      prompter: {} as never,
      runtime: {} as never,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected required runtime failure");
    }
    expect(result.message).toContain(`Codex runtime is required but unavailable`);
    expect(result.message).toContain(`status: ${failure.status}`);
    expect(result.message).toContain("Retry setup");
    expect(result.message).toContain("npm");
    expect(result.message).toContain("registry");
    expect(result.message).not.toContain(sensitiveFixture);
    expect(result.message).not.toContain("\u001b");
    expect(result).not.toHaveProperty("cfg");
  });

  it("keeps an optional Codex runtime selection as a successful no-op", async () => {
    const { ensureCodexRuntimePluginForModelSelection } =
      await import("./codex-runtime-plugin-install.js");

    const result = await ensureCodexRuntimePluginForModelSelection({
      cfg: {},
      model: "anthropic/claude-sonnet-4-6",
      prompter: {} as never,
      runtime: {} as never,
    });

    expect(result).toEqual({
      ok: true,
      cfg: {},
      required: false,
    });
    expect(mocks.ensureOnboardingPluginInstalled).not.toHaveBeenCalled();
  });

  it("allows source checkouts to use the matching bundled Codex plugin", async () => {
    const { ensureCodexRuntimePluginForModelSelection } =
      await import("./codex-runtime-plugin-install.js");

    await ensureCodexRuntimePluginForModelSelection({
      cfg: {},
      model: "openai/gpt-5.5",
      prompter: {} as never,
      runtime: {} as never,
    });

    expect(mocks.ensureOnboardingPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: {
          pluginId: "codex",
          label: "Codex",
          install: { npmSpec: "@openclaw/codex", defaultChoice: "npm" },
          trustedSourceLinkedOfficialInstall: true,
          versionBoundToOpenClaw: true,
        },
      }),
    );
  });

  it("sees an agent-scoped Codex runtime pin behind a custom OpenAI route", async () => {
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      codex: { source: "npm", installPath: process.cwd() },
    });
    const cfg = {
      agents: {
        list: [
          {
            id: "ops",
            default: true,
            model: { primary: "openai/gpt-5.5" },
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          },
        ],
      },
      models: {
        providers: {
          openai: { baseUrl: "https://proxy.example.test/v1", models: [] },
        },
      },
    };
    const { ensureCodexRuntimePluginForModelSelection } =
      await import("./codex-runtime-plugin-install.js");

    const result = await ensureCodexRuntimePluginForModelSelection({
      cfg,
      model: "openai/gpt-5.5",
      agentId: "ops",
      prompter: {} as never,
      runtime: {} as never,
    });

    expect(result).toMatchObject({
      ok: true,
      required: true,
    });
  });

  it("stops the aggregate after a required Codex failure with no config result", async () => {
    mocks.ensureOnboardingPluginInstalled.mockResolvedValueOnce({
      cfg: { plugins: { entries: { codex: { enabled: false } } } },
      installed: false,
      pluginId: "codex",
      status: "failed",
      error: "registry unavailable",
    });
    const { ensureModelSelectionRuntimePlugins } = await import("./runtime-plugin-install.js");

    const result = await ensureModelSelectionRuntimePlugins({
      cfg: {},
      model: "openai/gpt-5.5",
      prompter: {} as never,
      runtime: {} as never,
    });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining("registry unavailable"),
    });
    expect(result).not.toHaveProperty("cfg");
    expect(mocks.ensureOnboardingPluginInstalled).toHaveBeenCalledOnce();
  });

  it("evaluates Copilot after optional Codex and returns the closed success shape", async () => {
    const installedConfig = { plugins: { entries: { copilot: { enabled: true } } } };
    mocks.ensureOnboardingPluginInstalled.mockResolvedValueOnce({
      cfg: installedConfig,
      installed: true,
      pluginId: "copilot",
      status: "installed",
    });
    const { ensureModelSelectionRuntimePlugins } = await import("./runtime-plugin-install.js");

    const result = await ensureModelSelectionRuntimePlugins({
      cfg: {
        models: {
          providers: {
            "github-copilot": {
              baseUrl: "https://api.githubcopilot.com",
              models: [],
              agentRuntime: { id: "copilot" },
            },
          },
        },
      },
      model: "github-copilot/gpt-5.5",
      prompter: {} as never,
      runtime: {} as never,
    });

    expect(result).toEqual({ ok: true, cfg: installedConfig, codexInstalled: false });
    expect(mocks.ensureOnboardingPluginInstalled).toHaveBeenCalledOnce();
    expect(mocks.ensureOnboardingPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({ entry: expect.objectContaining({ pluginId: "copilot" }) }),
    );
  });

  it("silences installer output and rejects prompts in non-interactive mode", async () => {
    const note = vi.fn(async () => {});
    const log = vi.fn();
    const error = vi.fn();
    mocks.ensureOnboardingPluginInstalled.mockImplementationOnce(async (params) => {
      await params.prompter.note("installer note");
      params.prompter.progress("installing").update("downloading");
      params.runtime.log("installer log");
      params.runtime.error("installer error");
      await expect(params.prompter.confirm({ message: "fallback?" })).rejects.toThrow(
        "Runtime plugin install unexpectedly prompted",
      );
      return {
        cfg: {},
        installed: false,
        pluginId: "codex",
        status: "timed_out",
      };
    });
    const { ensureModelSelectionRuntimePlugins } = await import("./runtime-plugin-install.js");

    await ensureModelSelectionRuntimePlugins({
      cfg: {},
      model: "openai/gpt-5.5",
      prompter: { note } as never,
      runtime: { log, error, exit: vi.fn() },
      output: "silent",
    });

    expect(note).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("suppresses installer terminal failure presentation in interactive mode", async () => {
    const note = vi.fn(async () => {});
    const error = vi.fn();
    mocks.ensureOnboardingPluginInstalled.mockImplementationOnce(async (params) => {
      await params.prompter.note("installer failure");
      params.runtime.error("installer failure");
      return {
        cfg: {},
        installed: false,
        pluginId: "codex",
        status: "failed",
      };
    });
    const { ensureCodexRuntimePluginForModelSelection } =
      await import("./codex-runtime-plugin-install.js");

    await ensureCodexRuntimePluginForModelSelection({
      cfg: {},
      model: "openai/gpt-5.5",
      prompter: { note } as never,
      runtime: { log: vi.fn(), error, exit: vi.fn() },
    });

    expect(note).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
