import { describe, expect, it, vi } from "vitest";
import { refreshOnboardRecommendationsCommand } from "../commands/onboard-recommendations.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { OnboardingRecommendationsRecord } from "../state/onboarding-recommendations.js";
import type { SetupAppRecommendationsResult } from "../system-agent/setup-app-recommendations.js";
import type { WizardPrompter } from "./prompts.js";
import { setupAppRecommendations } from "./setup.app-recommendations.js";

function createPrompter(selected: string[] = []): WizardPrompter {
  return {
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    plain: vi.fn(async () => undefined),
    select: vi.fn(),
    multiselect: vi.fn(async () => selected) as WizardPrompter["multiselect"],
    text: vi.fn(),
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
}

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

function storeDeps() {
  return {
    readStored: vi.fn((): OnboardingRecommendationsRecord | null => null),
    writeOffer: vi.fn(),
    deferOfferToBootstrap: vi.fn(() => false),
  };
}

function recommendationResult(): Extract<SetupAppRecommendationsResult, { status: "ok" }> {
  const apps = [{ label: "Chat", bundleId: "com.example.chat" }];
  const matches = [
    {
      appLabel: "Chat",
      candidateId: "chat-plugin",
      tier: "recommended" as const,
      reason: "Connects conversations",
      candidate: {
        id: "chat-plugin",
        displayName: "Chat plugin",
        summary: "Chat",
        source: "official-channel" as const,
      },
    },
    {
      appLabel: "Chat",
      candidateId: "chat-skill",
      tier: "optional" as const,
      reason: "Adds useful actions",
      candidate: {
        id: "chat-skill",
        displayName: "Chat skill",
        summary: "Chat skill",
        source: "clawhub-skill" as const,
      },
    },
  ];
  return { status: "ok", apps, groups: [{ app: apps[0]!, candidates: [] }], matches };
}

describe("setupAppRecommendations", () => {
  it.each([
    [{ wizard: { appRecommendations: false } }, "darwin" as const],
    [{}, "linux" as const],
  ])("skips when gated", async (config, platform) => {
    const recommend = vi.fn(async () => recommendationResult());
    const store = storeDeps();
    await setupAppRecommendations({
      config,
      prompter: createPrompter(),
      runtime,
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform,
      deps: { recommend, ...store },
    });
    expect(recommend).not.toHaveBeenCalled();
    expect(store.readStored).not.toHaveBeenCalled();
  });

  it("short-circuits before scanning when the offer was already answered", async () => {
    const recommend = vi.fn(async () => recommendationResult());
    const writeOffer = vi.fn();
    const prompter = createPrompter();

    await setupAppRecommendations({
      config: {},
      prompter,
      runtime,
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform: "darwin",
      deps: {
        recommend,
        writeOffer,
        readStored: () => ({
          inventoryHash: "hash",
          matches: [],
          offeredAt: 1,
          acceptedAt: 2,
          updatedAt: 2,
        }),
      },
    });

    expect(recommend).not.toHaveBeenCalled();
    expect(prompter.progress).not.toHaveBeenCalled();
    expect(writeOffer).not.toHaveBeenCalled();
  });

  it("scans again after the refresh command clears an answered offer", async () => {
    let stored: OnboardingRecommendationsRecord | null = {
      inventoryHash: "hash",
      matches: [],
      offeredAt: 1,
      acceptedAt: 2,
      updatedAt: 2,
    };
    const clear = vi.fn(() => {
      stored = null;
      return true;
    });
    const recommend = vi.fn(async () => recommendationResult());

    refreshOnboardRecommendationsCommand(runtime, { clear });
    await setupAppRecommendations({
      config: {},
      prompter: createPrompter(),
      runtime,
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform: "darwin",
      deps: {
        recommend,
        readStored: () => stored,
        writeOffer: vi.fn(),
        deferOfferToBootstrap: () => false,
      },
    });

    expect(clear).toHaveBeenCalledOnce();
    expect(recommend).toHaveBeenCalledOnce();
  });

  it("reuses a pending stored offer without rescanning and acknowledges the answer", async () => {
    const recommend = vi.fn(async () => recommendationResult());
    const writeOffer = vi.fn();
    const acknowledgeStored = vi.fn();
    const prompter = createPrompter(["recommendation:0"]);
    const pending: OnboardingRecommendationsRecord = {
      inventoryHash: "hash",
      matches: recommendationResult().matches,
      offeredAt: 1,
      acceptedAt: null,
      updatedAt: 1,
    };
    const ensurePlugin = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
      cfg,
      installed: true as const,
      status: "installed" as const,
    }));

    await setupAppRecommendations({
      config: {},
      prompter,
      runtime,
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform: "darwin",
      deps: {
        recommend,
        writeOffer,
        acknowledgeStored,
        readStored: () => pending,
        deferOfferToBootstrap: () => false,
        ensurePlugin: ensurePlugin as never,
        resolveOfficialEntry: () => ({
          pluginId: "chat-plugin",
          label: "Chat plugin",
          install: { kind: "npm", package: "chat-plugin" } as never,
          trustedSourceLinkedOfficialInstall: true,
        }),
      },
    });

    expect(recommend).not.toHaveBeenCalled();
    expect(prompter.progress).not.toHaveBeenCalled();
    expect(prompter.multiselect).toHaveBeenCalledOnce();
    expect(acknowledgeStored).toHaveBeenCalledOnce();
    expect(writeOffer).not.toHaveBeenCalled();
    expect(ensurePlugin).toHaveBeenCalledOnce();
  });

  it("leaves a pending stored offer to the bootstrap without rescanning", async () => {
    const recommend = vi.fn(async () => recommendationResult());
    const writeOffer = vi.fn();
    const prompter = createPrompter();

    await setupAppRecommendations({
      config: {},
      prompter,
      runtime,
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform: "darwin",
      deps: {
        recommend,
        writeOffer,
        readStored: () => ({
          inventoryHash: "hash",
          matches: recommendationResult().matches,
          offeredAt: 1,
          acceptedAt: null,
          updatedAt: 1,
        }),
        deferOfferToBootstrap: () => true,
      },
    });

    expect(recommend).not.toHaveBeenCalled();
    expect(prompter.multiselect).not.toHaveBeenCalled();
    expect(writeOffer).not.toHaveBeenCalled();
  });

  it("never preselects third-party ClawHub skills even when model-recommended", async () => {
    const result = recommendationResult();
    result.matches[1] = {
      ...result.matches[1]!,
      tier: "recommended",
    };
    const prompter = createPrompter();
    const store = storeDeps();
    await setupAppRecommendations({
      config: {},
      prompter,
      runtime,
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform: "darwin",
      deps: { recommend: vi.fn(async () => result), ...store },
    });
    expect(prompter.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ initialValues: ["recommendation:0"] }),
    );
  });

  it("preselects recommended matches and installs selected plugin and skill", async () => {
    const config: OpenClawConfig = {};
    const prompter = createPrompter(["recommendation:0", "recommendation:1"]);
    const ensurePlugin = vi.fn(async () => ({
      cfg: { ...config, plugins: { entries: { "chat-plugin": { enabled: true } } } },
      installed: true,
      pluginId: "chat-plugin",
      status: "installed" as const,
    }));
    const installSkill = vi.fn(async () => ({
      ok: true as const,
      slug: "chat-skill",
      version: "1.0.0",
      targetDir: "/tmp/workspace/skills/chat-skill",
    }));

    const result = await setupAppRecommendations({
      config,
      prompter,
      runtime,
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform: "darwin",
      deps: {
        ...storeDeps(),
        recommend: async () => recommendationResult(),
        ensurePlugin,
        installSkill,
        resolveOfficialEntry: (pluginId) => ({
          pluginId,
          label: "Chat plugin",
          install: { npmSpec: "@openclaw/chat-plugin" },
        }),
      },
    });

    expect(prompter.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ initialValues: ["recommendation:0"] }),
    );
    expect(ensurePlugin).toHaveBeenCalledOnce();
    expect(installSkill).toHaveBeenCalledOnce();
    expect(result.plugins?.entries?.["chat-plugin"]?.enabled).toBe(true);
  });

  it("installs nothing when the explicit skip entry is selected", async () => {
    const ensurePlugin = vi.fn();
    const installSkill = vi.fn();
    const config: OpenClawConfig = {};
    const store = storeDeps();

    await expect(
      setupAppRecommendations({
        config,
        prompter: createPrompter(["__skip__", "recommendation:0"]),
        runtime,
        workspaceDir: "/tmp/workspace",
        modelRouteVerified: true,
        platform: "darwin",
        deps: {
          ...store,
          recommend: async () => recommendationResult(),
          ensurePlugin,
          installSkill,
        },
      }),
    ).resolves.toBe(config);
    expect(ensurePlugin).not.toHaveBeenCalled();
    expect(installSkill).not.toHaveBeenCalled();
    expect(store.writeOffer).toHaveBeenCalledWith(
      expect.objectContaining({ answered: true, matches: recommendationResult().matches }),
    );
  });

  it("records an empty submitted selection as answered", async () => {
    const store = storeDeps();

    await setupAppRecommendations({
      config: {},
      prompter: createPrompter([]),
      runtime,
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform: "darwin",
      deps: { recommend: async () => recommendationResult(), ...store },
    });

    expect(store.writeOffer).toHaveBeenCalledWith(expect.objectContaining({ answered: true }));
  });

  it("stores a pending offer for a fresh workspace bootstrap", async () => {
    const store = storeDeps();
    store.deferOfferToBootstrap.mockReturnValue(true);
    const prompter = createPrompter();

    await setupAppRecommendations({
      config: {},
      prompter,
      runtime,
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform: "darwin",
      deps: { recommend: async () => recommendationResult(), ...store },
    });

    expect(store.writeOffer).toHaveBeenCalledWith(
      expect.objectContaining({ answered: false, matches: recommendationResult().matches }),
    );
    expect(prompter.note).not.toHaveBeenCalled();
    expect(prompter.multiselect).not.toHaveBeenCalled();
  });
});
