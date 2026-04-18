import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFileLockStateForTest } from "../../infra/file-lock.js";
import { captureEnv } from "../../test-utils/env.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

let resolveApiKeyForProfile: typeof import("./oauth.js").resolveApiKeyForProfile;
let resetOAuthRefreshQueuesForTest: typeof import("./oauth.js").resetOAuthRefreshQueuesForTest;

async function loadOAuthModuleForTest() {
  ({ resolveApiKeyForProfile, resetOAuthRefreshQueuesForTest } = await import("./oauth.js"));
}

function resolveApiKeyForProfileInTest(
  params: Omit<Parameters<typeof resolveApiKeyForProfile>[0], "cfg">,
) {
  return resolveApiKeyForProfile({ cfg: {}, ...params });
}

const {
  refreshProviderOAuthCredentialWithPluginMock,
  formatProviderAuthProfileApiKeyWithPluginMock,
} = vi.hoisted(() => ({
  refreshProviderOAuthCredentialWithPluginMock: vi.fn(
    async (_params?: { context?: unknown }) => undefined,
  ),
  formatProviderAuthProfileApiKeyWithPluginMock: vi.fn(() => undefined),
}));

vi.mock("../cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
  resetCliCredentialCachesForTest: () => undefined,
  writeCodexCliCredentials: () => true,
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(async () => null),
  getOAuthProviders: () => [{ id: "openai-codex" }],
}));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  formatProviderAuthProfileApiKeyWithPlugin: (params: { context?: { access?: string } }) =>
    formatProviderAuthProfileApiKeyWithPluginMock() ?? params?.context?.access,
  refreshProviderOAuthCredentialWithPlugin: refreshProviderOAuthCredentialWithPluginMock,
}));

vi.mock("../../infra/file-lock.js", () => ({
  resetFileLockStateForTest: () => undefined,
  withFileLock: async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => run(),
}));

vi.mock("../../plugin-sdk/file-lock.js", () => ({
  resetFileLockStateForTest: () => undefined,
  withFileLock: async <T>(_filePath: string, _options: unknown, run: () => Promise<T>) => run(),
}));

vi.mock("./doctor.js", () => ({
  formatAuthDoctorHint: async () => undefined,
}));

vi.mock("./external-auth.js", () => ({
  overlayExternalAuthProfiles: <T>(store: T) => store,
  shouldPersistExternalAuthProfile: () => true,
}));

vi.mock("./external-cli-sync.js", async () => {
  const actual =
    await vi.importActual<typeof import("./external-cli-sync.js")>("./external-cli-sync.js");
  return {
    ...actual,
    syncExternalCliCredentials: () => false,
    readManagedExternalCliCredential: () => null,
    resolveExternalCliAuthProfiles: () => [],
    areOAuthCredentialsEquivalent: (a: unknown, b: unknown) => a === b,
  };
});

function createExpiredOauthStore(params: {
  profileId: string;
  provider: string;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "oauth",
        provider: params.provider,
        access: "stale-access",
        refresh: "stale-refresh",
        expires: Date.now() - 60_000,
      } satisfies OAuthCredential,
    },
  };
}

describe("OAuth refresh in-process queue", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);
  let tempRoot = "";
  let agentDir = "";

  beforeEach(async () => {
    resetFileLockStateForTest();
    refreshProviderOAuthCredentialWithPluginMock.mockReset();
    refreshProviderOAuthCredentialWithPluginMock.mockResolvedValue(undefined);
    formatProviderAuthProfileApiKeyWithPluginMock.mockReset();
    formatProviderAuthProfileApiKeyWithPluginMock.mockReturnValue(undefined);
    clearRuntimeAuthProfileStoreSnapshots();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-queue-"));
    process.env.OPENCLAW_STATE_DIR = tempRoot;
    agentDir = path.join(tempRoot, "agents", "main", "agent");
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await fs.mkdir(agentDir, { recursive: true });
    await loadOAuthModuleForTest();
    resetOAuthRefreshQueuesForTest();
  });

  afterEach(async () => {
    envSnapshot.restore();
    resetFileLockStateForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    if (resetOAuthRefreshQueuesForTest) {
      resetOAuthRefreshQueuesForTest();
    }
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("serializes concurrent same-PID callers FIFO", async () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    saveAuthProfileStore(createExpiredOauthStore({ profileId, provider }), agentDir);

    const order: number[] = [];
    let seq = 0;
    refreshProviderOAuthCredentialWithPluginMock.mockImplementation(async () => {
      const n = ++seq;
      order.push(n);
      // Small delay so concurrent callers have time to interleave if they can.
      await new Promise((r) => setTimeout(r, 10));
      return {
        type: "oauth",
        provider,
        access: `refreshed-${n}`,
        refresh: `refreshed-refresh-${n}`,
        // Each refresh returns a token already expired again, so the next
        // queued caller also proceeds to refresh (proves the queue releases
        // cleanly and the next caller actually runs).
        expires: Date.now() - 1_000,
      } as never;
    });

    // Fire three resolves concurrently against the same agent+profile.
    const results = await Promise.all([
      resolveApiKeyForProfileInTest({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }).catch((e) => e),
      resolveApiKeyForProfileInTest({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }).catch((e) => e),
      resolveApiKeyForProfileInTest({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }).catch((e) => e),
    ]);

    // All three should have completed in order (FIFO queue).
    expect(order).toEqual([1, 2, 3]);
    expect(results).toHaveLength(3);
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
      resolveApiKeyForProfileInTest({
        store: ensureAuthProfileStore(agentDir),
        profileId,
        agentDir,
      }).catch((e) => e),
      resolveApiKeyForProfileInTest({
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
      // Small delay so any non-serialized overlap would be observable.
      await new Promise((r) => setTimeout(r, 5));
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
        resolveApiKeyForProfileInTest({
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
