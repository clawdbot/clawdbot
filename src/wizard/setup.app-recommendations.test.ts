import { describe, expect, it, vi } from "vitest";
import { refreshOnboardRecommendationsCommand } from "../commands/onboard-recommendations.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type {
  OnboardingRecommendationMatch,
  OnboardingRecommendationsRecord,
  OnboardingRecommendationsStore,
} from "../state/onboarding-recommendations.js";
import type { SetupAppRecommendationsResult } from "../system-agent/setup-app-recommendations.js";
import type { WizardPrompter } from "./prompts.js";
import { setupAppRecommendations as setupAppRecommendationsWithOutcome } from "./setup.app-recommendations.js";

async function setupAppRecommendations(
  params: Parameters<typeof setupAppRecommendationsWithOutcome>[0],
): Promise<OpenClawConfig> {
  const outcome = await setupAppRecommendationsWithOutcome(params);
  outcome.commitResult();
  return outcome.config;
}

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

function storeDeps(initial: OnboardingRecommendationsRecord | null = null) {
  let current = initial;
  let now = 0;
  const writeOffer = vi.fn(
    (params: Parameters<OnboardingRecommendationsStore["writeOffer"]>[0]) => {
      now += 1;
      current = {
        inventoryHash: "hash",
        matches: [...params.matches],
        offeredAt: now,
        acceptedAt: params.answered ? now : null,
        updatedAt: now,
      };
      return current;
    },
  );
  const acknowledgeStored = vi.fn(
    (params: Parameters<OnboardingRecommendationsStore["acknowledge"]>[0] = {}) => {
      if (
        !current ||
        (params.expected &&
          (params.expected.inventoryHash !== current.inventoryHash ||
            params.expected.updatedAt !== current.updatedAt))
      ) {
        return null;
      }
      now += 1;
      current = { ...current, acceptedAt: now, updatedAt: now };
      return current;
    },
  );
  const updatePendingStored = vi.fn(
    (params: Parameters<OnboardingRecommendationsStore["updatePending"]>[0]) => {
      if (
        !current ||
        params.expected.inventoryHash !== current.inventoryHash ||
        params.expected.updatedAt !== current.updatedAt
      ) {
        return null;
      }
      now += 1;
      current = { ...current, matches: [...params.matches], updatedAt: now };
      return current;
    },
  );
  return {
    readStored: vi.fn((): OnboardingRecommendationsRecord | null => current),
    writeOffer,
    acknowledgeStored,
    updatePendingStored,
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
      candidateId: "@demo-owner/chat-skill",
      tier: "optional" as const,
      reason: "Adds useful actions",
      candidate: {
        id: "@demo-owner/chat-skill",
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
    const clearPendingStored = vi.fn();
    const prompter = createPrompter();
    const legacyMatch = recommendationResult().matches[1]!;

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
        clearPendingStored,
        readStored: () => ({
          inventoryHash: "hash",
          matches: [
            {
              ...legacyMatch,
              candidateId: "chat-skill",
              candidate: { ...legacyMatch.candidate, id: "chat-skill" },
            },
          ],
          offeredAt: 1,
          acceptedAt: 2,
          updatedAt: 2,
        }),
      },
    });

    expect(recommend).not.toHaveBeenCalled();
    expect(prompter.progress).not.toHaveBeenCalled();
    expect(writeOffer).not.toHaveBeenCalled();
    expect(clearPendingStored).not.toHaveBeenCalled();
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
    const log = vi.fn();
    const prompter = createPrompter();

    refreshOnboardRecommendationsCommand(runtime, { clear });
    await setupAppRecommendations({
      config: {},
      prompter,
      runtime: { ...runtime, log },
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
    expect(prompter.plain).toHaveBeenCalledWith(
      "App names are matched with your configured model and ClawHub search (disable via wizard.appRecommendations).",
    );
    expect(vi.mocked(prompter.plain!).mock.invocationCallOrder[0]).toBeLessThan(
      recommend.mock.invocationCallOrder[0]!,
    );
    expect(log).not.toHaveBeenCalledWith(
      "App names are matched with your configured model and ClawHub search (disable via wizard.appRecommendations).",
    );
  });

  it("logs the scan disclosure when the prompter has no plain-output surface", async () => {
    const recommend = vi.fn(async () => recommendationResult());
    const log = vi.fn();
    const prompter = createPrompter();
    delete prompter.plain;

    await setupAppRecommendations({
      config: {},
      prompter,
      runtime: { ...runtime, log },
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform: "darwin",
      deps: {
        recommend,
        ...storeDeps(),
      },
    });

    expect(log).toHaveBeenCalledWith(
      "App names are matched with your configured model and ClawHub search (disable via wizard.appRecommendations).",
    );
    expect(log.mock.invocationCallOrder[0]).toBeLessThan(recommend.mock.invocationCallOrder[0]!);
  });

  it("reuses a pending stored offer without rescanning and acknowledges the answer", async () => {
    const recommend = vi.fn(async () => recommendationResult());
    const log = vi.fn();
    const prompter = createPrompter(["recommendation:0"]);
    const pending: OnboardingRecommendationsRecord = {
      inventoryHash: "hash",
      matches: recommendationResult().matches,
      offeredAt: 1,
      acceptedAt: null,
      updatedAt: 1,
    };
    const store = storeDeps(pending);
    const ensurePlugin = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
      cfg,
      installed: true as const,
      status: "installed" as const,
    }));

    await setupAppRecommendations({
      config: {},
      prompter,
      runtime: { ...runtime, log },
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform: "darwin",
      deps: {
        ...store,
        recommend,
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
    expect(log).not.toHaveBeenCalledWith(
      "App names are matched with your configured model and ClawHub search (disable via wizard.appRecommendations).",
    );
    expect(prompter.plain).not.toHaveBeenCalled();
    expect(prompter.progress).not.toHaveBeenCalled();
    expect(prompter.multiselect).toHaveBeenCalledOnce();
    expect(store.acknowledgeStored).toHaveBeenCalledOnce();
    expect(store.updatePendingStored).toHaveBeenCalledWith({
      matches: [pending.matches[0]],
      expected: pending,
    });
    expect(store.updatePendingStored.mock.invocationCallOrder[0]).toBeLessThan(
      ensurePlugin.mock.invocationCallOrder[0]!,
    );
    expect(store.writeOffer).not.toHaveBeenCalled();
    expect(ensurePlugin).toHaveBeenCalledOnce();
  });

  it("rescans a pending offer with a bare ClawHub id", async () => {
    const pendingMatches = recommendationResult().matches;
    pendingMatches[1] = {
      ...pendingMatches[1]!,
      candidateId: "chat-skill",
      candidate: { ...pendingMatches[1]!.candidate, id: "chat-skill" },
    };
    const recommend = vi.fn(async () => recommendationResult());
    const clearPendingStored = vi.fn(() => true);

    await setupAppRecommendations({
      config: {},
      prompter: createPrompter(),
      runtime,
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform: "darwin",
      deps: {
        recommend,
        readStored: () => ({
          inventoryHash: "hash",
          matches: pendingMatches,
          offeredAt: 1,
          acceptedAt: null,
          updatedAt: 1,
        }),
        writeOffer: vi.fn(),
        clearPendingStored,
        deferOfferToBootstrap: () => false,
      },
    });

    expect(clearPendingStored).toHaveBeenCalledWith({
      expected: expect.objectContaining({ inventoryHash: "hash", updatedAt: 1 }),
    });
    expect(recommend).toHaveBeenCalledOnce();
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
    const store = storeDeps();
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

    const outcome = await setupAppRecommendationsWithOutcome({
      config,
      prompter,
      runtime,
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform: "darwin",
      deps: {
        ...store,
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
    expect(installSkill).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "@demo-owner/chat-skill" }),
    );
    expect(store.writeOffer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ answered: false, matches: recommendationResult().matches }),
    );
    expect(store.writeOffer).toHaveBeenCalledOnce();
    expect(store.writeOffer.mock.invocationCallOrder[0]).toBeLessThan(
      ensurePlugin.mock.invocationCallOrder[0]!,
    );
    expect(store.updatePendingStored).toHaveBeenCalledWith({
      matches: [recommendationResult().matches[0]],
      expected: expect.objectContaining({
        matches: recommendationResult().matches,
        updatedAt: 1,
      }),
    });
    expect(installSkill.mock.invocationCallOrder[0]).toBeLessThan(
      store.updatePendingStored.mock.invocationCallOrder[0]!,
    );
    expect(store.acknowledgeStored).not.toHaveBeenCalled();
    outcome.commitResult();
    expect(store.acknowledgeStored).toHaveBeenCalledWith({
      expected: expect.objectContaining({
        inventoryHash: "hash",
        matches: [recommendationResult().matches[0]],
        updatedAt: 2,
      }),
    });
    expect(store.writeOffer).toHaveBeenCalledOnce();
    expect(outcome.config.plugins?.entries?.["chat-plugin"]?.enabled).toBe(true);
  });

  it("reoffers a failed install and consumes it after a successful retry", async () => {
    const storeState: { current: OnboardingRecommendationsRecord | null } = { current: null };
    let now = 0;
    const writeOffer = vi.fn(
      (params: Parameters<OnboardingRecommendationsStore["writeOffer"]>[0]) => {
        now += 1;
        storeState.current = {
          inventoryHash: "hash",
          matches: [...params.matches],
          offeredAt: now,
          acceptedAt: params.answered ? now : null,
          updatedAt: now,
        };
        return storeState.current;
      },
    );
    const acknowledgeStored = vi.fn(
      (params: Parameters<OnboardingRecommendationsStore["acknowledge"]>[0] = {}) => {
        if (
          !storeState.current ||
          (params.expected &&
            (params.expected.inventoryHash !== storeState.current.inventoryHash ||
              params.expected.updatedAt !== storeState.current.updatedAt))
        ) {
          return null;
        }
        now += 1;
        storeState.current = { ...storeState.current, acceptedAt: now, updatedAt: now };
        return storeState.current;
      },
    );
    const updatePendingStored = vi.fn(
      ({
        matches,
        expected,
      }: {
        matches: readonly OnboardingRecommendationMatch[];
        expected: OnboardingRecommendationsRecord;
      }) => {
        if (
          !storeState.current ||
          expected.inventoryHash !== storeState.current.inventoryHash ||
          expected.updatedAt !== storeState.current.updatedAt
        ) {
          return null;
        }
        now += 1;
        storeState.current = {
          ...storeState.current,
          matches: [...matches],
          updatedAt: now,
        };
        return storeState.current;
      },
    );
    const recommend = vi.fn(async () => recommendationResult());
    const installSkill = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, error: "offline" })
      .mockResolvedValueOnce({
        ok: true as const,
        slug: "chat-skill",
        version: "1.0.0",
        targetDir: "/tmp/workspace/skills/chat-skill",
      });
    const prompter = createPrompter();
    vi.mocked(prompter.multiselect)
      .mockResolvedValueOnce(["recommendation:1"])
      .mockResolvedValueOnce(["recommendation:0"]);
    const deps = {
      recommend,
      installSkill,
      readStored: () => storeState.current,
      writeOffer,
      acknowledgeStored,
      updatePendingStored,
      deferOfferToBootstrap: () => false,
    };

    await setupAppRecommendations({
      config: {},
      prompter,
      runtime,
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform: "darwin",
      deps,
    });

    expect(storeState.current).toMatchObject({
      acceptedAt: null,
      matches: [expect.objectContaining({ candidateId: "@demo-owner/chat-skill" })],
    });

    await setupAppRecommendations({
      config: {},
      prompter,
      runtime,
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform: "darwin",
      deps,
    });

    expect(recommend).toHaveBeenCalledOnce();
    expect(installSkill).toHaveBeenCalledTimes(2);
    expect(acknowledgeStored).toHaveBeenCalledOnce();
    expect(storeState.current?.acceptedAt).toBeTypeOf("number");
  });

  it("consumes an exact installed skill left pending by an interrupted run", async () => {
    const skill = recommendationResult().matches[1]!;
    const stored: OnboardingRecommendationsRecord = {
      inventoryHash: "hash",
      matches: [skill],
      offeredAt: 1,
      acceptedAt: null,
      updatedAt: 1,
    };
    const store = storeDeps(stored);
    const installSkill = vi.fn();

    const outcome = await setupAppRecommendationsWithOutcome({
      config: {},
      prompter: createPrompter(["recommendation:0"]),
      runtime,
      workspaceDir: "/tmp/workspace",
      modelRouteVerified: true,
      platform: "darwin",
      deps: {
        ...store,
        installSkill,
        isSkillInstalled: vi.fn(async ({ skillRef }) => skillRef === skill.candidate.id),
      },
    });

    expect(installSkill).not.toHaveBeenCalled();
    expect(store.acknowledgeStored).toHaveBeenCalledWith({
      expected: expect.objectContaining({ matches: [skill], updatedAt: 1 }),
    });
    outcome.commitResult();
    expect(store.acknowledgeStored).toHaveBeenCalledOnce();
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
