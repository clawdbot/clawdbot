import fs from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import "./oauth-external-auth-passthrough.test-support.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createOAuthMainAgentDir,
  createOAuthTestTempRoot,
  createExpiredOauthStore,
  removeOAuthTestTempRoot,
  resolveApiKeyForProfileInTest,
  resetOAuthProviderRuntimeMocks,
} from "./oauth-test-utils.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
let resetOAuthRefreshQueuesForTest: typeof import("./oauth.js").resetOAuthRefreshQueuesForTest;
type ResolveApiKeyResult = NonNullable<
  Awaited<ReturnType<typeof import("./oauth.js").resolveApiKeyForProfile>>
>;
type ConcurrentRefreshResult = {
  agentCount: number;
  callCount: number;
  provider: string;
  results: Array<ResolveApiKeyResult | null>;
};

async function loadOAuthModuleForTest() {
  ({ resolveApiKeyForProfile, resetOAuthRefreshQueuesForTest } = await import("./oauth.js"));
}

vi.mock("../../llm/oauth.js", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai" }],
}));

async function runConcurrentRefreshCase(): Promise<ConcurrentRefreshResult> {
  const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
  let tempRoot = "";

  try {
    resetFileLockStateForTest();
    resetOAuthProviderRuntimeMocks({
      refreshProviderOAuthCredentialWithPluginMock,
      formatProviderAuthProfileApiKeyWithPluginMock,
    });
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await createOAuthTestTempRoot("openclaw-oauth-concurrent-");
    const mainAgentDir = await createOAuthMainAgentDir(tempRoot);
    await loadOAuthModuleForTest();
    // Drop any refresh-queue entries left behind by a prior timed-out test.
    resetOAuthRefreshQueuesForTest();

    const agentCount = 2;
    const profileId = "openai:default";
    const provider = "openai";
    const accountId = "acct-shared";
    const freshExpiry = Date.now() + 60 * 60 * 1000;

    // Seed sub-agents + main with the SAME stale OAuth credential. Main is
    // also expired so it cannot short-circuit via adoptNewerMainOAuthCredential.
    const subAgents = await Promise.all(
      Array.from({ length: agentCount }, async (_, i) => {
        const dir = path.join(tempRoot, "agents", `sub-${i}`, "agent");
        await fs.mkdir(dir, { recursive: true });
        saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), dir);
        return dir;
      }),
    );
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider, accountId }), mainAgentDir);

    // Count invocations, and keep one event-loop turn to widen the race window.
    let callCount = 0;
    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
      callCount += 1;
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      return {
        type: "oauth",
        provider,
        access: "cross-agent-refreshed-access",
        refresh: "cross-agent-refreshed-refresh",
        expires: freshExpiry,
        accountId,
      } as never;
    });

    // Fire all agents concurrently. With the old per-agentDir lock this
    // would produce one refresh call per agent and refresh_token_reused
    // 401s. With the new global per-profile lock, only the first refresh is
    // performed; the remaining agents adopt the resulting fresh credentials.
    const results = await Promise.all(
      subAgents.map((agentDir) =>
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(agentDir),
          profileId,
          agentDir,
        }),
      ),
    );

    return { agentCount, callCount, provider, results };
  } finally {
    envSnapshot.restore();
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    if (resetOAuthRefreshQueuesForTest) {
      resetOAuthRefreshQueuesForTest();
    }
    await removeOAuthTestTempRoot(tempRoot);
  }
}

describe("resolveApiKeyForProfile cross-agent refresh coordination (#26322)", () => {
  let refreshResult: ConcurrentRefreshResult;

  beforeAll(async () => {
    refreshResult = await runConcurrentRefreshCase();
  });

  it("refreshes exactly once when many agents share one OAuth profile and all race on expiry", () => {
    expect(refreshResult.callCount).toBe(1);
    expect(refreshResult.results).toHaveLength(refreshResult.agentCount);
    for (const result of refreshResult.results) {
      if (!result) {
        throw new Error("Expected refreshed OAuth credential result");
      }
      expect(result.apiKey).toBe("cross-agent-refreshed-access");
      expect(result.provider).toBe(refreshResult.provider);
    }
  }, 10_000);
});
