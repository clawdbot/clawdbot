// Doctor deprecated CLI profile tests cover legacy auth profile migration and warnings.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { maybeRepairLegacyOAuthProfileIds } from "./doctor-auth-legacy-oauth.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import type { DoctorRepairMode } from "./doctor-repair-mode.js";

const resolvePluginProvidersMock = vi.fn<() => ProviderPlugin[]>(() => []);
const authProfileStoreMock = vi.hoisted(() => ({
  store: { version: 1, profiles: {} } as AuthProfileStore,
}));
const candidateMocks = vi.hoisted(() => ({
  candidates: [{ agentDir: undefined, authPath: "/tmp/shared/openclaw-agent.sqlite" }] as Array<{
    agentDir?: string;
    authPath: string;
  }>,
  stores: new Map<string | undefined, AuthProfileStore>(),
}));
const repairMocks = vi.hoisted(() => ({
  repairOAuthProfileIdMismatch: vi.fn(),
}));
const providerPolicyMocks = vi.hoisted(() => ({
  applyConfigDefaults: vi.fn((params: { config: OpenClawConfig }) => params.config),
}));

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: () => resolvePluginProvidersMock(),
}));

vi.mock("../agents/auth-profiles/repair.js", () => ({
  repairOAuthProfileIdMismatch: repairMocks.repairOAuthProfileIdMismatch,
}));

vi.mock("../config/provider-policy.js", () => ({
  applyProviderConfigDefaultsForConfig: providerPolicyMocks.applyConfigDefaults,
}));

vi.mock("../agents/auth-profiles/persisted.js", () => ({
  loadPersistedAuthProfileStore: (agentDir?: string) =>
    candidateMocks.stores.has(agentDir)
      ? candidateMocks.stores.get(agentDir)
      : agentDir === undefined
        ? authProfileStoreMock.store
        : undefined,
}));

vi.mock("./doctor-auth-legacy-paths.js", () => ({
  listAuthProfileRepairCandidates: () => candidateMocks.candidates,
}));

vi.mock("../agents/auth-profiles/store-runtime.js", () => ({
  ensureAuthProfileStoreWithoutExternalProfiles: () => authProfileStoreMock.store,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: vi.fn(),
}));

function makePrompter(confirmValue: boolean): DoctorPrompter {
  const repairMode: DoctorRepairMode = {
    shouldRepair: confirmValue,
    shouldForce: false,
    nonInteractive: false,
    canPrompt: true,
    updateInProgress: false,
  };
  return {
    confirm: vi.fn().mockResolvedValue(confirmValue),
    confirmAutoFix: vi.fn().mockResolvedValue(confirmValue),
    confirmAggressiveAutoFix: vi.fn().mockResolvedValue(confirmValue),
    confirmRuntimeRepair: vi.fn().mockResolvedValue(confirmValue),
    select: vi.fn().mockResolvedValue(""),
    shouldRepair: repairMode.shouldRepair,
    shouldForce: repairMode.shouldForce,
    repairMode,
  };
}

function requireAuthConfig(config: OpenClawConfig): NonNullable<OpenClawConfig["auth"]> {
  if (!config.auth) {
    throw new Error("expected repaired auth config");
  }
  return config.auth;
}

function requireFirstMockArg<T>(mock: { mock: { calls: T[][] } }, label: string): T {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  const [arg] = call;
  return expectDefined(arg, "arg test invariant");
}

beforeEach(() => {
  resolvePluginProvidersMock.mockReset();
  resolvePluginProvidersMock.mockReturnValue([]);
  authProfileStoreMock.store = { version: 1, profiles: {} };
  candidateMocks.candidates = [
    { agentDir: undefined, authPath: "/tmp/shared/openclaw-agent.sqlite" },
  ];
  candidateMocks.stores.clear();
  repairMocks.repairOAuthProfileIdMismatch.mockReset();
  repairMocks.repairOAuthProfileIdMismatch.mockReturnValue({
    config: {},
    changes: [],
    migrated: false,
  });
  providerPolicyMocks.applyConfigDefaults.mockReset();
  providerPolicyMocks.applyConfigDefaults.mockImplementation(({ config }) => config);
});

describe("maybeRepairLegacyOAuthProfileIds", () => {
  it.each([
    { channels: { telegram: { enabled: true } } },
    { auth: { profiles: {}, order: { anthropic: [] } } },
    {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            models: [],
          },
        },
      },
    },
  ] satisfies OpenClawConfig[])(
    "skips provider discovery without profile state (%#)",
    async (cfg) => {
      const result = await maybeRepairLegacyOAuthProfileIds(cfg, makePrompter(true));

      expect(result.config).toBe(cfg);
      expect(result.retiredProfileCleanupPlans).toEqual([]);
      expect(resolvePluginProvidersMock).not.toHaveBeenCalled();
      expect(repairMocks.repairOAuthProfileIdMismatch).not.toHaveBeenCalled();
    },
  );

  it("repairs provider-owned legacy OAuth profile ids", async () => {
    authProfileStoreMock.store = {
      version: 1,
      profiles: {
        "anthropic:user@example.com": {
          type: "oauth",
          provider: "anthropic",
          access: "token-a",
          refresh: "token-r",
          expires: Date.now() + 60_000,
          email: "user@example.com",
        },
      },
      lastGood: {
        anthropic: "anthropic:user@example.com",
      },
    };

    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "anthropic",
        label: "Anthropic",
        auth: [],
        oauthProfileIdRepairs: [{ legacyProfileId: "anthropic:default" }],
      },
    ]);
    repairMocks.repairOAuthProfileIdMismatch.mockReturnValue({
      migrated: true,
      changes: ["Auth: migrate anthropic:default → anthropic:user@example.com"],
      config: {
        auth: {
          profiles: {
            "anthropic:user@example.com": {
              provider: "anthropic",
              mode: "oauth",
              email: "user@example.com",
            },
          },
          order: {
            anthropic: ["anthropic:user@example.com"],
          },
        },
      },
    });

    const { config: next } = await maybeRepairLegacyOAuthProfileIds(
      {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "oauth" },
          },
          order: {
            anthropic: ["anthropic:default"],
          },
        },
      } as OpenClawConfig,
      makePrompter(true),
    );

    expect(repairMocks.repairOAuthProfileIdMismatch).toHaveBeenCalledOnce();
    const repairCall = requireFirstMockArg(
      repairMocks.repairOAuthProfileIdMismatch,
      "OAuth profile repair",
    ) as {
      cfg?: OpenClawConfig;
      store?: AuthProfileStore;
      provider?: unknown;
      legacyProfileId?: unknown;
    };
    expect(repairCall.cfg?.auth?.profiles?.["anthropic:default"]).toEqual({
      provider: "anthropic",
      mode: "oauth",
    });
    expect(repairCall.store).toBe(authProfileStoreMock.store);
    expect(repairCall.provider).toBe("anthropic");
    expect(repairCall.legacyProfileId).toBe("anthropic:default");
    const auth = requireAuthConfig(next);
    expect(auth.profiles?.["anthropic:default"]).toBeUndefined();
    const repairedProfile = auth.profiles?.["anthropic:user@example.com"];
    expect(repairedProfile?.provider).toBe("anthropic");
    expect(repairedProfile?.mode).toBe("oauth");
    expect(repairedProfile?.email).toBe("user@example.com");
    expect(auth.order?.anthropic).toEqual(["anthropic:user@example.com"]);
  });

  it("removes a provider-declared retired auth profile and config references", async () => {
    authProfileStoreMock.store = {
      version: 1,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth",
          provider: "anthropic",
          access: "copied-native-access",
          refresh: "copied-native-refresh",
          expires: Date.now() + 60_000,
        },
        "anthropic:managed": {
          type: "api_key",
          provider: "anthropic",
          key: "managed-key",
        },
      },
    };
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "anthropic",
        label: "Anthropic",
        auth: [],
        deprecatedProfileIds: ["anthropic:claude-cli"],
      },
    ]);
    providerPolicyMocks.applyConfigDefaults.mockImplementation(({ config }) => ({
      ...config,
      agents: {
        ...config.agents,
        defaults: {
          ...config.agents?.defaults,
          models: {
            ...config.agents?.defaults?.models,
            "anthropic/claude-sonnet-4-6": {
              agentRuntime: { id: "claude-cli" },
            },
          },
        },
      },
    }));

    const result = await maybeRepairLegacyOAuthProfileIds(
      {
        auth: {
          profiles: {
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
            "anthropic:managed": { provider: "anthropic", mode: "api_key" },
          },
          order: {
            anthropic: ["anthropic:claude-cli", "anthropic:managed"],
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
          },
        },
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              apiKey: "anthropic:claude-cli",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      makePrompter(true),
    );

    const next = result.config;
    expect(next.auth?.profiles).toEqual({
      "anthropic:managed": { provider: "anthropic", mode: "api_key" },
    });
    expect(next.auth?.order?.anthropic).toEqual(["anthropic:managed"]);
    expect(next.agents?.defaults?.models?.["anthropic/claude-sonnet-4-6"]?.agentRuntime).toEqual({
      id: "claude-cli",
    });
    expect(providerPolicyMocks.applyConfigDefaults).toHaveBeenCalledOnce();
    expect(next.models?.providers?.anthropic?.apiKey).toBeUndefined();
    expect(result.retiredProfileCleanupPlans).toContainEqual({
      agentDir: undefined,
      profileIds: ["anthropic:claude-cli"],
    });
  });

  it.each([
    { auth: { profiles: { "anthropic:claude-cli": { provider: "claude-cli", mode: "api_key" } } } },
    { auth: { order: { anthropic: ["anthropic:claude-cli"] } } },
    {
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            apiKey: "anthropic:claude-cli",
            models: [],
          },
        },
      },
    },
  ] satisfies OpenClawConfig[])(
    "removes config-only retired profile references (%#)",
    async (cfg) => {
      resolvePluginProvidersMock.mockReturnValue([
        {
          id: "anthropic",
          label: "Anthropic",
          auth: [],
          deprecatedProfileIds: ["anthropic:claude-cli"],
        },
      ]);

      const prompter = makePrompter(true);
      const { config: next, retiredProfileCleanupPlans } = await maybeRepairLegacyOAuthProfileIds(
        cfg,
        prompter,
      );

      expect(prompter.confirm).toHaveBeenCalledOnce();
      expect(next.auth?.profiles?.["anthropic:claude-cli"]).toBeUndefined();
      expect(next.auth?.order?.anthropic).toBeUndefined();
      expect(next.models?.providers?.anthropic?.apiKey).toBeUndefined();
      expect(retiredProfileCleanupPlans).toEqual([]);
      expect(providerPolicyMocks.applyConfigDefaults).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "respects secondary agent cleanup confirmation (accept=%s)",
    async (accepted) => {
      const secondaryAgentDir = "/tmp/state/agents/secondary/agent";
      candidateMocks.candidates = [
        { agentDir: undefined, authPath: "/tmp/shared/openclaw-agent.sqlite" },
        { agentDir: secondaryAgentDir, authPath: `${secondaryAgentDir}/openclaw-agent.sqlite` },
      ];
      candidateMocks.stores.set(secondaryAgentDir, {
        version: 1,
        profiles: {
          "anthropic:claude-cli": {
            type: "oauth",
            provider: "anthropic",
            access: "copied-native-access",
            refresh: "copied-native-refresh",
            expires: Date.now() + 60_000,
          },
        },
      });
      resolvePluginProvidersMock.mockReturnValue([
        {
          id: "anthropic",
          label: "Anthropic",
          auth: [],
          deprecatedProfileIds: ["anthropic:claude-cli"],
        },
      ]);

      const result = await maybeRepairLegacyOAuthProfileIds({}, makePrompter(accepted));

      expect(result.retiredProfileCleanupPlans).toEqual(
        accepted
          ? [
              {
                agentDir: secondaryAgentDir,
                profileIds: ["anthropic:claude-cli"],
              },
            ]
          : [],
      );
    },
  );

  it("repairs selected provider routing for a store-only retired profile", async () => {
    authProfileStoreMock.store = {
      version: 1,
      profiles: {
        "anthropic:claude-cli": {
          type: "oauth",
          provider: "claude-cli",
          access: "copied-native-access",
          refresh: "copied-native-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "anthropic",
        label: "Anthropic",
        auth: [],
        deprecatedProfileIds: ["anthropic:claude-cli"],
      },
    ]);

    const result = await maybeRepairLegacyOAuthProfileIds(
      {
        agents: { defaults: { model: { primary: "claude-cli/claude-sonnet-4-6" } } },
      } as OpenClawConfig,
      makePrompter(true),
    );

    expect(providerPolicyMocks.applyConfigDefaults).toHaveBeenCalledOnce();
    expect(result.retiredProfileCleanupPlans).toContainEqual({
      agentDir: undefined,
      profileIds: ["anthropic:claude-cli"],
    });
  });

  it("strips provider-controlled terminal escapes from repair prompts", async () => {
    authProfileStoreMock.store = {
      version: 1,
      profiles: {
        "anthropic:user@example.com": {
          type: "oauth",
          provider: "anthropic",
          access: "token-a",
          refresh: "token-r",
          expires: Date.now() + 60_000,
          email: "user@example.com",
        },
      },
    };

    resolvePluginProvidersMock.mockReturnValue([
      {
        id: "anthropic",
        label: "\u001b[31mAnthropic\u001b[0m",
        auth: [],
        oauthProfileIdRepairs: [
          { legacyProfileId: "anthropic:default", promptLabel: "\u001b[2JBad\u0007 Label" },
        ],
      },
    ]);
    repairMocks.repairOAuthProfileIdMismatch.mockReturnValue({
      migrated: true,
      changes: ["Auth: migrate anthropic:default to anthropic:user@example.com"],
      config: { auth: { profiles: {} } },
    });

    const prompter = makePrompter(true);
    await maybeRepairLegacyOAuthProfileIds(
      {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "oauth" },
          },
        },
      } as OpenClawConfig,
      prompter,
    );

    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "Update Bad Label OAuth profile id in config now?",
      initialValue: true,
    });
  });
});
