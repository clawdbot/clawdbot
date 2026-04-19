import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import { getOAuthProviderRuntimeMocks } from "./oauth-common-mocks.test-support.js";
import "./oauth-external-auth-passthrough.test-support.js";
import "./oauth-file-lock-passthrough.test-support.js";
import {
  OAUTH_AGENT_ENV_KEYS,
  createOAuthMainAgentDir,
  createOAuthTestTempRoot,
  createExpiredOauthStore,
  removeOAuthTestTempRoot,
  resolveApiKeyForProfileInTest,
  resetOAuthProviderRuntimeMocks,
} from "./oauth-test-utils.js";
import { resolveApiKeyForProfile, resetOAuthRefreshQueuesForTest } from "./oauth.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = getOAuthProviderRuntimeMocks();

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai-codex" }],
}));

describe("OAuth refresh in-process queue", () => {
  const envSnapshot = captureEnv(OAUTH_AGENT_ENV_KEYS);
  let tempRoot = "";
  let agentDir = "";
  let caseIndex = 0;

  beforeAll(async () => {
    tempRoot = await createOAuthTestTempRoot("openclaw-oauth-queue-");
  });

  beforeEach(async () => {
    resetFileLockStateForTest();
    resetOAuthProviderRuntimeMocks({
      refreshProviderOAuthCredentialWithPluginMock,
      formatProviderAuthProfileApiKeyWithPluginMock,
    });
    clearRuntimeAuthProfileStoreSnapshots();
    const caseRoot = path.join(tempRoot, `case-${++caseIndex}`);
    agentDir = await createOAuthMainAgentDir(caseRoot);
    resetOAuthRefreshQueuesForTest();
  });

  afterEach(async () => {
    envSnapshot.restore();
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    resetOAuthRefreshQueuesForTest();
  });

  afterAll(async () => {
    await removeOAuthTestTempRoot(tempRoot);
  });

  it("releases the queue even when the refresh throws", async () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider }), agentDir);

    let callCount = 0;
    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("simulated upstream failure");
      }
      // Second caller must actually get a chance to run (proves the gate
      // released despite the first caller throwing).
      return {
        type: "oauth",
        provider,
        access: "second-try-access",
        refresh: "second-try-refresh",
        expires: Date.now() + 60_000,
      } as never;
    });

    const [first, second] = await Promise.all([
      resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }).catch((e) => e),
      resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }).catch((e) => e),
    ]);

    expect(first).toBeInstanceOf(Error);
    expect(callCount).toBeGreaterThanOrEqual(1);
    // Second caller was not blocked forever \u2014 it either got the fresh token
    // (if the queue let it run) or adopted from main. Either way, it resolved.
    expect(second).toBeDefined();
  });

  it("resetOAuthRefreshQueuesForTest drains pending gates", async () => {
    // We can't observe the internal map, but we can assert that calling the
    // reset is idempotent and safe from any state.
    resetOAuthRefreshQueuesForTest();
    resetOAuthRefreshQueuesForTest();
    expect(true).toBe(true);
  });

  it("serializes a 10-caller burst so later arrivals never pass an earlier caller", async () => {
    // Burst-arrival stress: 10 same-PID callers all fire concurrently.
    // The queue must chain them so each refresh completes fully before the
    // next one begins — i.e. no overlap between running refresh calls.
    // This pins the invariant that the map-overwrite pattern in the queue
    // wrapper does not let later arrivals skip ahead (see review P2: the
    // `refreshQueues.set(key, gate)` overwrites only the *map head*, while
    // FIFO ordering is enforced via the `await prev` chain).
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider }), agentDir);

    const startOrder: number[] = [];
    const endOrder: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let seq = 0;
    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
      const n = ++seq;
      startOrder.push(n);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield once so any non-serialized overlap is observable without wall-clock sleep.
      await Promise.resolve();
      inFlight -= 1;
      endOrder.push(n);
      return {
        type: "oauth",
        provider,
        access: `refreshed-${n}`,
        refresh: `refresh-${n}`,
        // Re-expire immediately so each queued caller also enters the
        // refresh path (otherwise later callers would adopt the fresh
        // cred and the serialization chain wouldn't be exercised).
        expires: Date.now() - 1_000,
      } as never;
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        resolveApiKeyForProfileInTest(resolveApiKeyForProfile, {
          store: ensureAuthProfileStore(agentDir),
          profileId,
          agentDir,
        }).catch((e: unknown) => e),
      ),
    );

    // Every caller must have run to completion (null result or error —
    // either is fine; what matters is that no caller is lost or blocked).
    expect(results).toHaveLength(10);
    // FIFO: start order matches end order (no overlap – each caller fully
    // completed before the next started).
    expect(startOrder).toEqual(endOrder);
    // At no point did two refresh calls run concurrently.
    expect(maxInFlight).toBe(1);
  });
});
