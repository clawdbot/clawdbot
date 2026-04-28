import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots, type AuthProfileStore } from "../agent-runtime.js";
import { createNonExitingRuntime } from "../runtime.js";
import type {
  WizardMultiSelectParams,
  WizardPrompter,
  WizardProgress,
  WizardSelectParams,
} from "../setup.js";
import { registerProviders, requireProvider } from "./contracts-testkit.js";

type LoginOpenAICodexOAuth =
  (typeof import("openclaw/plugin-sdk/provider-auth-login"))["loginOpenAICodexOAuth"];
type GithubCopilotLoginCommand =
  (typeof import("openclaw/plugin-sdk/provider-auth-login"))["githubCopilotLoginCommand"];
type EnsureAuthProfileStore =
  typeof import("openclaw/plugin-sdk/provider-auth").ensureAuthProfileStore;
type ListProfilesForProvider =
  typeof import("openclaw/plugin-sdk/provider-auth").listProfilesForProvider;

const loginOpenAICodexOAuthMock = vi.hoisted(() => vi.fn<LoginOpenAICodexOAuth>());
const githubCopilotLoginCommandMock = vi.hoisted(() => vi.fn<GithubCopilotLoginCommand>());
const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn<EnsureAuthProfileStore>());
const listProfilesForProviderMock = vi.hoisted(() => vi.fn<ListProfilesForProvider>());

export type ProviderAuthContractPluginLoader = () => Promise<{
  default: Parameters<typeof registerProviders>[0];
}>;

function buildPrompter(): WizardPrompter {
  const progress: WizardProgress = {
    update() {},
    stop() {},
  };
  return {
    intro: async () => {},
    outro: async () => {},
    note: async () => {},
    select: async <T>(params: WizardSelectParams<T>) => {
      const option = params.options[0];
      if (!option) {
        throw new Error("missing select option");
      }
      return option.value;
    },
    multiselect: async <T>(params: WizardMultiSelectParams<T>) => params.initialValues ?? [],
    text: async () => "",
    confirm: async () => false,
    progress: () => progress,
  };
}

function buildAuthContext() {
  return {
    config: {},
    prompter: buildPrompter(),
    runtime: createNonExitingRuntime(),
    isRemote: false,
    openUrl: async () => {},
    oauth: {
      createVpsAwareHandlers: vi.fn(),
    },
  };
}

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function buildOpenAICodexOAuthResult(params: {
  profileId: string;
  access: string;
  refresh: string;
  expires: number;
  email?: string;
}) {
  return {
    profiles: [
      {
        profileId: params.profileId,
        credential: {
          type: "oauth" as const,
          provider: "openai-codex",
          access: params.access,
          refresh: params.refresh,
          expires: params.expires,
          ...(params.email ? { email: params.email } : {}),
        },
      },
    ],
    configPatch: {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.5": {},
          },
        },
      },
    },
    defaultModel: "openai-codex/gpt-5.5",
    notes: undefined,
  };
}

function installSharedAuthProfileStoreHooks(state: { authStore: AuthProfileStore }) {
  beforeEach(() => {
    vi.doMock("openclaw/plugin-sdk/provider-auth-login", async () => {
      const actual = await vi.importActual<
        typeof import("openclaw/plugin-sdk/provider-auth-login")
      >("openclaw/plugin-sdk/provider-auth-login");
      return {
        ...actual,
        loginOpenAICodexOAuth: loginOpenAICodexOAuthMock,
        githubCopilotLoginCommand: githubCopilotLoginCommandMock,
      };
    });
    vi.doMock("openclaw/plugin-sdk/provider-auth", async () => {
      const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-auth")>(
        "openclaw/plugin-sdk/provider-auth",
      );
      return {
        ...actual,
        ensureAuthProfileStore: ensureAuthProfileStoreMock,
        listProfilesForProvider: listProfilesForProviderMock,
      };
    });
    state.authStore = { version: 1, profiles: {} };
    ensureAuthProfileStoreMock.mockReset();
    ensureAuthProfileStoreMock.mockImplementation(() => state.authStore);
    listProfilesForProviderMock.mockReset();
    listProfilesForProviderMock.mockImplementation((store, providerId) =>
      Object.entries(store.profiles)
        .filter(([, credential]) => credential?.provider === providerId)
        .map(([profileId]) => profileId),
    );
  });

  afterEach(() => {
    loginOpenAICodexOAuthMock.mockReset();
    githubCopilotLoginCommandMock.mockReset();
    ensureAuthProfileStoreMock.mockReset();
    listProfilesForProviderMock.mockReset();
    clearRuntimeAuthProfileStoreSnapshots();
  });
}

export function describeOpenAICodexProviderAuthContract(load: ProviderAuthContractPluginLoader) {
  const state = {
    authStore: { version: 1, profiles: {} } as AuthProfileStore,
  };

  describe("openai-codex provider auth contract", () => {
    installSharedAuthProfileStoreHooks(state);

    async function expectStableFallbackProfile(params: { access: string; profileId: string }) {
      const { default: openAIPlugin } = await load();
      const provider = requireProvider(await registerProviders(openAIPlugin), "openai-codex");
      loginOpenAICodexOAuthMock.mockResolvedValueOnce({
        refresh: "refresh-token",
        access: params.access,
        expires: 1_700_000_000_000,
      });
      const result = await provider.auth[0]?.run(buildAuthContext() as never);
      expect(result).toEqual(
        buildOpenAICodexOAuthResult({
          profileId: params.profileId,
          access: params.access,
          refresh: "refresh-token",
          expires: 1_700_000_000_000,
        }),
      );
    }

    async function getProvider() {
      const { default: openAIPlugin } = await load();
      return requireProvider(await registerProviders(openAIPlugin), "openai-codex");
    }

    it("keeps OAuth auth results provider-owned", async () => {
      const provider = await getProvider();
      loginOpenAICodexOAuthMock.mockResolvedValueOnce({
        email: "user@example.com",
        refresh: "refresh-token",
        access: "access-token",
        expires: 1_700_000_000_000,
      });

      const result = await provider.auth[0]?.run(buildAuthContext() as never);

      expect(result).toEqual(
        buildOpenAICodexOAuthResult({
          profileId: "openai-codex:user@example.com",
          access: "access-token",
          refresh: "refresh-token",
          expires: 1_700_000_000_000,
          email: "user@example.com",
        }),
      );
    });

    it("backfills OAuth email from the JWT profile claim", async () => {
      const provider = await getProvider();
      const access = createJwt({
        "https://api.openai.com/profile": {
          email: "jwt-user@example.com",
        },
      });
      loginOpenAICodexOAuthMock.mockResolvedValueOnce({
        refresh: "refresh-token",
        access,
        expires: 1_700_000_000_000,
      });

      const result = await provider.auth[0]?.run(buildAuthContext() as never);

      expect(result).toEqual(
        buildOpenAICodexOAuthResult({
          profileId: "openai-codex:jwt-user@example.com",
          access,
          refresh: "refresh-token",
          expires: 1_700_000_000_000,
          email: "jwt-user@example.com",
        }),
      );
    });

    it("uses a stable fallback id when JWT email is missing", async () => {
      const access = createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_user_id: "user-123__acct-456",
        },
      });
      const expectedStableId = Buffer.from("user-123__acct-456", "utf8").toString("base64url");
      await expectStableFallbackProfile({
        access,
        profileId: `openai-codex:id-${expectedStableId}`,
      });
    });

    it("uses iss and sub to build a stable fallback id when auth claims are missing", async () => {
      const access = createJwt({
        iss: "https://accounts.openai.com",
        sub: "user-abc",
      });
      const expectedStableId = Buffer.from("https://accounts.openai.com|user-abc").toString(
        "base64url",
      );
      await expectStableFallbackProfile({
        access,
        profileId: `openai-codex:id-${expectedStableId}`,
      });
    });

    it("uses sub alone to build a stable fallback id when iss is missing", async () => {
      const access = createJwt({
        sub: "user-abc",
      });
      const expectedStableId = Buffer.from("user-abc").toString("base64url");
      await expectStableFallbackProfile({
        access,
        profileId: `openai-codex:id-${expectedStableId}`,
      });
    });

    it("falls back to the default profile when JWT parsing yields no identity", async () => {
      const provider = await getProvider();
      loginOpenAICodexOAuthMock.mockResolvedValueOnce({
        refresh: "refresh-token",
        access: "not-a-jwt-token",
        expires: 1_700_000_000_000,
      });

      const result = await provider.auth[0]?.run(buildAuthContext() as never);

      expect(result).toEqual(
        buildOpenAICodexOAuthResult({
          profileId: "openai-codex:default",
          access: "not-a-jwt-token",
          refresh: "refresh-token",
          expires: 1_700_000_000_000,
        }),
      );
    });

    it("keeps OAuth failures non-fatal at the provider layer", async () => {
      const provider = await getProvider();
      loginOpenAICodexOAuthMock.mockRejectedValueOnce(new Error("oauth failed"));

      await expect(provider.auth[0]?.run(buildAuthContext() as never)).resolves.toEqual({
        profiles: [],
      });
    });
  });
}

export function describeGithubCopilotProviderAuthContract(load: ProviderAuthContractPluginLoader) {
  const state = {
    authStore: { version: 1, profiles: {} } as AuthProfileStore,
  };

  describe("github-copilot provider auth contract", () => {
    installSharedAuthProfileStoreHooks(state);

    async function getProvider() {
      const { default: githubCopilotPlugin } = await load();
      return requireProvider(await registerProviders(githubCopilotPlugin), "github-copilot");
    }

    it("keeps device auth results provider-owned", async () => {
      const provider = await getProvider();
      state.authStore.profiles["github-copilot:github"] = {
        type: "token",
        provider: "github-copilot",
        token: "github-device-token",
      };

      const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
      const hadOwnIsTTY = Object.prototype.hasOwnProperty.call(stdin, "isTTY");
      const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
      Object.defineProperty(stdin, "isTTY", {
        configurable: true,
        enumerable: true,
        get: () => true,
      });

      try {
        const result = await provider.auth[0]?.run(buildAuthContext() as never);
        expect(githubCopilotLoginCommandMock).toHaveBeenCalledWith(
          { yes: true, profileId: "github-copilot:github" },
          expect.any(Object),
        );
        expect(result).toEqual({
          profiles: [
            {
              profileId: "github-copilot:github",
              credential: {
                type: "token",
                provider: "github-copilot",
                token: "github-device-token",
              },
            },
          ],
          defaultModel: "github-copilot/claude-opus-4.7",
        });
      } finally {
        if (previousIsTTYDescriptor) {
          Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
        } else if (!hadOwnIsTTY) {
          delete (stdin as { isTTY?: boolean }).isTTY;
        }
      }
    });

    it("keeps auth gated on interactive TTYs", async () => {
      const provider = await getProvider();
      const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
      const hadOwnIsTTY = Object.prototype.hasOwnProperty.call(stdin, "isTTY");
      const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
      Object.defineProperty(stdin, "isTTY", {
        configurable: true,
        enumerable: true,
        get: () => false,
      });

      try {
        await expect(provider.auth[0]?.run(buildAuthContext() as never)).resolves.toEqual({
          profiles: [],
        });
        expect(githubCopilotLoginCommandMock).not.toHaveBeenCalled();
      } finally {
        if (previousIsTTYDescriptor) {
          Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
        } else if (!hadOwnIsTTY) {
          delete (stdin as { isTTY?: boolean }).isTTY;
        }
      }
    });
  });
}
