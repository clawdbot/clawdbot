import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
  },
}));

const installPluginFromNpmSpec = vi.fn();
vi.mock("../../plugins/install.js", () => ({
  installPluginFromNpmSpec: (...args: unknown[]) => installPluginFromNpmSpec(...args),
}));

vi.mock("../../plugins/loader.js", () => ({
  loadMoltbotPlugins: vi.fn(),
}));

import fs from "node:fs";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import type { MoltbotConfig } from "../../config/config.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { makePrompter, makeRuntime } from "./__tests__/test-utils.js";
import { ensureOnboardingPluginInstalled } from "./plugin-install.js";

const baseEntry: ChannelPluginCatalogEntry = {
  id: "zalo",
  meta: {
    id: "zalo",
    label: "Zalo",
    selectionLabel: "Zalo (Bot API)",
    docsPath: "/channels/zalo",
    docsLabel: "zalo",
    blurb: "Test",
  },
  install: {
    npmSpec: "@moltbot/zalo",
    localPath: "extensions/zalo",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ensureOnboardingPluginInstalled", () => {
  it("installs from npm and enables the plugin", async () => {
    const runtime = makeRuntime();
    const prompter = makePrompter({
      select: vi.fn(async () => "npm") as WizardPrompter["select"],
    });
    const cfg: MoltbotConfig = { plugins: { allow: ["other"] } };
    vi.mocked(fs.existsSync).mockReturnValue(false);
    installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "zalo",
      targetDir: "/tmp/zalo",
      extensions: [],
    });

    const result = await ensureOnboardingPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    expect(result.installed).toBe(true);
    expect(result.cfg.plugins?.entries?.zalo?.enabled).toBe(true);
    expect(result.cfg.plugins?.allow).toContain("zalo");
    expect(result.cfg.plugins?.installs?.zalo?.source).toBe("npm");
    expect(result.cfg.plugins?.installs?.zalo?.spec).toBe("@moltbot/zalo");
    expect(result.cfg.plugins?.installs?.zalo?.installPath).toBe("/tmp/zalo");
    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({ spec: "@moltbot/zalo" }),
    );
  });

  it("uses local path when selected", async () => {
    const runtime = makeRuntime();
    const prompter = makePrompter({
      select: vi.fn(async () => "local") as WizardPrompter["select"],
    });
    const cfg: MoltbotConfig = {};
    vi.mocked(fs.existsSync).mockImplementation((value) => {
      const raw = String(value);
      return (
        raw.endsWith(`${path.sep}.git`) || raw.endsWith(`${path.sep}extensions${path.sep}zalo`)
      );
    });

    const result = await ensureOnboardingPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    const expectedPath = path.resolve(process.cwd(), "extensions/zalo");
    expect(result.installed).toBe(true);
    expect(result.cfg.plugins?.load?.paths).toContain(expectedPath);
    expect(result.cfg.plugins?.entries?.zalo?.enabled).toBe(true);
  });

  it("defaults to local on dev channel when local path exists", async () => {
    const runtime = makeRuntime();
    const select = vi.fn(async () => "skip") as WizardPrompter["select"];
    const prompter = makePrompter({ select });
    const cfg: MoltbotConfig = { update: { channel: "dev" } };
    vi.mocked(fs.existsSync).mockImplementation((value) => {
      const raw = String(value);
      return (
        raw.endsWith(`${path.sep}.git`) || raw.endsWith(`${path.sep}extensions${path.sep}zalo`)
      );
    });

    await ensureOnboardingPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    const firstCall = select.mock.calls[0]?.[0];
    expect(firstCall?.initialValue).toBe("local");
  });

  it("defaults to npm on beta channel even when local path exists", async () => {
    const runtime = makeRuntime();
    const select = vi.fn(async () => "skip") as WizardPrompter["select"];
    const prompter = makePrompter({ select });
    const cfg: MoltbotConfig = { update: { channel: "beta" } };
    vi.mocked(fs.existsSync).mockImplementation((value) => {
      const raw = String(value);
      return (
        raw.endsWith(`${path.sep}.git`) || raw.endsWith(`${path.sep}extensions${path.sep}zalo`)
      );
    });

    await ensureOnboardingPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    const firstCall = select.mock.calls[0]?.[0];
    expect(firstCall?.initialValue).toBe("npm");
  });

  it("falls back to local path after npm install failure", async () => {
    const runtime = makeRuntime();
    const note = vi.fn(async () => {});
    const confirm = vi.fn(async () => true);
    const prompter = makePrompter({
      select: vi.fn(async () => "npm") as WizardPrompter["select"],
      note,
      confirm,
    });
    const cfg: MoltbotConfig = {};
    vi.mocked(fs.existsSync).mockImplementation((value) => {
      const raw = String(value);
      return (
        raw.endsWith(`${path.sep}.git`) || raw.endsWith(`${path.sep}extensions${path.sep}zalo`)
      );
    });
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error: "nope",
    });

    const result = await ensureOnboardingPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    const expectedPath = path.resolve(process.cwd(), "extensions/zalo");
    expect(result.installed).toBe(true);
    expect(result.cfg.plugins?.load?.paths).toContain(expectedPath);
    expect(note).toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });
});
