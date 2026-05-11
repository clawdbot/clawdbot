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

type LoginOpenAICodexOAuth = (params: unknown) => Promise<{
  access: string;
  refresh: string;
  expires: number;
  email?: string;
} | null>;
type EnsureAuthProfileStore =
  typeof import("openclaw/plugin-sdk/provider-auth").ensureAuthProfileStore;
type ListProfilesForProvider =
  typeof import("openclaw/plugin-sdk/provider-auth").listProfilesForProvider;

const ensureAuthProfileStoreMock = vi.hoisted(() => vi.fn<EnsureAuthProfileStore>());
const listProfilesForProviderMock = vi.hoisted(() => vi.fn<ListProfilesForProvider>());

export type ProviderAuthContractPluginLoader = () => Promise<{
  default: Parameters<typeof registerProviders>[0];
}>;

export type OpenAICodexProviderAuthContractOptions = {
  loginOpenAICodexOAuthMock: ReturnType<typeof vi.fn<LoginOpenAICodexOAuth>>;
};

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
            "openai/gpt-5.5": {},
          },
        },
      },
    },
    defaultModel: "openai/gpt-5.5",
    notes: undefined,
  };
}

function installSharedAuthProfileStoreHooks(state: { authStore: AuthProfileStore }) {
  beforeEach(() => {
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
    ensureAuthProfileStoreMock.mockReset();
    listProfilesForProviderMock.mockReset();
    clearRuntimeAuthProfileStoreSnapshots();
  });
}

export function describeOpenAICodexProviderAuthContract(
  load: ProviderAuthContractPluginLoader,
  options: OpenAICodexProviderAuthContractOptions,
) {
  const state = {
    authStore: { version: 1, profiles: {} } as AuthProfileStore,
  };
  const { loginOpenAICodexOAuthMock } = options;

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

    it("surfaces OAuth failures instead of silently succeeding with no profiles", async () => {
      const provider = await getProvider();
      loginOpenAICodexOAuthMock.mockRejectedValueOnce(new Error("oauth failed"));

      await expect(provider.auth[0]?.run(buildAuthContext() as never)).rejects.toThrow(
        "oauth failed",
      );
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

    it("keeps existing device auth results provider-owned", async () => {
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

    function stubGitHubDeviceFlowFetch(
      outcome: { accessToken: string } | { error: "access_denied" | "expired_token" },
    ) {
      const fetchMock = vi.fn(async (input: unknown) => {
        const target =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input instanceof Request
                ? input.url
                : String(input);
        if (target === "https://github.com/login/device/code") {
          return new Response(
            JSON.stringify({
              device_code: "device-code-stub",
              user_code: "ABCD-1234",
              verification_uri: "https://github.com/login/device",
              expires_in: 900,
              interval: 0,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (target === "https://github.com/login/oauth/access_token") {
          const body =
            "accessToken" in outcome
              ? { access_token: outcome.accessToken, token_type: "bearer" }
              : { error: outcome.error };
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch in github-copilot device flow stub: ${target}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    function buildSpyAuthContext() {
      const ctx = buildAuthContext() as ReturnType<typeof buildAuthContext> & {
        openUrl: (url: string) => Promise<void>;
        prompter: WizardPrompter;
      };
      ctx.openUrl = vi.fn(async () => {});
      ctx.prompter.note = vi.fn(async () => {});
      return ctx;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("keeps device auth results provider-owned", async () => {
      const provider = await getProvider();
      stubGitHubDeviceFlowFetch({ accessToken: "github-device-token" });
      const ctx = buildSpyAuthContext();

      const result = await provider.auth[0]?.run(ctx as never);

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
      // Credential is sourced from the device flow response, not from the existing
      // on-disk auth store. ensureAuthProfileStore is still called by the
      // resolveExistingCopilotAuthResult existence check, which legitimately probes
      // the store before launching the device flow when no profile exists yet.
    });

    it("uses the wizard prompter and openUrl hooks for the device code (no stdin/stdout)", async () => {
      const provider = await getProvider();
      stubGitHubDeviceFlowFetch({ accessToken: "github-device-token" });
      const ctx = buildSpyAuthContext();

      await provider.auth[0]?.run(ctx as never);

      expect(ctx.openUrl).toHaveBeenCalledWith("https://github.com/login/device");
      const noteCalls = (ctx.prompter.note as ReturnType<typeof vi.fn>).mock.calls;
      const codeNote = noteCalls.find(
        ([msg]) => typeof msg === "string" && msg.includes("ABCD-1234"),
      );
      expect(codeNote).toBeDefined();
      expect(codeNote?.[0]).toContain("https://github.com/login/device");
    });

    it("supports non-interactive (GUI/RPC) auth contexts without a TTY", async () => {
      const provider = await getProvider();
      const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
      const hadOwnIsTTY = Object.prototype.hasOwnProperty.call(stdin, "isTTY");
      const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
      Object.defineProperty(stdin, "isTTY", {
        configurable: true,
        enumerable: true,
        get: () => false,
      });
      stubGitHubDeviceFlowFetch({ accessToken: "rpc-client-token" });
      const ctx = buildSpyAuthContext();

      try {
        const result = await provider.auth[0]?.run(ctx as never);
        expect(result?.profiles).toEqual([
          {
            profileId: "github-copilot:github",
            credential: {
              type: "token",
              provider: "github-copilot",
              token: "rpc-client-token",
            },
          },
        ]);
      } finally {
        if (previousIsTTYDescriptor) {
          Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
        } else if (!hadOwnIsTTY) {
          delete (stdin as { isTTY?: boolean }).isTTY;
        }
      }
    });

    it("returns no profiles and notes cancellation when the user denies access", async () => {
      const provider = await getProvider();
      stubGitHubDeviceFlowFetch({ error: "access_denied" });
      const ctx = buildSpyAuthContext();

      const result = await provider.auth[0]?.run(ctx as never);

      expect(result).toEqual({ profiles: [] });
      const noteCalls = (ctx.prompter.note as ReturnType<typeof vi.fn>).mock.calls;
      expect(
        noteCalls.some(([msg]) => typeof msg === "string" && msg.toLowerCase().includes("cancel")),
      ).toBe(true);
    });

    it("returns no profiles and notes expiry when the device code expires", async () => {
      const provider = await getProvider();
      stubGitHubDeviceFlowFetch({ error: "expired_token" });
      const ctx = buildSpyAuthContext();

      const result = await provider.auth[0]?.run(ctx as never);

      expect(result).toEqual({ profiles: [] });
      const noteCalls = (ctx.prompter.note as ReturnType<typeof vi.fn>).mock.calls;
      expect(
        noteCalls.some(([msg]) => typeof msg === "string" && msg.toLowerCase().includes("expired")),
      ).toBe(true);
    });
  });
}
