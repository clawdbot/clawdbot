import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  ensureCodexRuntimePluginForModelSelection,
  repairCodexRuntimePluginInstallForModelSelection,
  selectedModelShouldEnsureCodexRuntimePlugin,
} from "./codex-runtime-plugin-install.js";

const mocks = vi.hoisted(() => ({
  ensureOnboardingPluginInstalled: vi.fn(),
  repairMissingPluginInstallsForIds: vi.fn(),
}));

vi.mock("./onboarding-plugin-install.js", () => ({
  ensureOnboardingPluginInstalled: mocks.ensureOnboardingPluginInstalled,
}));

vi.mock("./doctor/shared/missing-configured-plugin-install.js", () => ({
  repairMissingPluginInstallsForIds: mocks.repairMissingPluginInstallsForIds,
}));

const prompter = {} as WizardPrompter;
const runtime = {} as RuntimeEnv;

describe("codex runtime plugin install", () => {
  beforeEach(() => {
    mocks.ensureOnboardingPluginInstalled.mockReset();
    mocks.repairMissingPluginInstallsForIds.mockReset();
  });

  it("ensures the Codex plugin for OpenAI model selections", () => {
    expect(selectedModelShouldEnsureCodexRuntimePlugin({ cfg: {}, model: "openai/gpt-5.5" })).toBe(
      true,
    );
    expect(
      selectedModelShouldEnsureCodexRuntimePlugin({ cfg: {}, model: "openai-codex/gpt-5.5" }),
    ).toBe(true);
  });

  it("skips Codex plugin setup for custom OpenAI-compatible base URLs", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://compatible.example.test/v1",
            api: "openai-responses",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(selectedModelShouldEnsureCodexRuntimePlugin({ cfg, model: "openai/custom-gpt" })).toBe(
      false,
    );
    expect(selectedModelShouldEnsureCodexRuntimePlugin({ cfg, model: "local/custom-gpt" })).toBe(
      false,
    );
  });

  it("installs and enables the Codex plugin for OpenAI selections", async () => {
    const installedCfg = { plugins: { entries: { codex: { enabled: true } } } } as OpenClawConfig;
    mocks.ensureOnboardingPluginInstalled.mockResolvedValue({
      cfg: installedCfg,
      installed: true,
      pluginId: "codex",
      status: "installed",
    });

    const result = await ensureCodexRuntimePluginForModelSelection({
      cfg: {},
      model: "openai/gpt-5.5",
      prompter,
      runtime,
      workspaceDir: "/tmp/workspace",
    });

    expect(result).toEqual({
      cfg: installedCfg,
      required: true,
      installed: true,
      status: "installed",
    });
    expect(mocks.ensureOnboardingPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          pluginId: "codex",
          install: expect.objectContaining({ npmSpec: "@openclaw/codex" }),
          trustedSourceLinkedOfficialInstall: true,
        }),
        promptInstall: false,
        autoConfirmSingleSource: true,
        workspaceDir: "/tmp/workspace",
      }),
    );
  });

  it("does not run installer work when OpenAI uses a custom base URL", async () => {
    const cfg = {
      models: {
        providers: {
          openai: { baseUrl: "https://compatible.example.test/v1", models: [] },
        },
      },
    } as OpenClawConfig;
    mocks.ensureOnboardingPluginInstalled.mockResolvedValue({
      cfg,
      installed: false,
      pluginId: "codex",
      status: "skipped",
    });

    const result = await ensureCodexRuntimePluginForModelSelection({
      cfg,
      model: "openai/custom-gpt",
      prompter,
      runtime,
    });

    expect(result).toEqual({ cfg, required: false, installed: false });
    expect(mocks.ensureOnboardingPluginInstalled).not.toHaveBeenCalled();
  });

  it("repairs the missing Codex install for non-interactive model selection paths", async () => {
    mocks.repairMissingPluginInstallsForIds.mockResolvedValue({
      changes: ['Installed missing configured plugin "codex" from @openclaw/codex.'],
      warnings: [],
    });

    const result = await repairCodexRuntimePluginInstallForModelSelection({
      cfg: {},
      model: "openai/gpt-5.5",
      env: { OPENCLAW_TEST: "1" },
    });

    expect(result.required).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(mocks.repairMissingPluginInstallsForIds).toHaveBeenCalledWith({
      cfg: {},
      pluginIds: ["codex"],
      env: { OPENCLAW_TEST: "1" },
    });
  });
});
