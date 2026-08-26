// Codex tests cover auth bridge plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreForSecretsRuntime,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions,
  refreshCodexAppServerAuthTokens,
  reconcileCodexComputerUseStartArtifacts,
  resolveCodexAppServerAuthAccountCacheKey,
  resolveCodexAppServerAuthProfileId,
  resolveCodexAppServerAuthProfileStore,
  resolveCodexAppServerFallbackApiKeyCacheKey,
  resolveCodexAppServerHomeDir,
  resolveCodexAppServerPreparedAuthHandoff,
  resolveCodexAppServerPreparedAuthProfileSnapshot,
  resolveCodexAppServerPreparedApiKeyCacheKey,
} from "./auth-bridge.js";
import type { CodexAppServerStartOptions } from "./config.js";
import { resolveMacOSDesktopCodexAppPathCandidates } from "./desktop-app-paths.js";
import { resolveCodexAppServerSpawnEnv } from "./transport-stdio.js";

const oauthMocks = vi.hoisted(() => ({
  refreshOpenAICodexToken: vi.fn(),
}));

type MockDesktopCandidate = ReturnType<typeof resolveMacOSDesktopCodexAppPathCandidates>[number];
type MockCacheResult = {
  status: "independent" | "shared";
  changed: boolean;
  message: string;
  removedStaleVersions: string[];
  warnings: string[];
};

const computerUseServiceMocks = vi.hoisted(() => ({
  ensureCodexComputerUseSharedPluginCache: vi.fn<
    (_params: { forceRefresh?: boolean }) => Promise<MockCacheResult>
  >(async () => ({
    status: "independent",
    changed: false,
    message: "independent",
    removedStaleVersions: [],
    warnings: [],
  })),
  ensureCodexManagedBundledMarketplace: vi.fn<(_params?: unknown) => Promise<string | undefined>>(
    async () => undefined,
  ),
  ensureCodexComputerUseServiceApp: vi.fn<
    (_params?: unknown) => Promise<{
      status: "already_current" | "source_missing";
      changed: boolean;
    }>
  >(async () => ({ status: "already_current", changed: false })),
  resolveCodexManagedBundledMarketplaceSource: vi.fn<
    (params: {
      candidates?: readonly MockDesktopCandidate[];
    }) => Promise<MockDesktopCandidate | undefined>
  >(async (params) => params.candidates?.[0]),
  resolveCodexComputerUseServiceAppSourcePath: vi.fn<
    (params: { sourceAppCandidates?: readonly string[] }) => Promise<string | undefined>
  >(async (params) => params.sourceAppCandidates?.[0]),
}));

const providerRuntimeMocks = vi.hoisted(() => ({
  formatProviderAuthProfileApiKeyWithPlugin: vi.fn(),
  refreshProviderOAuthCredentialWithPlugin: vi.fn(
    async (params: { provider?: string; context: { refresh: string } }) => {
      const refreshed = await oauthMocks.refreshOpenAICodexToken(params.context.refresh);
      return refreshed
        ? {
            ...params.context,
            ...refreshed,
            type: "oauth",
            provider: "openai",
          }
        : undefined;
    },
  ),
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>();
  return {
    ...actual,
    resolveApiKeyForProfile: async (
      params: Parameters<typeof actual.resolveApiKeyForProfile>[0],
    ) => {
      const credential = params.store.profiles[params.profileId];
      if (!credential) {
        return null;
      }
      if (credential.type === "api_key") {
        const apiKey =
          credential.key?.trim() ||
          (credential.keyRef?.source === "env" ? process.env[credential.keyRef.id]?.trim() : "");
        return apiKey ? { apiKey, provider: credential.provider } : null;
      }
      if (credential.type === "token") {
        const apiKey =
          credential.token?.trim() ||
          (credential.tokenRef?.source === "env"
            ? process.env[credential.tokenRef.id]?.trim()
            : "");
        return apiKey ? { apiKey, provider: credential.provider, email: credential.email } : null;
      }
      if (credential.type !== "oauth") {
        return null;
      }
      let oauthCredential = credential;
      if (params.forceRefresh || (oauthCredential.expires ?? 0) <= Date.now()) {
        const refreshed = await providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin({
          provider: oauthCredential.provider,
          context: oauthCredential,
        });
        if (refreshed?.access) {
          oauthCredential = refreshed as typeof oauthCredential;
          params.store.profiles[params.profileId] = oauthCredential;
          if (params.agentDir || process.env.OPENCLAW_STATE_DIR) {
            actual.saveAuthProfileStore(params.store, params.agentDir);
          }
        }
      }
      const formatted = await providerRuntimeMocks.formatProviderAuthProfileApiKeyWithPlugin({
        provider: oauthCredential.provider,
        context: oauthCredential,
      });
      const apiKey =
        typeof formatted === "string" && formatted ? formatted : oauthCredential.access;
      return apiKey
        ? { apiKey, provider: oauthCredential.provider, email: oauthCredential.email }
        : null;
    },
    refreshOAuthCredentialForRuntime: async (
      params: Parameters<typeof actual.refreshOAuthCredentialForRuntime>[0],
    ) => {
      const refreshed = await providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin({
        provider: params.credential.provider,
        context: params.credential,
      });
      return refreshed
        ? {
            ...params.credential,
            ...refreshed,
            type: "oauth" as const,
          }
        : null;
    },
  };
});

vi.mock("./computer-use-service.js", () => ({
  ensureCodexComputerUseServiceApp: computerUseServiceMocks.ensureCodexComputerUseServiceApp,
  resolveCodexComputerUseServiceAppSourcePath:
    computerUseServiceMocks.resolveCodexComputerUseServiceAppSourcePath,
}));

vi.mock("./computer-use-marketplace.js", () => ({
  ensureCodexManagedBundledMarketplace:
    computerUseServiceMocks.ensureCodexManagedBundledMarketplace,
  resolveCodexManagedBundledMarketplaceSource:
    computerUseServiceMocks.resolveCodexManagedBundledMarketplaceSource,
}));

vi.mock("./computer-use-cache.js", () => ({
  ensureCodexComputerUseSharedPluginCache:
    computerUseServiceMocks.ensureCodexComputerUseSharedPluginCache,
}));

vi.mock("./desktop-app-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./desktop-app-paths.js")>();
  return {
    ...actual,
    resolveMacOSDesktopCodexAppPathCandidates: (platform?: NodeJS.Platform) =>
      actual.resolveMacOSDesktopCodexAppPathCandidates(platform ?? "darwin"),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearRuntimeAuthProfileStoreSnapshots();
  oauthMocks.refreshOpenAICodexToken.mockReset();
  providerRuntimeMocks.formatProviderAuthProfileApiKeyWithPlugin.mockReset();
  providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin.mockClear();
  computerUseServiceMocks.ensureCodexComputerUseServiceApp.mockClear();
  computerUseServiceMocks.ensureCodexManagedBundledMarketplace.mockClear();
  computerUseServiceMocks.ensureCodexComputerUseSharedPluginCache.mockReset();
  computerUseServiceMocks.ensureCodexComputerUseSharedPluginCache.mockResolvedValue({
    status: "independent",
    changed: false,
    message: "independent",
    removedStaleVersions: [],
    warnings: [],
  });
  computerUseServiceMocks.resolveCodexManagedBundledMarketplaceSource.mockReset();
  computerUseServiceMocks.resolveCodexManagedBundledMarketplaceSource.mockImplementation(
    async (params) => params.candidates?.[0],
  );
  computerUseServiceMocks.resolveCodexComputerUseServiceAppSourcePath.mockReset();
  computerUseServiceMocks.resolveCodexComputerUseServiceAppSourcePath.mockImplementation(
    async (params: { sourceAppCandidates?: readonly string[] }) => params.sourceAppCandidates?.[0],
  );
});

function createStartOptions(
  overrides: Partial<CodexAppServerStartOptions> = {},
): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command: "codex",
    commandSource: "resolved-managed",
    args: ["app-server"],
    headers: { authorization: "Bearer dev-token" },
    ...overrides,
  };
}

const EPHEMERAL_AUTH_ARGS = ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"'];

async function expectPathMissing(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected missing path: ${filePath}`);
}

type AuthProfileStore = ReturnType<typeof loadAuthProfileStoreForSecretsRuntime>;
type AuthProfileCredential = AuthProfileStore["profiles"][string];

function expectOAuthProfile(
  profile: AuthProfileCredential | undefined,
): Extract<AuthProfileCredential, { type: "oauth" }> {
  if (!profile || profile.type !== "oauth") {
    throw new Error("Expected OAuth auth profile");
  }
  return profile;
}

function chatgptAccessToken(accountId: string, subject?: string): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
        ...(subject ? { sub: subject } : {}),
      }),
    ).toString("base64url"),
    "test-signature",
  ].join(".");
}

async function writeCodexCliAuthFile(codexHome: string): Promise<void> {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "auth.json"),
    `${JSON.stringify({
      tokens: {
        access_token: "cli-access-token",
        refresh_token: "cli-refresh-token",
        account_id: "account-cli",
      },
    })}\n`,
  );
}

async function writeCodexCliApiKeyAuthFile(codexHome: string): Promise<void> {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "auth.json"),
    `${JSON.stringify({
      auth_mode: "apikey",
      OPENAI_API_KEY: "cli-auth-json-api-key",
    })}\n`,
  );
}

describe("bridgeCodexAppServerStartOptions", () => {
  it("never overlays persisted profiles onto a supplied runtime store", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const authProfileStore = { version: 1, profiles: {} };
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "persisted-access",
          refresh: "persisted-refresh",
          expires: Date.now() + 60_000,
        },
      });

      expect(
        resolveCodexAppServerAuthProfileStore({
          agentDir,
          authProfileId: "openai:work",
          authProfileStore,
        }),
      ).toBe(authProfileStore);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("sets agent-owned CODEX_HOME without overriding HOME for local app-server launches", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = createStartOptions();
    try {
      const codexHome = resolveCodexAppServerHomeDir(agentDir);

      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
        }),
      ).resolves.toEqual({
        ...startOptions,
        args: EPHEMERAL_AUTH_ARGS,
        env: {
          CODEX_HOME: codexHome,
        },
      });
      await expect(fs.access(codexHome)).resolves.toBeUndefined();
      expect(startOptions.env).toBeUndefined();
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it.each(["subscription", "api-key"] as const)(
    "rejects an unimported agent-scoped Codex auth file for a %s route without fallback",
    async (authRequirement) => {
      await withTempDir("openclaw-codex-unimported-auth-", async (agentDir) => {
        const codexHome = resolveCodexAppServerHomeDir(agentDir);
        await writeCodexCliAuthFile(codexHome);
        vi.stubEnv("CODEX_API_KEY", "");
        vi.stubEnv("OPENAI_API_KEY", "");
        vi.stubEnv("CODEX_HOME", "");
        vi.stubEnv("HOME", path.join(agentDir, "empty-home"));

        await expect(
          bridgeCodexAppServerStartOptions({
            startOptions: createStartOptions({ headers: {} }),
            agentDir,
            agentId: "research",
            authRequirement,
          }),
        ).rejects.toMatchObject({
          name: "AgentHarnessPreflightError",
          message: expect.stringContaining(
            "openclaw migrate apply codex --from <codex-home> --agent research --include-secrets --item auth:openai --yes",
          ),
        });
      });
    },
  );

  it.each(["CODEX_API_KEY", "OPENAI_API_KEY"] as const)(
    "preserves the %s fallback when a stale agent auth file remains",
    async (envVar) => {
      await withTempDir("openclaw-codex-stale-auth-api-key-", async (agentDir) => {
        await writeCodexCliAuthFile(resolveCodexAppServerHomeDir(agentDir));
        vi.stubEnv("CODEX_API_KEY", "");
        vi.stubEnv("OPENAI_API_KEY", "");
        vi.stubEnv(envVar, "platform-api-key");

        const startOptions = await bridgeCodexAppServerStartOptions({
          startOptions: createStartOptions(),
          agentDir,
          agentId: "research",
          authRequirement: "api-key",
        });
        expect(startOptions).toMatchObject({
          args: EPHEMERAL_AUTH_ARGS,
          env: { CODEX_HOME: resolveCodexAppServerHomeDir(agentDir) },
        });

        const request = vi.fn(async (method: string) =>
          method === "account/read"
            ? { account: null, requiresOpenaiAuth: true }
            : { type: "apiKey" },
        );
        await applyCodexAppServerAuthProfile({
          client: { request } as never,
          agentDir,
          authRequirement: "api-key",
          startOptions,
        });
        expect(request).toHaveBeenNthCalledWith(1, "account/read", { refreshToken: false });
        expect(request).toHaveBeenNthCalledWith(2, "account/login/start", {
          type: "apiKey",
          apiKey: "platform-api-key",
        });
      });
    },
  );

  it.each(["websocket", "unix"] as const)(
    "ignores an agent-scoped auth file for %s transports",
    async (transport) => {
      await withTempDir("openclaw-codex-remote-auth-", async (agentDir) => {
        await writeCodexCliAuthFile(resolveCodexAppServerHomeDir(agentDir));
        const startOptions = createStartOptions({ transport });

        await expect(
          bridgeCodexAppServerStartOptions({ startOptions, agentDir, agentId: "research" }),
        ).resolves.toBe(startOptions);
      });
    },
  );

  it("provisions the native Computer Use client before auto-install startup", async () => {
    await withTempDir("openclaw-codex-computer-use-service-", async (agentDir) => {
      computerUseServiceMocks.ensureCodexManagedBundledMarketplace.mockResolvedValueOnce(
        "/managed/openai-bundled",
      );
      const startOptions = createStartOptions();
      const codexHome = resolveCodexAppServerHomeDir(agentDir);

      await reconcileCodexComputerUseStartArtifacts({
        startOptions,
        agentDir,
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      });

      expect(computerUseServiceMocks.ensureCodexComputerUseServiceApp).toHaveBeenCalledWith(
        expect.objectContaining({
          codexHome,
          ownershipRoot: agentDir,
        }),
      );
      expect(computerUseServiceMocks.ensureCodexManagedBundledMarketplace).toHaveBeenCalledWith(
        expect.objectContaining({
          codexHome,
          ownershipRoot: agentDir,
        }),
      );
    });
  });

  it("does not provision the native client without auto-install authorization", async () => {
    await withTempDir("openclaw-codex-computer-use-service-", async (agentDir) => {
      await reconcileCodexComputerUseStartArtifacts({
        startOptions: createStartOptions(),
        agentDir,
        pluginConfig: { computerUse: { enabled: true, autoInstall: false } },
      });

      expect(computerUseServiceMocks.ensureCodexComputerUseServiceApp).not.toHaveBeenCalled();
      expect(computerUseServiceMocks.ensureCodexManagedBundledMarketplace).not.toHaveBeenCalled();
    });
  });

  it("rejects a desktop candidate whose exact bundled marketplace is unavailable", async () => {
    await withTempDir("openclaw-codex-computer-use-source-missing-", async (agentDir) => {
      computerUseServiceMocks.resolveCodexManagedBundledMarketplaceSource.mockResolvedValueOnce(
        undefined,
      );

      await expect(
        reconcileCodexComputerUseStartArtifacts({
          startOptions: createStartOptions({
            command: "/Applications/ChatGPT.app/Contents/Resources/codex",
          }),
          agentDir,
          pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
        }),
      ).rejects.toMatchObject({
        code: "CODEX_COMPUTER_USE_CANDIDATE_ARTIFACTS_UNAVAILABLE",
      });
      expect(computerUseServiceMocks.ensureCodexComputerUseServiceApp).not.toHaveBeenCalled();
      expect(computerUseServiceMocks.ensureCodexManagedBundledMarketplace).not.toHaveBeenCalled();
    });
  });

  it("rejects a desktop candidate whose exact signed service is unavailable", async () => {
    await withTempDir("openclaw-codex-computer-use-service-missing-", async (agentDir) => {
      computerUseServiceMocks.resolveCodexComputerUseServiceAppSourcePath.mockResolvedValueOnce(
        undefined,
      );

      await expect(
        reconcileCodexComputerUseStartArtifacts({
          startOptions: createStartOptions({
            command: "/Applications/ChatGPT.app/Contents/Resources/codex",
          }),
          agentDir,
          pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
        }),
      ).rejects.toMatchObject({
        code: "CODEX_COMPUTER_USE_CANDIDATE_ARTIFACTS_UNAVAILABLE",
      });
      expect(computerUseServiceMocks.ensureCodexManagedBundledMarketplace).not.toHaveBeenCalled();
      expect(computerUseServiceMocks.ensureCodexComputerUseServiceApp).not.toHaveBeenCalled();
    });
  });

  it.each([
    { marketplaceSource: "file:///tmp/custom-marketplace" },
    { marketplacePath: "/tmp/custom-marketplace/marketplace.json" },
    { marketplaceName: "custom-marketplace" },
  ])("keeps an exact desktop candidate with configured marketplace selection", async (selector) => {
    await withTempDir("openclaw-codex-computer-use-custom-source-", async (agentDir) => {
      await expect(
        reconcileCodexComputerUseStartArtifacts({
          startOptions: createStartOptions({
            command: "/Applications/ChatGPT.app/Contents/Resources/codex",
          }),
          agentDir,
          pluginConfig: {
            computerUse: { enabled: true, autoInstall: true, ...selector },
          },
        }),
      ).resolves.toBeUndefined();
      expect(computerUseServiceMocks.ensureCodexManagedBundledMarketplace).not.toHaveBeenCalled();
      expect(computerUseServiceMocks.ensureCodexComputerUseServiceApp).toHaveBeenCalledOnce();
    });
  });

  it.each(["marketplace", "service"] as const)(
    "keeps package fallback artifacts on one complete desktop owner when ChatGPT lacks %s",
    async (missingArtifact) => {
      await withTempDir("openclaw-codex-computer-use-package-owner-", async (agentDir) => {
        const candidates = resolveMacOSDesktopCodexAppPathCandidates("darwin");
        const codexCandidate = candidates.find((candidate) => candidate.appName === "Codex.app");
        if (!codexCandidate) {
          throw new Error("expected Codex.app candidate");
        }
        computerUseServiceMocks.resolveCodexManagedBundledMarketplaceSource.mockImplementation(
          async (params) => {
            const candidate = params.candidates?.[0];
            return missingArtifact === "marketplace" && candidate?.appName === "ChatGPT.app"
              ? undefined
              : candidate;
          },
        );
        computerUseServiceMocks.resolveCodexComputerUseServiceAppSourcePath.mockImplementation(
          async (params: { sourceAppCandidates?: readonly string[] }) => {
            const source = params.sourceAppCandidates?.[0];
            return missingArtifact === "service" && source?.includes("ChatGPT.app")
              ? undefined
              : source;
          },
        );
        computerUseServiceMocks.ensureCodexManagedBundledMarketplace.mockResolvedValueOnce(
          "/managed/openai-bundled",
        );

        await reconcileCodexComputerUseStartArtifacts({
          startOptions: createStartOptions({ command: "/cache/openclaw/codex" }),
          agentDir,
          pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
        });

        expect(computerUseServiceMocks.ensureCodexManagedBundledMarketplace).toHaveBeenCalledWith(
          expect.objectContaining({
            candidates: [codexCandidate],
            appServerCommand: codexCandidate.appServerCommandPath,
          }),
        );
        expect(computerUseServiceMocks.ensureCodexComputerUseServiceApp).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceAppCandidates: codexCandidate.computerUseServiceAppPaths,
            appServerCommand: codexCandidate.appServerCommandPath,
          }),
        );
        expect(
          computerUseServiceMocks.ensureCodexComputerUseSharedPluginCache,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            bundledMarketplacePath: codexCandidate.bundledMarketplacePath,
          }),
        );
      });
    },
  );

  it("does not replace the native service app for user-scoped homes", async () => {
    await withTempDir("openclaw-codex-computer-use-user-home-", async (root) => {
      const codexHome = path.join(root, "user-codex-home");
      vi.stubEnv("CODEX_HOME", codexHome);

      await reconcileCodexComputerUseStartArtifacts({
        startOptions: createStartOptions({ homeScope: "user" }),
        agentDir: path.join(root, "agent"),
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      });

      expect(computerUseServiceMocks.ensureCodexComputerUseServiceApp).not.toHaveBeenCalled();
      expect(computerUseServiceMocks.ensureCodexManagedBundledMarketplace).not.toHaveBeenCalled();
    });
  });

  it("does not replace the native service app for an explicit CODEX_HOME", async () => {
    await withTempDir("openclaw-codex-computer-use-explicit-home-", async (root) => {
      const codexHome = path.join(root, "explicit-codex-home");

      await reconcileCodexComputerUseStartArtifacts({
        startOptions: createStartOptions({ env: { CODEX_HOME: codexHome } }),
        agentDir: path.join(root, "agent"),
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      });

      expect(computerUseServiceMocks.ensureCodexComputerUseServiceApp).not.toHaveBeenCalled();
      expect(computerUseServiceMocks.ensureCodexManagedBundledMarketplace).not.toHaveBeenCalled();
    });
  });

  it("classifies native client provisioning failures as harness preflight", async () => {
    computerUseServiceMocks.ensureCodexManagedBundledMarketplace.mockResolvedValueOnce(
      "/managed/openai-bundled",
    );
    computerUseServiceMocks.ensureCodexComputerUseServiceApp.mockRejectedValueOnce(
      new Error("copy failed"),
    );

    await expect(
      reconcileCodexComputerUseStartArtifacts({
        startOptions: createStartOptions(),
        agentDir: "/tmp/openclaw-codex-computer-use-failed",
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
      }),
    ).rejects.toMatchObject({ name: "AgentHarnessPreflightError", scope: "harness" });
  });

  it("refreshes shared cache once per selected desktop source generation", async () => {
    await withTempDir("openclaw-codex-computer-use-cache-owner-", async (agentDir) => {
      computerUseServiceMocks.ensureCodexComputerUseSharedPluginCache.mockResolvedValue({
        status: "shared",
        changed: true,
        message: "shared",
        removedStaleVersions: [],
        warnings: [],
      });
      const startOptions = createStartOptions({
        command: "/Applications/ChatGPT.app/Contents/Resources/codex",
      });
      const pluginConfig = {
        computerUse: {
          enabled: true,
          autoInstall: false,
          pluginCacheMode: "shared" as const,
        },
      };

      await reconcileCodexComputerUseStartArtifacts({
        startOptions,
        agentDir,
        pluginConfig,
        desktopGeneration: { epoch: 1, fingerprint: "desktop-x" },
      });
      await reconcileCodexComputerUseStartArtifacts({
        startOptions,
        agentDir,
        pluginConfig,
        desktopGeneration: { epoch: 1, fingerprint: "desktop-x" },
      });
      await reconcileCodexComputerUseStartArtifacts({
        startOptions,
        agentDir,
        pluginConfig,
        desktopGeneration: { epoch: 2, fingerprint: "desktop-y" },
      });

      expect(
        computerUseServiceMocks.ensureCodexComputerUseSharedPluginCache.mock.calls.map(
          ([params]) => params.forceRefresh,
        ),
      ).toEqual([true, false, true]);
    });
  });

  it("does not let a stale desktop generation publish artifacts after its successor", async () => {
    await withTempDir("openclaw-codex-computer-use-generation-", async (agentDir) => {
      const firstMarketplaceStarted = createDeferred<void>();
      const releaseFirstMarketplace = createDeferred<void>();
      let activeMarketplaceCalls = 0;
      let maxActiveMarketplaceCalls = 0;
      computerUseServiceMocks.ensureCodexManagedBundledMarketplace
        .mockImplementationOnce(async () => {
          activeMarketplaceCalls += 1;
          maxActiveMarketplaceCalls = Math.max(maxActiveMarketplaceCalls, activeMarketplaceCalls);
          firstMarketplaceStarted.resolve();
          try {
            await releaseFirstMarketplace.promise;
            return "/managed/openai-bundled";
          } finally {
            activeMarketplaceCalls -= 1;
          }
        })
        .mockImplementationOnce(async () => {
          activeMarketplaceCalls += 1;
          maxActiveMarketplaceCalls = Math.max(maxActiveMarketplaceCalls, activeMarketplaceCalls);
          activeMarketplaceCalls -= 1;
          return "/managed/openai-bundled";
        });
      let currentEpoch = 1;
      const startOptions = createStartOptions();
      const first = reconcileCodexComputerUseStartArtifacts({
        startOptions,
        agentDir,
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
        desktopGeneration: { epoch: 1, fingerprint: "desktop-x" },
        assertCurrent: () => {
          if (currentEpoch !== 1) {
            throw new Error("desktop generation X is stale");
          }
        },
      });
      await firstMarketplaceStarted.promise;
      currentEpoch = 2;
      const second = reconcileCodexComputerUseStartArtifacts({
        startOptions,
        agentDir,
        pluginConfig: { computerUse: { enabled: true, autoInstall: true } },
        desktopGeneration: { epoch: 2, fingerprint: "desktop-y" },
        assertCurrent: () => {
          if (currentEpoch !== 2) {
            throw new Error("desktop generation Y is stale");
          }
        },
      });
      releaseFirstMarketplace.resolve();

      await expect(first).rejects.toThrow("desktop generation X is stale");
      await expect(second).resolves.toBeUndefined();
      expect(maxActiveMarketplaceCalls).toBe(1);
      expect(computerUseServiceMocks.ensureCodexComputerUseServiceApp).toHaveBeenCalledTimes(1);
    });
  });

  it("uses the native user Codex home for coexistence mode", async () => {
    await withTempDir("openclaw-codex-user-home-", async (root) => {
      const agentDir = path.join(root, "agent");
      const codexHome = path.join(root, "user-codex-home");
      vi.stubEnv("CODEX_HOME", codexHome);
      const startOptions = createStartOptions({ homeScope: "user" });
      await expect(
        bridgeCodexAppServerStartOptions({ startOptions, agentDir, authProfileId: null }),
      ).resolves.toEqual({
        ...startOptions,
        env: { CODEX_HOME: codexHome },
      });
      await expect(fs.access(codexHome)).resolves.toBeUndefined();
      await expectPathMissing(resolveCodexAppServerHomeDir(agentDir));
    });
  });

  it("places the ephemeral auth-store override after configured root overrides", async () => {
    await withTempDir("openclaw-codex-auth-store-", async (agentDir) => {
      const startOptions = createStartOptions({
        args: ["-c", 'cli_auth_credentials_store="keyring"', "app-server"],
      });

      const bridged = await bridgeCodexAppServerStartOptions({ startOptions, agentDir });

      expect(bridged.args).toEqual([
        "-c",
        'cli_auth_credentials_store="keyring"',
        "app-server",
        "-c",
        'cli_auth_credentials_store="ephemeral"',
      ]);
    });
  });

  it("does not mistake an option value for the app-server subcommand", async () => {
    await withTempDir("openclaw-codex-profile-name-", async (agentDir) => {
      const startOptions = createStartOptions({
        args: ["--profile", "app-server", "app-server"],
      });

      const bridged = await bridgeCodexAppServerStartOptions({ startOptions, agentDir });

      expect(bridged.args).toEqual([
        "--profile",
        "app-server",
        "app-server",
        "-c",
        'cli_auth_credentials_store="ephemeral"',
      ]);
    });
  });

  it("preserves custom stdio backend arguments", async () => {
    await withTempDir("openclaw-codex-custom-backend-", async (agentDir) => {
      const startOptions = createStartOptions({
        command: "custom-codex-compatible-server",
        commandSource: "config",
        args: [],
      });
      await writeCodexCliAuthFile(resolveCodexAppServerHomeDir(agentDir));

      const bridged = await bridgeCodexAppServerStartOptions({ startOptions, agentDir });

      expect(bridged.args).toEqual([]);
    });
  });

  it("preserves inherited HOME when clearEnv asks to clear app-server isolation vars", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = createStartOptions({
      clearEnv: ["CODEX_HOME", "HOME", "FOO"],
    });
    try {
      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
        }),
      ).resolves.toEqual({
        ...startOptions,
        args: EPHEMERAL_AUTH_ARGS,
        env: {
          CODEX_HOME: resolveCodexAppServerHomeDir(agentDir),
        },
        clearEnv: ["FOO"],
      });
      expect(startOptions.clearEnv).toEqual(["CODEX_HOME", "HOME", "FOO"]);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("preserves explicit CODEX_HOME and HOME overrides", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const codexHome = path.join(agentDir, "custom-codex-home");
    const nativeHome = path.join(agentDir, "custom-native-home");
    const startOptions = createStartOptions({
      env: { CODEX_HOME: codexHome, HOME: nativeHome, EXISTING: "1" },
      clearEnv: ["CODEX_HOME", "HOME", "FOO"],
    });
    try {
      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
        }),
      ).resolves.toEqual({
        ...startOptions,
        args: EPHEMERAL_AUTH_ARGS,
        env: {
          CODEX_HOME: codexHome,
          HOME: nativeHome,
          EXISTING: "1",
        },
        clearEnv: ["FOO"],
      });
      await expect(fs.access(codexHome)).resolves.toBeUndefined();
      await expect(fs.access(nativeHome)).resolves.toBeUndefined();
      expect(startOptions.clearEnv).toEqual(["CODEX_HOME", "HOME", "FOO"]);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("clears inherited API-key env vars when the default Codex profile is subscription auth", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = createStartOptions({
      env: { EXISTING: "1" },
      clearEnv: ["FOO"],
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:default",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-123",
        },
      });

      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
        }),
      ).resolves.toEqual({
        ...startOptions,
        args: EPHEMERAL_AUTH_ARGS,
        env: {
          EXISTING: "1",
          CODEX_HOME: resolveCodexAppServerHomeDir(agentDir),
        },
        clearEnv: ["FOO", "CODEX_API_KEY", "OPENAI_API_KEY"],
      });
      expect(startOptions.clearEnv).toEqual(["FOO"]);
      await expectPathMissing(path.join(agentDir, "harness-auth"));
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("clears an inherited OpenAI API key for an explicit Codex OAuth profile", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = createStartOptions({ clearEnv: ["FOO"] });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-123",
        },
      });
      await writeCodexCliAuthFile(resolveCodexAppServerHomeDir(agentDir));

      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
          authProfileId: "openai:work",
        }),
      ).resolves.toEqual({
        ...startOptions,
        args: EPHEMERAL_AUTH_ARGS,
        env: {
          CODEX_HOME: resolveCodexAppServerHomeDir(agentDir),
        },
        clearEnv: ["FOO", "CODEX_API_KEY", "OPENAI_API_KEY"],
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("clears an inherited OpenAI API key for an explicit Codex token profile", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = createStartOptions({ clearEnv: ["FOO"] });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "token",
          provider: "openai",
          token: "access-token",
        },
      });

      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
          authProfileId: "openai:work",
        }),
      ).resolves.toEqual({
        ...startOptions,
        args: EPHEMERAL_AUTH_ARGS,
        env: {
          CODEX_HOME: resolveCodexAppServerHomeDir(agentDir),
        },
        clearEnv: ["FOO", "CODEX_API_KEY", "OPENAI_API_KEY"],
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it.each(["api-key", "profile"] as const)(
    "clears all ambient auth env vars for prepared %s startup",
    async (preparedAuth) => {
      const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
      const startOptions = createStartOptions({ clearEnv: ["FOO", "OPENAI_API_KEY"] });
      const preparedAuthHandoff =
        preparedAuth === "api-key"
          ? ({ kind: "api-key", apiKey: "prepared-platform-key" } as const)
          : ({
              kind: "profile",
              profileId: "openai:prepared",
              store: { version: 1, profiles: {} },
            } as const);
      try {
        const bridged = await bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
          authProfileId: preparedAuth === "api-key" ? null : "openai:prepared",
          preparedAuth: preparedAuthHandoff,
        });
        expect(bridged).toEqual({
          ...startOptions,
          args: EPHEMERAL_AUTH_ARGS,
          env: { CODEX_HOME: resolveCodexAppServerHomeDir(agentDir) },
          clearEnv: ["FOO", "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"],
        });
        expect(
          resolveCodexAppServerSpawnEnv(bridged, {
            FOO: "ambient",
            CODEX_API_KEY: "ambient-codex-key",
            OPENAI_API_KEY: "ambient-openai-key",
            CODEX_ACCESS_TOKEN: "ambient-access-token",
          }),
        ).toMatchObject({ CODEX_HOME: resolveCodexAppServerHomeDir(agentDir) });
        const spawnEnv = resolveCodexAppServerSpawnEnv(bridged, {
          CODEX_API_KEY: "ambient-codex-key",
          OPENAI_API_KEY: "ambient-openai-key",
          CODEX_ACCESS_TOKEN: "ambient-access-token",
        });
        expect(spawnEnv).not.toHaveProperty("CODEX_API_KEY");
        expect(spawnEnv).not.toHaveProperty("OPENAI_API_KEY");
        expect(spawnEnv).not.toHaveProperty("CODEX_ACCESS_TOKEN");
      } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
      }
    },
  );

  it("maps a prepared API-key route to one closed auth handoff", async () => {
    await expect(
      resolveCodexAppServerPreparedAuthHandoff({
        authRequirement: "api-key",
        resolvedApiKey: "  prepared-platform-key  ",
        authProfileId: "openai:decoy",
        authProfileStore: {
          version: 1,
          profiles: {
            "openai:decoy": {
              type: "token",
              provider: "openai",
              token: "decoy-subscription-token",
            },
          },
        },
        homeScope: "agent",
        subscriptionProfileRequiredError: "unused",
        subscriptionProfileUnusableError: "unused",
      }),
    ).resolves.toEqual({
      nativeAuthProfile: false,
      preparedAuth: { kind: "api-key", apiKey: "prepared-platform-key" },
    });
  });

  it("materializes one prepared subscription profile snapshot", async () => {
    const access = chatgptAccessToken("prepared-account");
    const authProfileStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:work": {
          type: "token",
          provider: "openai",
          token: access,
          email: "prepared@example.test",
        },
      },
    };

    const handoff = await resolveCodexAppServerPreparedAuthHandoff({
      authRequirement: "subscription",
      authProfileId: "openai:work",
      authProfileStore,
      agentDir: "/tmp/openclaw-agent",
      homeScope: "agent",
      subscriptionProfileRequiredError: "profile required",
      subscriptionProfileUnusableError: "profile unusable",
    });

    expect(handoff).toMatchObject({
      authProfileId: "openai:work",
      nativeAuthProfile: true,
      preparedAuth: {
        kind: "profile",
        profileId: "openai:work",
        store: authProfileStore,
        snapshot: {
          loginParams: {
            type: "chatgptAuthTokens",
            accessToken: access,
            chatgptAccountId: "prepared-account",
          },
        },
      },
    });
    expect(
      handoff.preparedAuth?.kind === "profile"
        ? handoff.preparedAuth.snapshot?.secretFreeCacheKey
        : undefined,
    ).toMatch(/^prepared-account:token:sha256:[a-f0-9]{64}$/u);
  });

  it("isolates static access tokens that share the same genuine ChatGPT workspace", async () => {
    const snapshotFor = (access: string) =>
      resolveCodexAppServerPreparedAuthProfileSnapshot({
        authProfileId: "openai:shared",
        authProfileStore: {
          version: 1,
          profiles: {
            "openai:shared": {
              type: "token",
              provider: "openai",
              token: access,
            },
          },
        },
      });

    const firstToken = chatgptAccessToken("shared-account", "first-subject");
    const secondToken = chatgptAccessToken("shared-account", "second-subject");
    const first = await snapshotFor(firstToken);
    const second = await snapshotFor(secondToken);

    expect(first?.secretFreeCacheKey).toMatch(/^shared-account:token:sha256:[a-f0-9]{64}$/u);
    expect(second?.secretFreeCacheKey).toMatch(/^shared-account:token:sha256:[a-f0-9]{64}$/u);
    expect(first?.secretFreeCacheKey).not.toBe(second?.secretFreeCacheKey);
    expect(first?.secretFreeCacheKey).not.toContain(firstToken);
    expect(second?.secretFreeCacheKey).not.toContain(secondToken);
  });

  it("keeps legacy profile classification outside the prepared union", async () => {
    const authProfileStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:legacy": {
          type: "token",
          provider: "openai",
          token: "legacy-subscription-token",
        },
      },
    };

    await expect(
      resolveCodexAppServerPreparedAuthHandoff({
        authProfileId: "openai:legacy",
        authProfileStore,
        homeScope: "agent",
        subscriptionProfileRequiredError: "unused",
        subscriptionProfileUnusableError: "unused",
      }),
    ).resolves.toEqual({
      authProfileId: "openai:legacy",
      nativeAuthProfile: true,
    });
  });

  it("prepares a selected profile when remote execution forbids legacy auth", async () => {
    const authProfileStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:remote": {
          type: "api_key",
          provider: "openai",
          key: "prepared-remote-key",
        },
      },
    };

    await expect(
      resolveCodexAppServerPreparedAuthHandoff({
        authProfileId: "openai:remote",
        authProfileStore,
        homeScope: "agent",
        requirePreparedAuth: true,
        subscriptionProfileRequiredError: "unused",
        subscriptionProfileUnusableError: "unused",
      }),
    ).resolves.toMatchObject({
      authProfileId: "openai:remote",
      preparedAuth: {
        kind: "profile",
        profileId: "openai:remote",
        snapshot: { loginParams: { type: "apiKey", apiKey: "prepared-remote-key" } },
      },
    });
  });

  it("keeps an inherited OpenAI API key for an explicit Codex api-key profile", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = createStartOptions({ clearEnv: ["FOO"] });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "api_key",
          provider: "openai",
          key: "explicit-api-key",
        },
      });

      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
          authProfileId: "openai:work",
        }),
      ).resolves.toEqual({
        ...startOptions,
        args: EPHEMERAL_AUTH_ARGS,
        env: {
          CODEX_HOME: resolveCodexAppServerHomeDir(agentDir),
        },
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("does not clear process environment for websocket app-server connections", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const startOptions = createStartOptions({
      transport: "websocket",
      url: "ws://127.0.0.1:1455",
      clearEnv: ["FOO"],
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-123",
        },
      });

      await expect(
        bridgeCodexAppServerStartOptions({
          startOptions,
          agentDir,
          authProfileId: "openai:work",
        }),
      ).resolves.toBe(startOptions);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("fingerprints resolved API-key auth-profile secrets without exposing them", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "api_key",
          provider: "openai",
          key: "first-secret-key",
        },
      });
      const first = await resolveCodexAppServerAuthAccountCacheKey({
        agentDir,
        authProfileId: "openai:work",
      });

      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "api_key",
          provider: "openai",
          key: "second-secret-key",
        },
      });
      const second = await resolveCodexAppServerAuthAccountCacheKey({
        agentDir,
        authProfileId: "openai:work",
      });

      expect(first).toMatch(/^openai:work:api_key:sha256:[a-f0-9]{64}$/);
      expect(second).toMatch(/^openai:work:api_key:sha256:[a-f0-9]{64}$/);
      expect(second).not.toBe(first);
      expect(first).not.toContain("first-secret-key");
      expect(second).not.toContain("second-secret-key");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("fingerprints API-key auth-profile secret refs", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_CODEX_TEST_KEY" },
        },
      });
      vi.stubEnv("OPENAI_CODEX_TEST_KEY", "first-ref-secret");
      const first = await resolveCodexAppServerAuthAccountCacheKey({
        agentDir,
        authProfileId: "openai:work",
      });

      vi.stubEnv("OPENAI_CODEX_TEST_KEY", "second-ref-secret");
      const second = await resolveCodexAppServerAuthAccountCacheKey({
        agentDir,
        authProfileId: "openai:work",
      });

      expect(first).toMatch(/^openai:work:api_key:sha256:[a-f0-9]{64}$/);
      expect(second).toMatch(/^openai:work:api_key:sha256:[a-f0-9]{64}$/);
      expect(second).not.toBe(first);
      expect(first).not.toContain("first-ref-secret");
      expect(second).not.toContain("second-ref-secret");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("fingerprints token auth-profile secret refs", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "token",
          provider: "openai",
          tokenRef: { source: "env", provider: "default", id: "OPENAI_CODEX_TEST_TOKEN" },
          email: "codex@example.test",
        },
      });
      vi.stubEnv("OPENAI_CODEX_TEST_TOKEN", "first-ref-token");
      const first = await resolveCodexAppServerAuthAccountCacheKey({
        agentDir,
        authProfileId: "openai:work",
      });

      vi.stubEnv("OPENAI_CODEX_TEST_TOKEN", "second-ref-token");
      const second = await resolveCodexAppServerAuthAccountCacheKey({
        agentDir,
        authProfileId: "openai:work",
      });

      expect(first).toMatch(/^codex@example\.test:token:sha256:[a-f0-9]{64}$/);
      expect(second).toMatch(/^codex@example\.test:token:sha256:[a-f0-9]{64}$/);
      expect(second).not.toBe(first);
      expect(first).not.toContain("first-ref-token");
      expect(second).not.toContain("second-ref-token");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("fingerprints supplied token stores with the same profile id independently", async () => {
    const resolveKey = async (token: string) =>
      await resolveCodexAppServerAuthAccountCacheKey({
        agentDir: "/tmp/openclaw-codex-prepared-auth",
        authProfileId: "openai:work",
        authProfileStore: {
          version: 1,
          profiles: {
            "openai:work": {
              type: "token",
              provider: "openai",
              token,
              email: "codex@example.test",
            },
          },
        },
      });

    const first = await resolveKey("first-prepared-token");
    const second = await resolveKey("second-prepared-token");

    expect(first).toMatch(/^codex@example\.test:token:sha256:[a-f0-9]{64}$/);
    expect(second).toMatch(/^codex@example\.test:token:sha256:[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
    expect(first).not.toContain("first-prepared-token");
    expect(second).not.toContain("second-prepared-token");
  });

  it("applies an OpenAI Codex OAuth profile through app-server login", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-123",
          email: "codex@example.test",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:work",
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "access-token",
        chatgptAccountId: "account-123",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("applies a supplied scoped OAuth profile instead of persisted credentials", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "persisted-access",
          refresh: "persisted-refresh",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "persisted-account",
        },
      });
      const authProfileStore: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai:work": {
            type: "oauth",
            provider: "openai",
            access: "scoped-access",
            refresh: "scoped-refresh",
            expires: Date.now() + 24 * 60 * 60_000,
            accountId: "scoped-account",
          },
        },
      };

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:work",
        authProfileStore,
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "scoped-access",
        chatgptAccountId: "scoped-account",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "without persisted same-id credentials", persistSameId: false },
    { name: "with persisted same-id credentials", persistSameId: true },
  ])("refreshes an expired scoped OAuth profile $name", async ({ persistSameId }) => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "scoped-refreshed-access",
      refresh: "scoped-refreshed-refresh",
      expires: Date.now() + 60_000,
      accountId: "scoped-refreshed-account",
    });
    try {
      if (persistSameId) {
        upsertAuthProfile({
          agentDir,
          profileId: "openai:work",
          credential: {
            type: "oauth",
            provider: "openai",
            access: "persisted-access",
            refresh: "persisted-refresh",
            expires: Date.now() + 24 * 60 * 60_000,
            accountId: "persisted-account",
          },
        });
      }
      const authProfileStore: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai:work": {
            type: "oauth",
            provider: "openai",
            access: "scoped-expired-access",
            refresh: "scoped-refresh",
            expires: Date.now() - 60_000,
            accountId: "scoped-account",
          },
        },
      };

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:work",
        authProfileStore,
      });

      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("scoped-refresh");
      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "scoped-refreshed-access",
        chatgptAccountId: "scoped-refreshed-account",
        chatgptPlanType: null,
      });
      expect(authProfileStore.profiles["openai:work"]).toMatchObject({
        access: "scoped-refreshed-access",
        accountId: "scoped-refreshed-account",
      });
      if (persistSameId) {
        expect(
          loadAuthProfileStoreForSecretsRuntime(agentDir).profiles["openai:work"],
        ).toMatchObject({
          access: "persisted-access",
          accountId: "persisted-account",
        });
      }
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("routes a supplied persisted OAuth clone through canonical refresh", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "persisted-refreshed-access",
      refresh: "persisted-refreshed-refresh",
      expires: Date.now() + 60_000,
      accountId: "persisted-account",
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "persisted-expired-access",
          refresh: "persisted-refresh",
          expires: Date.now() - 60_000,
          accountId: "persisted-account",
        },
      });
      const authProfileStore = loadAuthProfileStoreForSecretsRuntime(agentDir);
      expect(authProfileStore.runtimePersistedProfileIds).toContain("openai:work");

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:work",
        authProfileStore,
      });

      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("persisted-refresh");
      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "persisted-refreshed-access",
        chatgptAccountId: "persisted-account",
        chatgptPlanType: null,
      });
      expect(loadAuthProfileStoreForSecretsRuntime(agentDir).profiles["openai:work"]).toMatchObject(
        {
          access: "persisted-refreshed-access",
          refresh: "persisted-refreshed-refresh",
          accountId: "persisted-account",
        },
      );
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps a prepared persisted store aligned across rotating refresh tokens", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    oauthMocks.refreshOpenAICodexToken
      .mockResolvedValueOnce({
        access: "first-rotated-access",
        refresh: "first-rotated-refresh",
        expires: Date.now() + 60_000,
      })
      .mockResolvedValueOnce({
        access: "second-rotated-access",
        refresh: "second-rotated-refresh",
        expires: Date.now() + 60_000,
      });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "initial-access",
          refresh: "initial-refresh",
          expires: Date.now() + 60_000,
          accountId: "rotating-account",
        },
      });
      const authProfileStore = loadAuthProfileStoreForSecretsRuntime(agentDir);

      await refreshCodexAppServerAuthTokens({
        agentDir,
        authProfileId: "openai:work",
        authProfileStore,
      });
      await refreshCodexAppServerAuthTokens({
        agentDir,
        authProfileId: "openai:work",
        authProfileStore,
      });

      expect(oauthMocks.refreshOpenAICodexToken.mock.calls).toEqual([
        ["initial-refresh"],
        ["first-rotated-refresh"],
      ]);
      expect(authProfileStore.profiles["openai:work"]).toMatchObject({
        access: "second-rotated-access",
        refresh: "second-rotated-refresh",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("does not replace a prepared persisted store changed during refresh", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    let resolveRefresh:
      | ((value: { access: string; refresh: string; expires: number }) => void)
      | undefined;
    oauthMocks.refreshOpenAICodexToken.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "initial-access",
          refresh: "initial-refresh",
          expires: Date.now() + 60_000,
          accountId: "initial-account",
        },
      });
      const authProfileStore = loadAuthProfileStoreForSecretsRuntime(agentDir);

      const refresh = refreshCodexAppServerAuthTokens({
        agentDir,
        authProfileId: "openai:work",
        authProfileStore,
      });
      await vi.waitFor(() => expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledTimes(1));
      authProfileStore.profiles["openai:work"] = {
        type: "oauth",
        provider: "openai",
        access: "replacement-access",
        refresh: "replacement-refresh",
        expires: Date.now() + 60_000,
        accountId: "replacement-account",
      };
      resolveRefresh?.({
        access: "rotated-access",
        refresh: "rotated-refresh",
        expires: Date.now() + 60_000,
      });

      await refresh;
      expect(authProfileStore.profiles["openai:work"]).toMatchObject({
        access: "replacement-access",
        refresh: "replacement-refresh",
        accountId: "replacement-account",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps a runtime-external same-account OAuth profile scoped", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "scoped-refreshed-access",
      refresh: "scoped-refreshed-refresh",
      expires: Date.now() + 60_000,
      accountId: "shared-account",
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "persisted-access",
          refresh: "persisted-refresh",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "shared-account",
        },
      });
      const authProfileStore: AuthProfileStore = {
        version: 1,
        runtimeExternalProfileIds: ["openai:work"],
        runtimeExternalProfileIdsAuthoritative: true,
        profiles: {
          "openai:work": {
            type: "oauth",
            provider: "openai",
            access: "scoped-expired-access",
            refresh: "scoped-refresh",
            expires: Date.now() - 60_000,
            accountId: "shared-account",
          },
        },
      };

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:work",
        authProfileStore,
      });

      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("scoped-refresh");
      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "scoped-refreshed-access",
        chatgptAccountId: "shared-account",
        chatgptPlanType: null,
      });
      expect(loadAuthProfileStoreForSecretsRuntime(agentDir).profiles["openai:work"]).toMatchObject(
        {
          access: "persisted-access",
          refresh: "persisted-refresh",
          accountId: "shared-account",
        },
      );
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps an ambiguous supplied OAuth identity scoped", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "scoped-refreshed-access",
      refresh: "scoped-refreshed-refresh",
      expires: Date.now() + 60_000,
      accountId: "scoped-account",
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "persisted-access",
          refresh: "persisted-refresh",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "persisted-account",
        },
      });
      const authProfileStore: AuthProfileStore = {
        version: 1,
        profiles: {
          "openai:work": {
            type: "oauth",
            provider: "openai",
            access: "scoped-expired-access",
            refresh: "scoped-refresh",
            expires: Date.now() - 60_000,
          },
        },
      };

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:work",
        authProfileStore,
      });

      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("scoped-refresh");
      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "scoped-refreshed-access",
        chatgptAccountId: "scoped-account",
        chatgptPlanType: null,
      });
      expect(loadAuthProfileStoreForSecretsRuntime(agentDir).profiles["openai:work"]).toMatchObject(
        {
          access: "persisted-access",
          refresh: "persisted-refresh",
          accountId: "persisted-account",
        },
      );
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("routes a same-identity stale persisted clone through canonical persisted auth", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "stale-access",
          refresh: "stale-refresh",
          expires: Date.now() - 60_000,
          accountId: "persisted-account",
        },
      });
      const authProfileStore = loadAuthProfileStoreForSecretsRuntime(agentDir);
      expect(authProfileStore.runtimePersistedProfileIds).toContain("openai:work");
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "current-access",
          refresh: "current-refresh",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "persisted-account",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:work",
        authProfileStore,
      });

      expect(oauthMocks.refreshOpenAICodexToken).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "current-access",
        chatgptAccountId: "persisted-account",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps a changed-identity persisted clone scoped", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "account-a-refreshed-access",
      refresh: "account-a-refreshed-refresh",
      expires: Date.now() + 60_000,
      accountId: "account-a",
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "account-a-expired-access",
          refresh: "account-a-refresh",
          expires: Date.now() - 60_000,
          accountId: "account-a",
        },
      });
      const authProfileStore = loadAuthProfileStoreForSecretsRuntime(agentDir);
      expect(authProfileStore.runtimePersistedProfileIds).toContain("openai:work");
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "account-b-access",
          refresh: "account-b-refresh",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-b",
        },
      });
      replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: authProfileStore }]);

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:work",
        authProfileStore,
      });

      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("account-a-refresh");
      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "account-a-refreshed-access",
        chatgptAccountId: "account-a",
        chatgptPlanType: null,
      });
      expect(loadAuthProfileStoreForSecretsRuntime(agentDir).profiles["openai:work"]).toMatchObject(
        {
          access: "account-b-access",
          refresh: "account-b-refresh",
          accountId: "account-b",
        },
      );
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent refreshes of the same scoped OAuth profile", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    let resolveRefresh:
      | ((value: { access: string; refresh: string; expires: number; accountId: string }) => void)
      | undefined;
    oauthMocks.refreshOpenAICodexToken.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const authProfileStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:work": {
          type: "oauth",
          provider: "openai",
          access: "scoped-expired-access",
          refresh: "scoped-refresh",
          expires: Date.now() - 60_000,
          accountId: "scoped-account",
        },
      },
    };
    try {
      const first = applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:work",
        authProfileStore,
      });
      const second = applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:work",
        authProfileStore,
      });
      await vi.waitFor(() => expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledTimes(1));

      resolveRefresh?.({
        access: "scoped-refreshed-access",
        refresh: "scoped-refreshed-refresh",
        expires: Date.now() + 60_000,
        accountId: "scoped-refreshed-account",
      });
      await Promise.all([first, second]);

      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenNthCalledWith(1, "account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "scoped-refreshed-access",
        chatgptAccountId: "scoped-refreshed-account",
        chatgptPlanType: null,
      });
      expect(request).toHaveBeenNthCalledWith(2, "account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "scoped-refreshed-access",
        chatgptAccountId: "scoped-refreshed-account",
        chatgptPlanType: null,
      });
    } finally {
      resolveRefresh?.({
        access: "cleanup-access",
        refresh: "cleanup-refresh",
        expires: Date.now() + 60_000,
        accountId: "cleanup-account",
      });
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("leaves native app-server auth untouched when auth bridging is disabled", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ requiresOpenaiAuth: true }));
    try {
      vi.stubEnv("OPENAI_API_KEY", "env-api-key");

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: null,
        startOptions: createStartOptions(),
      });

      expect(request).not.toHaveBeenCalled();
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("applies a prepared API key without resolving an available OAuth profile", async () => {
    const request = vi.fn(async () => ({ type: "apiKey" }));
    const authProfileStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "subscription-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        },
      },
      order: { openai: ["openai:chatgpt"] },
    };

    await applyCodexAppServerAuthProfile({
      client: { request } as never,
      agentDir: "/tmp/openclaw-agent",
      authProfileId: null,
      authProfileStore,
      preparedAuth: { kind: "api-key", apiKey: "prepared-platform-key" },
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("account/login/start", {
      type: "apiKey",
      apiKey: "prepared-platform-key",
    });
    const cacheKey = resolveCodexAppServerPreparedApiKeyCacheKey("prepared-platform-key");
    expect(cacheKey).toMatch(/^api_key:sha256:[a-f0-9]{64}$/u);
    expect(cacheKey).not.toContain("prepared-platform-key");
  });

  it("uses one SecretRef snapshot for prepared profile cache identity and login", async () => {
    const authProfileStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:work": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_ROTATING_PREPARED_KEY" },
        },
      },
    };
    vi.stubEnv("OPENAI_ROTATING_PREPARED_KEY", "first-prepared-key");
    const snapshot = await resolveCodexAppServerPreparedAuthProfileSnapshot({
      agentDir: "/tmp/openclaw-agent",
      authProfileId: "openai:work",
      authProfileStore,
    });
    vi.stubEnv("OPENAI_ROTATING_PREPARED_KEY", "second-prepared-key");
    const request = vi.fn(async () => ({ type: "apiKey" }));

    try {
      expect(snapshot).toEqual({
        loginParams: { type: "apiKey", apiKey: "first-prepared-key" },
        secretFreeCacheKey: `openai:work:${resolveCodexAppServerPreparedApiKeyCacheKey("first-prepared-key")}`,
      });
      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir: "/tmp/openclaw-agent",
        authProfileId: "openai:work",
        authProfileStore,
        preparedAuth: {
          kind: "profile",
          profileId: "openai:work",
          store: authProfileStore,
          snapshot: snapshot as NonNullable<typeof snapshot>,
        },
      });
      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "apiKey",
        apiKey: "first-prepared-key",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("exposes only a genuine credential account id for scheduled authorization identity", async () => {
    const base = {
      type: "oauth" as const,
      provider: "openai",
      access: "subscription-token",
      refresh: "refresh-token",
      expires: Date.now() + 60 * 60_000,
      email: "operator@example.test",
    };
    const withAccount = await resolveCodexAppServerPreparedAuthProfileSnapshot({
      agentDir: "/tmp/openclaw-agent",
      authProfileId: "openai:work",
      authProfileStore: {
        version: 1,
        profiles: { "openai:work": { ...base, accountId: "account-123" } },
      },
    });
    expect(withAccount?.chatgptAccountId).toBe("account-123");
  });

  it("derives a missing ChatGPT account id from the access-token workspace claim", async () => {
    const access = chatgptAccessToken("account-from-jwt");

    const snapshot = await resolveCodexAppServerPreparedAuthProfileSnapshot({
      agentDir: "/tmp/openclaw-agent",
      authProfileId: "openai:work",
      authProfileStore: {
        version: 1,
        profiles: {
          "openai:work": {
            type: "oauth",
            provider: "openai",
            access,
            refresh: "refresh-token",
            expires: Date.now() + 60 * 60_000,
            email: "operator@example.test",
          },
        },
      },
    });

    expect(snapshot).toMatchObject({
      loginParams: { type: "chatgptAuthTokens", chatgptAccountId: "account-from-jwt" },
      chatgptAccountId: "account-from-jwt",
    });
  });

  it("rejects an email-only OAuth profile instead of inventing a workspace identity", async () => {
    await expect(
      resolveCodexAppServerPreparedAuthProfileSnapshot({
        agentDir: "/tmp/openclaw-agent",
        authProfileId: "openai:work",
        authProfileStore: {
          version: 1,
          profiles: {
            "openai:work": {
              type: "oauth",
              provider: "openai",
              access: "opaque-access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60 * 60_000,
              email: "operator@example.test",
            },
          },
        },
      }),
    ).rejects.toThrow("ChatGPT account ID");
  });

  it("rejects a stored workspace that contradicts the access-token identity", async () => {
    await expect(
      resolveCodexAppServerPreparedAuthProfileSnapshot({
        agentDir: "/tmp/openclaw-agent",
        authProfileId: "openai:work",
        authProfileStore: {
          version: 1,
          profiles: {
            "openai:work": {
              type: "oauth",
              provider: "openai",
              access: chatgptAccessToken("workspace-from-token"),
              refresh: "refresh-token",
              expires: Date.now() + 60 * 60_000,
              accountId: "workspace-from-profile",
            },
          },
        },
      }),
    ).rejects.toThrow("different ChatGPT account ID");
  });

  it("applies a normal OpenAI API-key profile as a Codex app-server backup", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "apiKey" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:default",
        credential: {
          type: "api_key",
          provider: "openai",
          key: "sk-openai-backup",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:default",
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "apiKey",
        apiKey: "sk-openai-backup",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("applies the default OpenAI Codex OAuth profile when no profile id is explicit", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:default",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "default-access-token",
          refresh: "default-refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-default",
          email: "codex-default@example.test",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "default-access-token",
        chatgptAccountId: "account-default",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("selects ordered Codex OAuth before an OpenAI API-key backup", async () => {
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    const accessToken = "test-access-token";
    const authProfileStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:media-api": {
          type: "api_key",
          provider: "openai",
          key: "test-api-key",
        },
        "openai:qa-oauth": {
          type: "oauth",
          provider: "openai",
          access: accessToken,
          refresh: "test-refresh",
          expires: Date.UTC(2036, 0, 1),
          accountId: "qa-codex-account",
        },
      },
      order: { openai: ["openai:qa-oauth", "openai:media-api"] },
    };

    expect(resolveCodexAppServerAuthProfileId({ store: authProfileStore })).toBe("openai:qa-oauth");
    await applyCodexAppServerAuthProfile({
      client: { request } as never,
      agentDir: "/tmp/openclaw-codex-auth-product-proof",
      authProfileStore,
    });

    expect(request).toHaveBeenCalledWith("account/login/start", {
      type: "chatgptAuthTokens",
      accessToken,
      chatgptAccountId: "qa-codex-account",
      chatgptPlanType: null,
    });
  });

  it("does not select Codex profiles without inline OAuth credential material", () => {
    expect(
      resolveCodexAppServerAuthProfileId({
        store: {
          version: 1,
          profiles: {
            "openai:default": {
              type: "oauth",
              provider: "openai",
              access: "",
              refresh: "",
              expires: Date.now() + 60_000,
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("answers refresh requests from a discovered inline Codex OAuth profile", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "refreshed-ref-backed-access-token",
      refresh: "refreshed-ref-backed-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-ref-backed-refreshed",
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:default",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "ref-backed-access-token",
          refresh: "ref-backed-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "account-ref-backed",
          email: "codex@example.test",
        },
      });

      await expect(refreshCodexAppServerAuthTokens({ agentDir })).resolves.toEqual({
        accessToken: "refreshed-ref-backed-access-token",
        chatgptAccountId: "account-ref-backed-refreshed",
        chatgptPlanType: null,
      });

      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("ref-backed-refresh-token");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("applies native Codex CLI OAuth when no OpenClaw auth profile exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(root, "codex-cli");
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    vi.stubEnv("CODEX_HOME", codexHome);
    try {
      await writeCodexCliAuthFile(codexHome);

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "cli-access-token",
        chatgptAccountId: "account-cli",
        chatgptPlanType: null,
      });
      expect(loadAuthProfileStoreForSecretsRuntime(agentDir).profiles).not.toHaveProperty(
        "openai:default",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("finds native Codex OAuth in the OS home when OpenClaw uses an isolated home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const osHome = path.join(root, "os-home");
    const openClawHome = path.join(root, "openclaw-home");
    const agentDir = path.join(openClawHome, "agents", "main", "agent");
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    vi.stubEnv("HOME", osHome);
    vi.stubEnv("OPENCLAW_HOME", openClawHome);
    vi.stubEnv("CODEX_HOME", undefined);
    try {
      await writeCodexCliAuthFile(path.join(osHome, ".codex"));

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "cli-access-token",
        chatgptAccountId: "account-cli",
        chatgptPlanType: null,
      });
      await expectPathMissing(path.join(agentDir, "auth-profiles.json"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("answers refresh from native Codex CLI OAuth without persisting an OpenClaw profile", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(root, "codex-cli");
    const authProfileStorePath = path.join(agentDir, "auth-profiles.json");
    vi.stubEnv("CODEX_HOME", codexHome);
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "fresh-cli-access-token",
      refresh: "fresh-cli-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-cli-refreshed",
    });
    try {
      await writeCodexCliAuthFile(codexHome);

      await expect(refreshCodexAppServerAuthTokens({ agentDir })).resolves.toEqual({
        accessToken: "fresh-cli-access-token",
        chatgptAccountId: "account-cli-refreshed",
        chatgptPlanType: null,
      });

      await expectPathMissing(authProfileStorePath);
      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("cli-refresh-token");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses native Codex CLI OAuth when deriving cache keys without a supplied store", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(root, "codex-cli");
    vi.stubEnv("CODEX_HOME", codexHome);
    try {
      await writeCodexCliAuthFile(codexHome);

      await expect(
        resolveCodexAppServerAuthAccountCacheKey({
          agentDir,
        }),
      ).resolves.toBe("account-cli");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a supplied empty store authoritative over native Codex CLI OAuth", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(root, "codex-cli");
    vi.stubEnv("CODEX_HOME", codexHome);
    try {
      await writeCodexCliAuthFile(codexHome);

      await expect(
        resolveCodexAppServerAuthAccountCacheKey({
          agentDir,
          authProfileStore: { version: 1, profiles: {} },
        }),
      ).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("honors config auth order when selecting an implicit Codex profile", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:default",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "default-access-token",
          refresh: "default-refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-default",
        },
      });
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "work-access-token",
          refresh: "work-refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-work",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        config: {
          auth: {
            order: {
              openai: ["openai:work", "openai:default"],
            },
          },
        },
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "work-access-token",
        chatgptAccountId: "account-work",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("refreshes an expired OpenAI Codex OAuth profile before app-server login", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "fresh-access-token",
      refresh: "fresh-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-456",
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "expired-access-token",
          refresh: "refresh-token",
          expires: Date.now() - 60_000,
          accountId: "account-123",
          email: "codex@example.test",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:work",
      });

      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("refresh-token");
      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "fresh-access-token",
        chatgptAccountId: "account-456",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("applies an OpenAI Codex api-key profile backed by a secret ref", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "apiKey" }));
    vi.stubEnv("OPENAI_CODEX_API_KEY", "ref-backed-api-key");
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_CODEX_API_KEY" },
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:work",
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "apiKey",
        apiKey: "ref-backed-api-key",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("rejects non-Codex auth profiles before OAuth refresh", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "anthropic:work",
        credential: {
          type: "api_key",
          provider: "anthropic",
          key: "anthropic-api-key",
        },
      });

      await expect(
        applyCodexAppServerAuthProfile({
          client: { request } as never,
          agentDir,
          authProfileId: "anthropic:work",
        }),
      ).rejects.toThrow(
        'Codex app-server auth profile "anthropic:work" must use the canonical OpenAI auth provider; run "openclaw doctor --fix" to migrate legacy provider IDs.',
      );
      expect(oauthMocks.refreshOpenAICodexToken).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("fails subscription auth instead of falling back to an API key", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "apiKey" }));
    vi.stubEnv("CODEX_API_KEY", "placeholder");
    let rejection: unknown;
    try {
      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:work",
        authProfileStore: {
          version: 1,
          profiles: {},
        },
        authRequirement: "subscription",
        startOptions: createStartOptions({
          env: { CODEX_API_KEY: "placeholder" },
        }),
      });
    } catch (error) {
      rejection = error;
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as { status?: unknown }).status).toBe(401);
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves transient subscription credential resolution errors", async () => {
    const transientError = Object.assign(new Error("temporary refresh failure"), { status: 503 });
    oauthMocks.refreshOpenAICodexToken.mockRejectedValueOnce(transientError);
    const request = vi.fn();

    await expect(
      applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir: "/tmp/openclaw-agent",
        authProfileId: "openai:work",
        authProfileStore: {
          version: 1,
          profiles: {
            "openai:work": {
              type: "oauth",
              provider: "openai",
              access: "placeholder",
              refresh: "placeholder",
              expires: Date.now() - 60_000,
            },
          },
        },
        authRequirement: "subscription",
      }),
    ).rejects.toBe(transientError);
    expect(request).not.toHaveBeenCalled();
  });

  it("accepts native ChatGPT auth for subscription routes", async () => {
    const request = vi.fn(async () => ({
      account: { type: "chatgpt", email: null, planType: "plus" },
      requiresOpenaiAuth: true,
    }));

    await applyCodexAppServerAuthProfile({
      client: { request } as never,
      agentDir: "/tmp/openclaw-agent",
      authProfileId: null,
      authRequirement: "subscription",
    });

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("account/read", { refreshToken: false });
  });

  it("rejects native API-key auth for subscription routes", async () => {
    const request = vi.fn(async () => ({
      account: { type: "apiKey" },
      requiresOpenaiAuth: false,
    }));

    await expect(
      applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir: "/tmp/openclaw-agent",
        authProfileId: null,
        authRequirement: "subscription",
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(request).toHaveBeenCalledWith("account/read", { refreshToken: false });
  });

  it("rejects missing native auth for subscription routes", async () => {
    const request = vi.fn(async () => ({ account: null, requiresOpenaiAuth: true }));

    await expect(
      applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir: "/tmp/openclaw-agent",
        authProfileId: null,
        authRequirement: "subscription",
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(request).toHaveBeenCalledWith("account/read", { refreshToken: false });
  });

  it("falls back to CODEX_API_KEY when no auth profile and no Codex account is available", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return { account: null, requiresOpenaiAuth: true };
      }
      return { type: "apiKey" };
    });
    vi.stubEnv("CODEX_API_KEY", "codex-env-api-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-env-api-key");
    vi.stubEnv("CODEX_HOME", path.join(agentDir, "empty-codex-home"));
    vi.stubEnv("HOME", path.join(agentDir, "empty-home"));
    try {
      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authRequirement: "api-key",
        startOptions: createStartOptions({
          env: { CODEX_API_KEY: "test-token-placeholder" },
        }),
      });

      expect(request).toHaveBeenNthCalledWith(1, "account/read", { refreshToken: false });
      expect(request).toHaveBeenNthCalledWith(2, "account/login/start", {
        type: "apiKey",
        apiKey: "test-token-placeholder",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("falls back to OPENAI_API_KEY when CODEX_API_KEY is not set", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return { account: null, requiresOpenaiAuth: true };
      }
      return { type: "apiKey" };
    });
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "openai-env-api-key");
    try {
      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authRequirement: "api-key",
        startOptions: createStartOptions(),
      });

      expect(request).toHaveBeenNthCalledWith(1, "account/read", { refreshToken: false });
      expect(request).toHaveBeenNthCalledWith(2, "account/login/start", {
        type: "apiKey",
        apiKey: "openai-env-api-key",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps an existing app-server ChatGPT account over env API-key fallback", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return {
          account: { type: "chatgpt", email: "codex@example.test", planType: "plus" },
          requiresOpenaiAuth: true,
        };
      }
      return { type: "apiKey" };
    });
    vi.stubEnv("CODEX_API_KEY", "codex-env-api-key");
    try {
      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authRequirement: "api-key",
        startOptions: createStartOptions(),
      });

      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith("account/read", { refreshToken: false });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("uses env API-key fallback when app-server has no account", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return { account: null, requiresOpenaiAuth: false };
      }
      return { type: "apiKey" };
    });
    vi.stubEnv("CODEX_API_KEY", "codex-env-api-key");
    try {
      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authRequirement: "api-key",
        startOptions: createStartOptions(),
      });

      expect(request).toHaveBeenNthCalledWith(1, "account/read", { refreshToken: false });
      expect(request).toHaveBeenNthCalledWith(2, "account/login/start", {
        type: "apiKey",
        apiKey: "codex-env-api-key",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("uses Codex CLI api-key auth.json when no auth profile or env key exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const agentDir = path.join(root, "agent");
    const codexHome = path.join(root, "codex-cli");
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return { account: null, requiresOpenaiAuth: true };
      }
      return { type: "apiKey" };
    });
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    try {
      await writeCodexCliApiKeyAuthFile(codexHome);

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authRequirement: "api-key",
        startOptions: createStartOptions({
          env: { CODEX_HOME: path.join(root, "isolated-codex-home") },
        }),
      });

      expect(request).toHaveBeenNthCalledWith(1, "account/read", { refreshToken: false });
      expect(request).toHaveBeenNthCalledWith(2, "account/login/start", {
        type: "apiKey",
        apiKey: "cli-auth-json-api-key",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("includes Codex CLI api-key auth.json in fallback app-server cache keys", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const codexHome = path.join(root, "codex-cli");
    try {
      await writeCodexCliApiKeyAuthFile(codexHome);

      const first = resolveCodexAppServerFallbackApiKeyCacheKey({
        startOptions: createStartOptions(),
        baseEnv: { CODEX_HOME: codexHome },
      });
      await fs.writeFile(
        path.join(codexHome, "auth.json"),
        `${JSON.stringify({
          auth_mode: "apikey",
          OPENAI_API_KEY: "second-cli-auth-json-api-key",
        })}\n`,
      );
      const second = resolveCodexAppServerFallbackApiKeyCacheKey({
        startOptions: createStartOptions(),
        baseEnv: { CODEX_HOME: codexHome },
      });

      expect(first).toMatch(/^CODEX_AUTH_JSON:sha256:[a-f0-9]{64}$/);
      expect(second).toMatch(/^CODEX_AUTH_JSON:sha256:[a-f0-9]{64}$/);
      expect(second).not.toBe(first);
      expect(first).not.toContain("cli-auth-json-api-key");
      expect(second).not.toContain("second-cli-auth-json-api-key");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not include Codex CLI api-key auth.json in websocket fallback cache keys", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const codexHome = path.join(root, "codex-cli");
    try {
      await writeCodexCliApiKeyAuthFile(codexHome);

      expect(
        resolveCodexAppServerFallbackApiKeyCacheKey({
          startOptions: createStartOptions({
            transport: "websocket",
            url: "ws://127.0.0.1:1455",
          }),
          baseEnv: { CODEX_HOME: codexHome },
        }),
      ).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("honors clearEnv before env API-key fallback", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return { account: null, requiresOpenaiAuth: true };
      }
      return { type: "apiKey" };
    });
    vi.stubEnv("CODEX_API_KEY", "codex-env-api-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-env-api-key");
    vi.stubEnv("CODEX_HOME", path.join(agentDir, "empty-codex-home"));
    vi.stubEnv("HOME", path.join(agentDir, "empty-home"));
    try {
      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authRequirement: "api-key",
        startOptions: createStartOptions({
          clearEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
        }),
      });

      expect(request).not.toHaveBeenCalled();
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("does not send env API-key fallback to websocket app-server connections", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async (method: string) => {
      if (method === "account/read") {
        return { account: null, requiresOpenaiAuth: true };
      }
      return { type: "apiKey" };
    });
    vi.stubEnv("CODEX_API_KEY", "codex-env-api-key");
    vi.stubEnv("OPENAI_API_KEY", "openai-env-api-key");
    try {
      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authRequirement: "api-key",
        startOptions: createStartOptions({
          transport: "websocket",
          url: "ws://127.0.0.1:1455",
        }),
      });

      expect(request).not.toHaveBeenCalled();
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("applies an OpenAI Codex token profile backed by a secret ref", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    const access = chatgptAccessToken("ref-backed-account");
    vi.stubEnv("OPENAI_CODEX_TOKEN", access);
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "token",
          provider: "openai",
          tokenRef: { source: "env", provider: "default", id: "OPENAI_CODEX_TOKEN" },
          email: "codex@example.test",
        },
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:work",
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: access,
        chatgptAccountId: "ref-backed-account",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("passes OpenAI Codex token profiles through to app-server token login", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    const access = chatgptAccessToken("token-profile-account");
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "token",
          provider: "openai",
          token: access,
        },
      });

      await expect(
        applyCodexAppServerAuthProfile({
          client: { request } as never,
          agentDir,
          authProfileId: "openai:work",
        }),
      ).resolves.toBeUndefined();

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: access,
        chatgptAccountId: "token-profile-account",
        chatgptPlanType: null,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("passes OpenAI Codex API-key profiles through to app-server API-key login", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "apiKey" }));
    const tokenLikeKey = "eyJhbGciOiJub25l.eyJzdWIiOiJjb2RleCJ9.signature123456";
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "api_key",
          provider: "openai",
          key: tokenLikeKey,
        },
      });

      await expect(
        applyCodexAppServerAuthProfile({
          client: { request } as never,
          agentDir,
          authProfileId: "openai:work",
        }),
      ).resolves.toBeUndefined();

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "apiKey",
        apiKey: tokenLikeKey,
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it.each(["codex-cli", "openai-codex"] as const)(
    "rejects retired %s auth-provider profiles before app-server login",
    async (provider) => {
      const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
      const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
      try {
        upsertAuthProfile({
          agentDir,
          profileId: "openai:work",
          credential: {
            type: "token",
            provider,
            token: "legacy-access-token",
            email: "legacy-codex@example.test",
          },
        });

        await expect(
          applyCodexAppServerAuthProfile({
            client: { request } as never,
            agentDir,
            authProfileId: "openai:work",
          }),
        ).rejects.toThrow(
          'Codex app-server auth profile "openai:work" must use the canonical OpenAI auth provider; run "openclaw doctor --fix" to migrate legacy provider IDs.',
        );
        await expect(
          resolveCodexAppServerAuthAccountCacheKey({
            agentDir,
            authProfileId: "openai:work",
          }),
        ).resolves.toBeUndefined();
        await expect(
          resolveCodexAppServerPreparedAuthProfileSnapshot({
            agentDir,
            authProfileId: "openai:work",
          }),
        ).resolves.toBeUndefined();
        expect(request).not.toHaveBeenCalled();
      } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
      }
    },
  );

  it("answers app-server ChatGPT token refresh requests from the bound profile", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "refreshed-access-token",
      refresh: "refreshed-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-789",
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "stale-access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
          accountId: "account-123",
          email: "codex@example.test",
        },
      });

      await expect(
        refreshCodexAppServerAuthTokens({
          agentDir,
          authProfileId: "openai:work",
        }),
      ).resolves.toEqual({
        accessToken: "refreshed-access-token",
        chatgptAccountId: "account-789",
        chatgptPlanType: null,
      });
      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("refresh-token");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      identity: "profile metadata",
      access: "workspace-access-token",
      accountId: "workspace-selected",
    },
    {
      identity: "access-token claims",
      access: chatgptAccessToken("workspace-selected"),
      accountId: undefined,
    },
  ])(
    "rejects a different previous workspace from $identity before refreshing",
    async ({ access, accountId }) => {
      const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
      try {
        upsertAuthProfile({
          agentDir,
          profileId: "openai:work",
          credential: {
            type: "oauth",
            provider: "openai",
            access,
            refresh: "workspace-refresh-token",
            expires: Date.now() + 60_000,
            ...(accountId ? { accountId } : {}),
          },
        });

        await expect(
          refreshCodexAppServerAuthTokens({
            agentDir,
            authProfileId: "openai:work",
            previousAccountId: "workspace-original",
          }),
        ).rejects.toThrow("ChatGPT workspace changed");
        expect(oauthMocks.refreshOpenAICodexToken).not.toHaveBeenCalled();
      } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
      }
    },
  );

  it("does not persist an expired stale credential before forced token refresh succeeds", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const currentExpiry = Date.now() + 60_000;
    oauthMocks.refreshOpenAICodexToken.mockImplementationOnce(async () => {
      const persistedProfile = expectOAuthProfile(
        loadAuthProfileStoreForSecretsRuntime(agentDir).profiles["openai:work"],
      );
      expect(persistedProfile).toMatchObject({
        access: "current-access-token",
        expires: currentExpiry,
      });
      return {
        access: "refreshed-access-token",
        refresh: "refreshed-refresh-token",
        expires: Date.now() + 60_000,
        accountId: "account-789",
      };
    });
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "current-access-token",
          refresh: "refresh-token",
          expires: currentExpiry,
          accountId: "account-123",
          email: "codex@example.test",
        },
      });

      await expect(
        refreshCodexAppServerAuthTokens({
          agentDir,
          authProfileId: "openai:work",
        }),
      ).resolves.toEqual({
        accessToken: "refreshed-access-token",
        chatgptAccountId: "account-789",
        chatgptPlanType: null,
      });
      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("refresh-token");
      const refreshedProfile = expectOAuthProfile(
        loadAuthProfileStoreForSecretsRuntime(agentDir).profiles["openai:work"],
      );
      expect(refreshedProfile?.access).toBe("refreshed-access-token");
      expect(refreshedProfile?.refresh).toBe("refreshed-refresh-token");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("refreshes inherited main Codex OAuth without cloning it into the child store", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const stateDir = path.join(root, "state");
    const childAgentDir = path.join(stateDir, "agents", "worker", "agent");
    const childAuthPath = path.join(childAgentDir, "auth-profiles.json");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", "");
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "main-refreshed-access-token",
      refresh: "main-refreshed-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-main-refreshed",
    });
    try {
      upsertAuthProfile({
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "main-current-access-token",
          refresh: "main-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "account-main",
          email: "main-codex@example.test",
        },
      });

      await expect(
        refreshCodexAppServerAuthTokens({
          agentDir: childAgentDir,
          authProfileId: "openai:work",
        }),
      ).resolves.toEqual({
        accessToken: "main-refreshed-access-token",
        chatgptAccountId: "account-main-refreshed",
        chatgptPlanType: null,
      });

      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("main-refresh-token");
      await expectPathMissing(childAuthPath);
      const mainProfile = expectOAuthProfile(
        loadAuthProfileStoreForSecretsRuntime().profiles["openai:work"],
      );
      expect(mainProfile?.provider).toBe("openai");
      expect(mainProfile?.access).toBe("main-refreshed-access-token");
      expect(mainProfile?.refresh).toBe("main-refreshed-refresh-token");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("force-refreshes the owner credential instead of a stale child OAuth clone", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const stateDir = path.join(root, "state");
    const childAgentDir = path.join(stateDir, "agents", "worker", "agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", "");
    oauthMocks.refreshOpenAICodexToken.mockResolvedValueOnce({
      access: "main-refreshed-access-token",
      refresh: "main-refreshed-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "account-main-refreshed",
    });
    try {
      await fs.mkdir(childAgentDir, { recursive: true });
      upsertAuthProfile({
        agentDir: childAgentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "child-stale-access-token",
          refresh: "child-stale-refresh-token",
          expires: Date.now() - 60_000,
          accountId: "account-main",
          email: "main-codex@example.test",
        },
      });
      upsertAuthProfile({
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "main-current-access-token",
          refresh: "main-owner-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "account-main",
          email: "main-codex@example.test",
        },
      });
      const staleChildProfile = expectOAuthProfile(
        loadAuthProfileStoreForSecretsRuntime(childAgentDir).profiles["openai:work"],
      );
      expect(staleChildProfile?.access).toBe("child-stale-access-token");
      expect(staleChildProfile?.refresh).toBe("child-stale-refresh-token");

      await expect(
        refreshCodexAppServerAuthTokens({
          agentDir: childAgentDir,
          authProfileId: "openai:work",
        }),
      ).resolves.toEqual({
        accessToken: "main-refreshed-access-token",
        chatgptAccountId: "account-main-refreshed",
        chatgptPlanType: null,
      });

      expect(oauthMocks.refreshOpenAICodexToken).toHaveBeenCalledWith("main-owner-refresh-token");
      const mainProfile = expectOAuthProfile(
        loadAuthProfileStoreForSecretsRuntime().profiles["openai:work"],
      );
      expect(mainProfile?.provider).toBe("openai");
      expect(mainProfile?.access).toBe("main-refreshed-access-token");
      expect(mainProfile?.refresh).toBe("main-refreshed-refresh-token");
      const childProfile = expectOAuthProfile(
        loadAuthProfileStoreForSecretsRuntime(childAgentDir).profiles["openai:work"],
      );
      // Refresh ownership writes the main profile; it does not silently mutate
      // the stale child clone that request-time resolution intentionally bypassed.
      expect(childProfile?.access).toBe("child-stale-access-token");
      expect(childProfile?.refresh).toBe("child-stale-refresh-token");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["codex-cli", "openai-codex"] as const)(
    "rejects retired %s auth-provider profiles before OAuth refresh",
    async (provider) => {
      const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
      try {
        upsertAuthProfile({
          agentDir,
          profileId: "openai:work",
          credential: {
            type: "oauth",
            provider,
            access: "stale-alias-access-token",
            refresh: "alias-refresh-token",
            expires: Date.now() + 60_000,
            accountId: "account-legacy",
            email: "legacy-codex@example.test",
          },
        });

        await expect(
          refreshCodexAppServerAuthTokens({
            agentDir,
            authProfileId: "openai:work",
          }),
        ).rejects.toThrow(
          'Codex app-server auth profile "openai:work" must use the canonical OpenAI auth provider; run "openclaw doctor --fix" to migrate legacy provider IDs.',
        );
        expect(oauthMocks.refreshOpenAICodexToken).not.toHaveBeenCalled();
        expect(
          providerRuntimeMocks.refreshProviderOAuthCredentialWithPlugin,
        ).not.toHaveBeenCalled();
      } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
      }
    },
  );

  it("preserves a stored ChatGPT plan type when building token login params", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-app-server-"));
    const request = vi.fn(async () => ({ type: "chatgptAuthTokens" }));
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai:work",
        credential: {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 24 * 60 * 60_000,
          accountId: "account-123",
          email: "codex@example.test",
          chatgptPlanType: "pro",
        } as never,
      });

      await applyCodexAppServerAuthProfile({
        client: { request } as never,
        agentDir,
        authProfileId: "openai:work",
      });

      expect(request).toHaveBeenCalledWith("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: "access-token",
        chatgptAccountId: "account-123",
        chatgptPlanType: "pro",
      });
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
