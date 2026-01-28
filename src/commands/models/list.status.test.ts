import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const store = {
    version: 1,
    profiles: {
      "anthropic:default": {
        type: "oauth",
        provider: "anthropic",
        access: "sk-ant-oat01-ACCESS-TOKEN-1234567890",
        refresh: "sk-ant-ort01-REFRESH-TOKEN-1234567890",
        expires: Date.now() + 60_000,
        email: "peter@example.com",
      },
      "anthropic:work": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-ant-api-0123456789abcdefghijklmnopqrstuvwxyz",
      },
      "openai-codex:default": {
        type: "oauth",
        provider: "openai-codex",
        access: "eyJhbGciOi-ACCESS",
        refresh: "oai-refresh-1234567890",
        expires: Date.now() + 60_000,
      },
    },
  };

  return {
    store,
    resolveMoltbotAgentDir: vi.fn().mockReturnValue("/tmp/moltbot-agent"),
    ensureAuthProfileStore: vi.fn().mockReturnValue(store),
    listProfilesForProvider: vi.fn((s: typeof store, provider: string) => {
      return Object.entries(s.profiles)
        .filter(([, cred]) => cred.provider === provider)
        .map(([id]) => id);
    }),
    resolveAuthProfileDisplayLabel: vi.fn(({ profileId }: { profileId: string }) => profileId),
    resolveAuthStorePathForDisplay: vi
      .fn()
      .mockReturnValue("/tmp/moltbot-agent/auth-profiles.json"),
    resolveEnvApiKey: vi.fn((provider: string) => {
      if (provider === "openai") {
        return {
          apiKey: "sk-openai-0123456789abcdefghijklmnopqrstuvwxyz",
          source: "shell env: OPENAI_API_KEY",
        };
      }
      if (provider === "anthropic") {
        return {
          apiKey: "sk-ant-oat01-ACCESS-TOKEN-1234567890",
          source: "env: ANTHROPIC_OAUTH_TOKEN",
        };
      }
      return null;
    }),
    getCustomProviderApiKey: vi.fn().mockReturnValue(undefined),
    getShellEnvAppliedKeys: vi.fn().mockReturnValue(["OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]),
    shouldEnableShellEnvFallback: vi.fn().mockReturnValue(true),
    loadConfig: vi.fn().mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5", fallbacks: [] },
          models: { "anthropic/claude-opus-4-5": { alias: "Opus" } },
        },
      },
      models: { providers: {} },
      env: { shellEnv: { enabled: true } },
    }),
  };
});

vi.mock("../../agents/agent-paths.js", () => ({
  resolveMoltbotAgentDir: mocks.resolveMoltbotAgentDir,
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
    listProfilesForProvider: mocks.listProfilesForProvider,
    resolveAuthProfileDisplayLabel: mocks.resolveAuthProfileDisplayLabel,
    resolveAuthStorePathForDisplay: mocks.resolveAuthStorePathForDisplay,
  };
});

vi.mock("../../agents/model-auth.js", () => ({
  resolveEnvApiKey: mocks.resolveEnvApiKey,
  getCustomProviderApiKey: mocks.getCustomProviderApiKey,
}));

vi.mock("../../infra/shell-env.js", () => ({
  getShellEnvAppliedKeys: mocks.getShellEnvAppliedKeys,
  shouldEnableShellEnvFallback: mocks.shouldEnableShellEnvFallback,
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
  };
});

import { modelsStatusCommand } from "./list.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("modelsStatusCommand auth overview", () => {
  it("includes masked auth sources in JSON output", async () => {
    await modelsStatusCommand({ json: true }, runtime as never);
    const payload = JSON.parse(String((runtime.log as vi.Mock).mock.calls[0][0]));

    expect(payload.defaultModel).toBe("anthropic/claude-opus-4-5");
    expect(payload.auth.storePath).toBe("/tmp/moltbot-agent/auth-profiles.json");
    expect(payload.auth.shellEnvFallback.enabled).toBe(true);
    expect(payload.auth.shellEnvFallback.appliedKeys).toContain("OPENAI_API_KEY");
    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(payload.auth.oauth.warnAfterMs).toBeGreaterThan(0);
    expect(payload.auth.oauth.profiles.length).toBeGreaterThan(0);

    const providers = payload.auth.providers as Array<{
      provider: string;
      profiles: { labels: string[] };
      env?: { value: string; source: string };
    }>;
    const anthropic = providers.find((p) => p.provider === "anthropic");
    expect(anthropic).toBeTruthy();
    expect(anthropic?.profiles.labels.join(" ")).toContain("OAuth");
    expect(anthropic?.profiles.labels.join(" ")).toContain("...");

    const openai = providers.find((p) => p.provider === "openai");
    expect(openai?.env?.source).toContain("OPENAI_API_KEY");
    expect(openai?.env?.value).toContain("...");

    expect(
      (payload.auth.providersWithOAuth as string[]).some((e) => e.startsWith("anthropic")),
    ).toBe(true);
    expect(
      (payload.auth.providersWithOAuth as string[]).some((e) => e.startsWith("openai-codex")),
    ).toBe(true);
  });

  it("exits non-zero when auth is missing", async () => {
    const originalProfiles = { ...mocks.store.profiles };
    mocks.store.profiles = {};
    const localRuntime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const originalEnvImpl = mocks.resolveEnvApiKey.getMockImplementation();
    mocks.resolveEnvApiKey.mockImplementation(() => null);

    try {
      await modelsStatusCommand({ check: true, plain: true }, localRuntime as never);
      expect(localRuntime.exit).toHaveBeenCalledWith(1);
    } finally {
      mocks.store.profiles = originalProfiles;
      mocks.resolveEnvApiKey.mockImplementation(originalEnvImpl);
    }
  });
});
