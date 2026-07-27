/**
 * Auth-profile failure persistence tests.
 * Exercises lock-based usage updates, provider bypasses, and cooldown hook
 * behavior against temporary SQLite-backed stores.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";

vi.mock("./cli-credentials.js", () => ({
  readClaudeCliCredentialsCached: () => null,
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveExternalAuthProfilesWithPlugins: () => [],
}));

import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "./auth-profiles/store.js";
import {
  calculateAuthProfileCooldownMs,
  markAuthProfileFailure,
  setAuthProfileFailureHook,
} from "./auth-profiles/usage.js";

type AuthProfileStore = ReturnType<typeof ensureAuthProfileStore>;

let tempRoot = "";
let tempCaseIndex = 0;

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
});

afterAll(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function makeAgentDir(label = "case") {
  tempCaseIndex += 1;
  const agentDir = path.join(tempRoot, `${tempCaseIndex}-${label}`);
  fs.mkdirSync(agentDir, { recursive: true });
  return agentDir;
}

async function withAuthProfileStore(
  fn: (ctx: { agentDir: string; store: AuthProfileStore }) => Promise<void>,
): Promise<void> {
  const agentDir = makeAgentDir("store");
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-default",
        },
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          key: "sk-or-default",
        },
      },
    },
    agentDir,
    { filterExternalAuthProfiles: false, syncExternalCli: false },
  );

  const store = ensureAuthProfileStore(agentDir);
  await fn({ agentDir, store });
}

function expectCooldownInRange(remainingMs: number, minMs: number, maxMs: number): void {
  expect(remainingMs).toBeGreaterThan(minMs);
  expect(remainingMs).toBeLessThan(maxMs);
}

describe("markAuthProfileFailure", () => {
  it("does not overwrite fresher on-disk credentials with a stale runtime snapshot", async () => {
    const agentDir = makeAgentDir("stale-snapshot");
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-expired-old",
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );

    const staleRuntimeStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-expired-old",
        },
      },
    };

    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-fresh-new",
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );

    const staleCredential = staleRuntimeStore.profiles["openai:default"];
    expect(staleCredential?.type).toBe("api_key");
    expect(staleCredential && "key" in staleCredential ? staleCredential.key : undefined).toBe(
      "sk-expired-old",
    );

    await markAuthProfileFailure({
      store: staleRuntimeStore,
      profileId: "openai:default",
      reason: "rate_limit",
      agentDir,
    });

    clearRuntimeAuthProfileStoreSnapshots();
    const reloaded = ensureAuthProfileStore(agentDir);
    const reloadedCredential = reloaded.profiles["openai:default"];
    expect(reloadedCredential?.type).toBe("api_key");
    expect(
      reloadedCredential && "key" in reloadedCredential ? reloadedCredential.key : undefined,
    ).toBe("sk-fresh-new");
    expect(typeof reloaded.usageStats?.["openai:default"]?.cooldownUntil).toBe("number");
  });

  it("disables billing failures for ~5 hours by default", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      const startedAt = Date.now();
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "billing",
        agentDir,
      });

      const disabledUntil = store.usageStats?.["anthropic:default"]?.disabledUntil;
      expect(typeof disabledUntil).toBe("number");
      const remainingMs = (disabledUntil as number) - startedAt;
      expectCooldownInRange(remainingMs, 4.5 * 60 * 60 * 1000, 5.5 * 60 * 60 * 1000);
    });
  });
  it("keeps persisted cooldownUntil unchanged across mid-window retries", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "rate_limit",
        agentDir,
      });

      const firstCooldownUntil = store.usageStats?.["anthropic:default"]?.cooldownUntil;
      expect(typeof firstCooldownUntil).toBe("number");

      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "rate_limit",
        agentDir,
      });

      const secondCooldownUntil = store.usageStats?.["anthropic:default"]?.cooldownUntil;
      expect(secondCooldownUntil).toBe(firstCooldownUntil);

      const reloaded = ensureAuthProfileStore(agentDir);
      expect(reloaded.usageStats?.["anthropic:default"]?.cooldownUntil).toBe(firstCooldownUntil);
    });
  });
  it("records overloaded failures in the cooldown bucket", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "overloaded",
        agentDir,
      });

      const stats = store.usageStats?.["anthropic:default"];
      expect(typeof stats?.cooldownUntil).toBe("number");
      expect(stats?.disabledUntil).toBeUndefined();
      expect(stats?.disabledReason).toBeUndefined();
      expect(stats?.failureCounts?.overloaded).toBe(1);
    });
  });

  it("records timeout failures with model-scoped cooldown (#87462)", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "timeout",
        modelId: "claude-sonnet-4.6",
        agentDir,
      });

      const stats = store.usageStats?.["anthropic:default"];
      expect(typeof stats?.cooldownUntil).toBe("number");
      expect(stats?.cooldownReason).toBe("timeout");
      // cooldownModel must be set so fallback models on the same profile
      // can still bypass; otherwise one model's transient timeout takes
      // down the whole provider chain (#87462).
      expect(stats?.cooldownModel).toBe("claude-sonnet-4.6");
      expect(stats?.failureCounts?.timeout).toBe(1);
    });
  });
  it("disables auth_permanent failures for ~10 minutes by default", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      const startedAt = Date.now();
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "auth_permanent",
        agentDir,
      });

      const stats = store.usageStats?.["anthropic:default"];
      expect(typeof stats?.disabledUntil).toBe("number");
      expect(stats?.disabledReason).toBe("auth_permanent");
      // Should NOT set cooldownUntil (that's for transient errors)
      expect(stats?.cooldownUntil).toBeUndefined();
      const remainingMs = (stats?.disabledUntil as number) - startedAt;
      expectCooldownInRange(remainingMs, 9 * 60 * 1000, 11 * 60 * 1000);
    });
  });

  it("resets backoff counters outside the failure window", async () => {
    const agentDir = makeAgentDir("reset-window");
    const now = Date.now();
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-default",
          },
        },
        usageStats: {
          "anthropic:default": {
            errorCount: 9,
            failureCounts: { billing: 3 },
            lastFailureAt: now - 48 * 60 * 60 * 1000,
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );

    const store = ensureAuthProfileStore(agentDir);
    await markAuthProfileFailure({
      store,
      profileId: "anthropic:default",
      reason: "billing",
      agentDir,
    });

    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(1);
    expect(store.usageStats?.["anthropic:default"]?.failureCounts?.billing).toBe(1);
  });

  it("resets error count when previous cooldown has expired to prevent escalation", async () => {
    const agentDir = makeAgentDir("expired-cooldown");
    const now = Date.now();
    // Simulate state left on disk after 3 rapid failures within a 1-min cooldown
    // window. The cooldown has since expired, but clearExpiredCooldowns() only
    // ran in-memory and never persisted - so disk still carries errorCount: 3.
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "api_key",
            provider: "anthropic",
            key: "sk-default",
          },
        },
        usageStats: {
          "anthropic:default": {
            errorCount: 3,
            failureCounts: { rate_limit: 3 },
            lastFailureAt: now - 120_000, // 2 minutes ago
            cooldownUntil: now - 60_000, // expired 1 minute ago
          },
        },
      },
      agentDir,
      { filterExternalAuthProfiles: false, syncExternalCli: false },
    );

    const store = ensureAuthProfileStore(agentDir);
    await markAuthProfileFailure({
      store,
      profileId: "anthropic:default",
      reason: "rate_limit",
      agentDir,
    });

    const stats = store.usageStats?.["anthropic:default"];
    // Error count should reset to 1 (not escalate to 4) because the
    // previous cooldown expired. Cooldown should be ~30s, not ~5 min.
    expect(stats?.errorCount).toBe(1);
    expect(stats?.failureCounts?.rate_limit).toBe(1);
    const cooldownMs = (stats?.cooldownUntil ?? 0) - now;
    // calculateAuthProfileCooldownMs(1) = 30_000 (stepped: 30s -> 1m -> 5m)
    expectCooldownInRange(cooldownMs, 25_000, 35_000);
  });

  it("does not persist cooldown windows for OpenRouter profiles", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      await markAuthProfileFailure({
        store,
        profileId: "openrouter:default",
        reason: "rate_limit",
        agentDir,
      });

      await markAuthProfileFailure({
        store,
        profileId: "openrouter:default",
        reason: "billing",
        agentDir,
      });

      expect(store.usageStats?.["openrouter:default"]).toBeUndefined();

      const reloaded = ensureAuthProfileStore(agentDir);
      expect(reloaded.usageStats?.["openrouter:default"]).toBeUndefined();
    });
  });

  it("fires the auth profile failure hook so callers can self-heal", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      const hook = vi.fn();
      setAuthProfileFailureHook(hook);
      try {
        await markAuthProfileFailure({
          store,
          profileId: "anthropic:default",
          reason: "auth",
          agentDir,
        });
        expect(hook).toHaveBeenCalledTimes(1);
      } finally {
        setAuthProfileFailureHook(undefined);
      }
    });
  });

  it("does not break failure recording when the hook throws", async () => {
    await withAuthProfileStore(async ({ agentDir, store }) => {
      const throwingHook = vi.fn(() => {
        throw new Error("boom");
      });
      setAuthProfileFailureHook(throwingHook);
      try {
        await markAuthProfileFailure({
          store,
          profileId: "anthropic:default",
          reason: "auth",
          agentDir,
        });
        expect(throwingHook).toHaveBeenCalledTimes(1);
        // Failure still got recorded despite the hook throwing.
        expect(store.usageStats?.["anthropic:default"]?.errorCount ?? 0).toBeGreaterThan(0);
      } finally {
        setAuthProfileFailureHook(undefined);
      }
    });
  });
});

describe("calculateAuthProfileCooldownMs", () => {
  it("applies stepped backoff with a 5-min cap", () => {
    expect(calculateAuthProfileCooldownMs(1)).toBe(30_000); // 30 seconds
    expect(calculateAuthProfileCooldownMs(2)).toBe(60_000); // 1 minute
    expect(calculateAuthProfileCooldownMs(3)).toBe(5 * 60_000); // 5 minutes
    expect(calculateAuthProfileCooldownMs(4)).toBe(5 * 60_000); // 5 minutes (cap)
    expect(calculateAuthProfileCooldownMs(5)).toBe(5 * 60_000); // 5 minutes (cap)
  });
});
