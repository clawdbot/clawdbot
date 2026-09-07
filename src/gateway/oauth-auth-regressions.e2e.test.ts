import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  markAuthProfileUsed,
  saveAuthProfileStore,
  type AuthProfileStore,
  type OAuthCredential,
} from "../agents/auth-profiles.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { modelsStatusCommand } from "../commands/models/list.status-command.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import { resetFileLockStateForTest } from "../infra/file-lock.js";
import { invalidateModelAuthStatusCache } from "./server-methods/models-auth-status.js";
import { startGatewayServer } from "./server.js";
import { connectGatewayClient, getFreeGatewayPort } from "./test-helpers.e2e.js";

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = vi.hoisted(() => ({
  refreshProviderOAuthCredentialWithPluginMock: vi.fn<
    (params?: { context?: unknown }) => Promise<OAuthCredential | undefined>
  >(async () => undefined),
  formatProviderAuthProfileApiKeyWithPluginMock: vi.fn(() => undefined),
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  refreshProviderOAuthCredentialWithPlugin: refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPlugin: (params: { context?: { access?: string } }) =>
    formatProviderAuthProfileApiKeyWithPluginMock() ?? params.context?.access,
}));

type ModelsStatusJson = {
  auth?: {
    unusableProfiles?: Array<{
      profileId: string;
      provider?: string;
      kind: "cooldown" | "disabled";
      reason?: string;
      remainingMs: number;
    }>;
    oauth?: {
      profiles?: Array<{
        profileId: string;
        provider: string;
        status: string;
        remainingMs?: number;
      }>;
      providers?: Array<{
        provider: string;
        status: string;
        remainingMs?: number;
        profiles?: Array<{ profileId: string; status: string }>;
      }>;
    };
  };
};

type GatewayAuthStatusJson = {
  ts: number;
  providers: Array<{
    provider: string;
    status: string;
    expiry?: { at: number; remainingMs: number; label: string };
    profiles: Array<{
      profileId: string;
      type: "oauth" | "token" | "api_key";
      status: string;
      expiry?: { at: number; remainingMs: number; label: string };
    }>;
  }>;
};

function resetOauthRegressionRuntimeState() {
  resetFileLockStateForTest();
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  invalidateModelAuthStatusCache();
  refreshProviderOAuthCredentialWithPluginMock.mockReset();
  refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue(undefined);
  formatProviderAuthProfileApiKeyWithPluginMock.mockReset();
  formatProviderAuthProfileApiKeyWithPluginMock.mockReturnValue(undefined);
}

function createJsonRuntime() {
  const payloads: unknown[] = [];
  return {
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn((value: unknown) => {
        payloads.push(value);
      }),
    },
    payloads,
  };
}

async function captureModelsStatusJson(): Promise<ModelsStatusJson> {
  const { runtime, payloads } = createJsonRuntime();
  await modelsStatusCommand(
    {
      json: true,
      check: false,
    },
    runtime,
  );
  const lastPayload = payloads.at(-1);
  if (!lastPayload || typeof lastPayload !== "object") {
    throw new Error("models status did not emit JSON output");
  }
  return lastPayload as ModelsStatusJson;
}

async function captureGatewayAuthStatusJson(): Promise<GatewayAuthStatusJson> {
  const port = await getFreeGatewayPort();
  const token = "oauth-regression-token";
  const server = await startGatewayServer(port, {
    host: "127.0.0.1",
    auth: { mode: "token", token },
    controlUiEnabled: false,
  });
  const client = await connectGatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token,
  });

  try {
    return (await client.request("models.authStatus", {
      refresh: true,
    })) as GatewayAuthStatusJson;
  } finally {
    await client.stopAndWait();
    await server.close({ reason: "oauth regression e2e done" });
  }
}

function buildExpiredRefreshableOauthStore(params: {
  profileId: string;
  provider: string;
  order?: string[];
  accountId?: string;
  disabledReason?: "auth_permanent";
  disabledUntil?: number;
}): AuthProfileStore {
  const now = Date.now();
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "oauth",
        provider: params.provider,
        access: "expired-access-token",
        refresh: "refresh-token",
        expires: now - 60_000,
        ...(params.accountId ? { accountId: params.accountId } : {}),
      },
    },
    ...(params.order
      ? {
          order: {
            [params.provider]: params.order,
          },
        }
      : {}),
    lastGood: {
      [params.provider]: params.profileId,
    },
    usageStats: {
      [params.profileId]: {
        lastUsed: now - 120_000,
        ...(params.disabledReason ? { disabledReason: params.disabledReason } : {}),
        ...(typeof params.disabledUntil === "number"
          ? { disabledUntil: params.disabledUntil }
          : {}),
      },
    },
  };
}

function buildValidOauthCredential(params: {
  provider: string;
  access: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
}) {
  return {
    type: "oauth" as const,
    provider: params.provider,
    access: params.access,
    refresh: params.refresh ?? "valid-refresh-token",
    expires: params.expires ?? Date.now() + 60 * 60 * 1000,
    ...(params.accountId ? { accountId: params.accountId } : {}),
  };
}

describe("oauth auth regressions (e2e)", () => {
  beforeEach(() => {
    resetOauthRegressionRuntimeState();
  });

  afterEach(() => {
    resetOauthRegressionRuntimeState();
  });

  it("captures the same refreshable OAuth profile through CLI and gateway status surfaces", async () => {
    await withTempHome(
      async () => {
        const agentDir = resolveOpenClawAgentDir();
        saveAuthProfileStore(
          buildExpiredRefreshableOauthStore({
            profileId: "openai-codex:default",
            provider: "openai-codex",
            order: ["openai-codex:default"],
          }),
          agentDir,
        );
        resetOauthRegressionRuntimeState();

        const cliStatus = await captureModelsStatusJson();
        const cliProvider = cliStatus.auth?.oauth?.providers?.find(
          (provider) => provider.provider === "openai-codex",
        );
        const cliProfile = cliStatus.auth?.oauth?.profiles?.find(
          (profile) => profile.profileId === "openai-codex:default",
        );

        expect(cliProvider).toBeDefined();
        expect(cliProfile).toBeDefined();

        const gatewayStatus = await captureGatewayAuthStatusJson();
        const gatewayProvider = gatewayStatus.providers.find(
          (provider) => provider.provider === "openai-codex",
        );
        const gatewayProfile = gatewayProvider?.profiles.find(
          (profile) => profile.profileId === "openai-codex:default",
        );

        expect(gatewayProvider).toBeDefined();
        expect(gatewayProfile).toBeDefined();
        expect(gatewayProfile?.type).toBe("oauth");
      },
      { prefix: "openclaw-oauth-e2e-" },
    );
  });

  it("appends discovered provider OAuth profiles behind stale explicit order before provider execution (#66952)", async () => {
    await withTempHome(
      async () => {
        const agentDir = resolveOpenClawAgentDir();
        const provider = "openai-codex";
        const validProfileId = "openai-codex:user@example.com";
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              "openai-codex:default": {
                type: "token",
                provider,
                token: "expired-default-token",
                expires: Date.now() - 60_000,
              },
              "openai-codex:codex-cli": {
                type: "token",
                provider,
                token: "expired-cli-token",
                expires: Date.now() - 60_000,
              },
              [validProfileId]: buildValidOauthCredential({
                provider,
                access: "valid-email-profile-access-token",
                accountId: "acct-email-profile",
              }),
            },
            order: {
              [provider]: ["openai-codex:default", "openai-codex:codex-cli"],
            },
          },
          agentDir,
        );
        resetOauthRegressionRuntimeState();

        const resolved = await resolveApiKeyForProvider({
          provider,
          agentDir,
          store: ensureAuthProfileStore(agentDir),
        });

        expect(resolved.profileId).toBe(validProfileId);
        expect(resolved.source).toBe(`profile:${validProfileId}`);
        expect(resolved.apiKey).toBe("valid-email-profile-access-token");
        expect(resolved.mode).toBe("oauth");
      },
      { prefix: "openclaw-oauth-e2e-" },
    );
  });

  it("coalesces a shared OAuth refresh across concurrent agent dirs so refresh_token_reused never surfaces", async () => {
    await withTempHome(
      async () => {
        const stateDir = process.env.OPENCLAW_STATE_DIR;
        if (!stateDir) {
          throw new Error("missing OPENCLAW_STATE_DIR for oauth e2e test");
        }
        const profileId = "openai-codex:default";
        const provider = "openai-codex";
        const accountId = "acct-shared";
        const freshExpiry = Date.now() + 60 * 60 * 1000;
        const mainAgentDir = resolveOpenClawAgentDir();
        const subAgentDirs = await Promise.all(
          Array.from({ length: 5 }, async (_, index) => {
            const dir = path.join(stateDir, "agents", `sub-${index}`, "agent");
            await fs.mkdir(dir, { recursive: true });
            return dir;
          }),
        );

        const sharedStore = buildExpiredRefreshableOauthStore({
          profileId,
          provider,
          accountId,
        });
        saveAuthProfileStore(sharedStore, mainAgentDir);
        for (const dir of subAgentDirs) {
          saveAuthProfileStore(sharedStore, dir);
        }
        resetOauthRegressionRuntimeState();

        let refreshCalls = 0;
        refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
          refreshCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 25));
          return buildValidOauthCredential({
            provider,
            access: "shared-refreshed-access-token",
            refresh: "shared-refreshed-refresh-token",
            expires: freshExpiry,
            accountId,
          });
        });

        const results = await Promise.all(
          subAgentDirs.map((agentDir) =>
            resolveApiKeyForProvider({
              provider,
              agentDir,
              store: ensureAuthProfileStore(agentDir),
            }),
          ),
        );

        expect(refreshCalls).toBe(1);
        expect(results).toHaveLength(subAgentDirs.length);
        for (const result of results) {
          expect(result.apiKey).toBe("shared-refreshed-access-token");
          expect(result.profileId).toBe(profileId);
          expect(result.mode).toBe("oauth");
        }
      },
      { prefix: "openclaw-oauth-e2e-" },
    );
  }, 20_000);

  it("persists permanent OAuth refresh failures into auth status so models status and gateway status both go unhealthy", async () => {
    await withTempHome(
      async () => {
        const agentDir = resolveOpenClawAgentDir();
        const profileId = "openai-codex:default";
        saveAuthProfileStore(
          buildExpiredRefreshableOauthStore({
            profileId,
            provider: "openai-codex",
            order: [profileId],
            disabledReason: "auth_permanent",
            disabledUntil: Date.now() + 60 * 60 * 1000,
          }),
          agentDir,
        );
        resetOauthRegressionRuntimeState();

        const cliStatus = await captureModelsStatusJson();
        const cliUnusable = cliStatus.auth?.unusableProfiles?.find(
          (profile) => profile.profileId === profileId,
        );
        const cliProvider = cliStatus.auth?.oauth?.providers?.find(
          (provider) => provider.provider === "openai-codex",
        );
        const cliProfile = cliStatus.auth?.oauth?.profiles?.find(
          (profile) => profile.profileId === profileId,
        );

        expect(cliUnusable).toMatchObject({
          profileId,
          kind: "disabled",
          reason: "auth_permanent",
        });
        expect(cliProvider?.status).not.toBe("ok");
        expect(cliProfile?.status).not.toBe("ok");

        const gatewayStatus = await captureGatewayAuthStatusJson();
        const gatewayProvider = gatewayStatus.providers.find(
          (provider) => provider.provider === "openai-codex",
        );
        const gatewayProfile = gatewayProvider?.profiles.find(
          (profile) => profile.profileId === profileId,
        );

        expect(gatewayProvider).toBeDefined();
        expect(gatewayProfile).toBeDefined();
        expect(gatewayProvider?.status).not.toBe("ok");
        expect(gatewayProfile?.status).not.toBe("ok");
      },
      { prefix: "openclaw-oauth-e2e-" },
    );
  });

  it("never reports a refreshable OAuth profile as status=ok when remainingMs is negative", async () => {
    await withTempHome(
      async () => {
        const agentDir = resolveOpenClawAgentDir();
        saveAuthProfileStore(
          buildExpiredRefreshableOauthStore({
            profileId: "openai-codex:default",
            provider: "openai-codex",
            order: ["openai-codex:default"],
          }),
          agentDir,
        );
        resetOauthRegressionRuntimeState();

        const cliStatus = await captureModelsStatusJson();
        const cliProvider = cliStatus.auth?.oauth?.providers?.find(
          (provider) => provider.provider === "openai-codex",
        );
        const cliProfile = cliStatus.auth?.oauth?.profiles?.find(
          (profile) => profile.profileId === "openai-codex:default",
        );

        expect(cliProvider).toBeDefined();
        expect(cliProfile).toBeDefined();
        expect(cliProvider?.remainingMs).toBeLessThan(0);
        expect(cliProfile?.remainingMs).toBeLessThan(0);
        expect(cliProvider?.status).not.toBe("ok");
        expect(cliProfile?.status).not.toBe("ok");

        const gatewayStatus = await captureGatewayAuthStatusJson();
        const gatewayProvider = gatewayStatus.providers.find(
          (provider) => provider.provider === "openai-codex",
        );
        const gatewayProfile = gatewayProvider?.profiles.find(
          (profile) => profile.profileId === "openai-codex:default",
        );

        expect(gatewayProvider).toBeDefined();
        expect(gatewayProfile).toBeDefined();
        expect(gatewayProvider?.expiry?.remainingMs).toBeLessThan(0);
        expect(gatewayProfile?.expiry?.remainingMs).toBeLessThan(0);
        expect(gatewayProvider?.status).not.toBe("ok");
        expect(gatewayProfile?.status).not.toBe("ok");
      },
      { prefix: "openclaw-oauth-e2e-" },
    );
  });

  it("clears auth_permanent OAuth failure state after a later successful refresh and request", async () => {
    await withTempHome(
      async () => {
        const agentDir = resolveOpenClawAgentDir();
        const profileId = "openai-codex:default";
        const provider = "openai-codex";
        const freshExpiry = Date.now() + 60 * 60 * 1000;
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              [profileId]: buildValidOauthCredential({
                provider,
                access: "fresh-access-token",
                expires: freshExpiry,
                accountId: "acct-fresh",
              }),
            },
            usageStats: {
              [profileId]: {
                disabledReason: "auth_permanent",
                disabledUntil: Date.now() + 60 * 60 * 1000,
              },
            },
          },
          agentDir,
        );
        resetOauthRegressionRuntimeState();

        await markAuthProfileUsed({
          store: ensureAuthProfileStore(agentDir),
          profileId,
          agentDir,
        });
        resetOauthRegressionRuntimeState();

        const cliStatus = await captureModelsStatusJson();
        const cliUnusable = cliStatus.auth?.unusableProfiles?.find(
          (profile) => profile.profileId === profileId,
        );
        const cliProvider = cliStatus.auth?.oauth?.providers?.find(
          (entry) => entry.provider === provider,
        );
        const cliProfile = cliStatus.auth?.oauth?.profiles?.find(
          (profile) => profile.profileId === profileId,
        );

        expect(cliUnusable).toBeUndefined();
        expect(cliProvider).toBeDefined();
        expect(cliProfile).toBeDefined();

        const gatewayStatus = await captureGatewayAuthStatusJson();
        const gatewayProvider = gatewayStatus.providers.find(
          (entry) => entry.provider === provider,
        );
        const gatewayProfile = gatewayProvider?.profiles.find(
          (profile) => profile.profileId === profileId,
        );

        expect(gatewayProvider).toBeDefined();
        expect(gatewayProfile).toBeDefined();
      },
      { prefix: "openclaw-oauth-e2e-" },
    );
  });
});
