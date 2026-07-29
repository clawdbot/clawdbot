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
      cfg,
      required: true,
      installed: false,
      status: "failed",
    });
    expect(result.reason).toBeTruthy();
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
      required: true,
      installed: true,
      status: "installed",
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
      required: true,
      installed: false,
      status: "failed",
      reason: "npm registry returned EAI_AGAIN while fetching @openclaw/codex",
    });
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
      required: true,
      installed: true,
      status: "installed",
    });
  });
});
