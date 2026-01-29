/*
 * Per-Model Cooldown Tests
 * ────────────────────────
 * These tests verify the per-model cooldown feature (discussion #3417).
 *
 * Key design asymmetry:
 * - Failures CREATE per-model keys (e.g., "openai:default:gpt-4")
 * - Successes UPDATE profile-level keys AND clear per-model keys (if they exist)
 * - Per-model keys are ephemeral "penalty boxes" that only exist during cooldowns
 *
 * This allows independent rate limits per model while keeping the store clean.
 * See: src/agents/auth-profiles/usage.ts for implementation details.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  calculateAuthProfileCooldownMs,
  clearAuthProfileCooldown,
  cooldownKey,
  isProfileInCooldown,
  markAuthProfileFailure,
  markAuthProfileUsed,
  saveAuthProfileStore,
} from "./auth-profiles.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";

// Test helpers
const makeStore = (usageStats?: AuthProfileStore["usageStats"]): AuthProfileStore => ({
  version: AUTH_STORE_VERSION,
  profiles: {
    "openai:default": { type: "api_key", provider: "openai", key: "test" },
  },
  ...(usageStats && { usageStats }),
});

async function withTempDir<T>(fn: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-auth-"));
  try {
    return await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

describe("auth profile cooldowns", () => {
  it("applies exponential backoff with a 1h cap", () => {
    expect(calculateAuthProfileCooldownMs(1)).toBe(60_000);
    expect(calculateAuthProfileCooldownMs(2)).toBe(5 * 60_000);
    expect(calculateAuthProfileCooldownMs(3)).toBe(25 * 60_000);
    expect(calculateAuthProfileCooldownMs(4)).toBe(60 * 60_000);
    expect(calculateAuthProfileCooldownMs(5)).toBe(60 * 60_000);
  });
});

describe("cooldownKey", () => {
  it("returns profileId when model is not provided or empty", () => {
    expect(cooldownKey("openai:default")).toBe("openai:default");
    expect(cooldownKey("openai:default", undefined)).toBe("openai:default");
    expect(cooldownKey("openai:default", "")).toBe("openai:default");
    expect(cooldownKey("openai:default", "   ")).toBe("openai:default");
  });

  it("returns composite key when model is provided", () => {
    expect(cooldownKey("openai:default", "gpt-4")).toBe("openai:default:gpt-4");
    expect(cooldownKey("github-copilot:default", "gpt-5.2")).toBe("github-copilot:default:gpt-5.2");
  });
});

describe("isProfileInCooldown with per-model support", () => {
  it("returns false when no cooldown exists", () => {
    const store = makeStore();
    expect(isProfileInCooldown(store, "openai:default")).toBe(false);
    expect(isProfileInCooldown(store, "openai:default", "gpt-4")).toBe(false);
  });

  it("checks profile-level cooldown when model not provided", () => {
    const store = makeStore({ "openai:default": { cooldownUntil: Date.now() + 60_000 } });
    expect(isProfileInCooldown(store, "openai:default")).toBe(true);
  });

  it("checks per-model cooldown when model is provided", () => {
    const store = makeStore({ "openai:default:gpt-4": { cooldownUntil: Date.now() + 60_000 } });
    expect(isProfileInCooldown(store, "openai:default", "gpt-4")).toBe(true);
    expect(isProfileInCooldown(store, "openai:default", "gpt-3.5")).toBe(false);
    expect(isProfileInCooldown(store, "openai:default")).toBe(false);
  });

  it("allows independent cooldowns per model", () => {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "github-copilot:default": { type: "api_key", provider: "github-copilot", key: "test" },
      },
      usageStats: { "github-copilot:default:gpt-5.2": { cooldownUntil: Date.now() + 60_000 } },
    };
    expect(isProfileInCooldown(store, "github-copilot:default", "gpt-5.2")).toBe(true);
    expect(isProfileInCooldown(store, "github-copilot:default", "gpt-5-mini")).toBe(false);
  });

  it("returns false when cooldown has expired", () => {
    const store = makeStore({ "openai:default:gpt-4": { cooldownUntil: Date.now() - 1000 } });
    expect(isProfileInCooldown(store, "openai:default", "gpt-4")).toBe(false);
  });
});

describe("markAuthProfileUsed with per-model support", () => {
  it("clears per-model cooldown when model is provided", async () => {
    await withTempDir(async (tempDir) => {
      const cooldownTime = Date.now() + 60_000;
      const store = makeStore({
        "openai:default": { cooldownUntil: cooldownTime },
        "openai:default:gpt-4": { cooldownUntil: cooldownTime, errorCount: 3 },
        "openai:default:gpt-3.5": { cooldownUntil: cooldownTime },
      });
      saveAuthProfileStore(store, tempDir);

      await markAuthProfileUsed({
        store,
        profileId: "openai:default",
        model: "gpt-4",
        agentDir: tempDir,
      });

      expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBeUndefined();
      expect(store.usageStats?.["openai:default:gpt-4"]?.cooldownUntil).toBeUndefined();
      expect(store.usageStats?.["openai:default:gpt-4"]?.errorCount).toBe(0);
      expect(store.usageStats?.["openai:default:gpt-3.5"]?.cooldownUntil).toBe(cooldownTime);
    });
  });

  it("only clears profile-level cooldown when model is not provided", async () => {
    await withTempDir(async (tempDir) => {
      const cooldownTime = Date.now() + 60_000;
      const store = makeStore({
        "openai:default": { cooldownUntil: cooldownTime },
        "openai:default:gpt-4": { cooldownUntil: cooldownTime },
      });
      saveAuthProfileStore(store, tempDir);

      await markAuthProfileUsed({ store, profileId: "openai:default", agentDir: tempDir });

      expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBeUndefined();
      expect(store.usageStats?.["openai:default:gpt-4"]?.cooldownUntil).toBe(cooldownTime);
    });
  });
});

describe("isProfileInCooldown backward compatibility", () => {
  it("returns true for any model when profile-level cooldown exists", () => {
    const store = makeStore({ "openai:default": { cooldownUntil: Date.now() + 60_000 } });
    expect(isProfileInCooldown(store, "openai:default", "gpt-4")).toBe(true);
    expect(isProfileInCooldown(store, "openai:default", "gpt-3.5")).toBe(true);
    expect(isProfileInCooldown(store, "openai:default", "o1-preview")).toBe(true);
    expect(isProfileInCooldown(store, "openai:default")).toBe(true);
  });

  it("checks disabledUntil for per-model cooldowns (billing failures)", () => {
    const store = makeStore({ "openai:default:gpt-4": { disabledUntil: Date.now() + 60_000 } });
    expect(isProfileInCooldown(store, "openai:default", "gpt-4")).toBe(true);
    expect(isProfileInCooldown(store, "openai:default", "gpt-3.5")).toBe(false);
  });
});

describe("markAuthProfileFailure with per-model support", () => {
  it("tracks failure per model when model is provided", async () => {
    await withTempDir(async (tempDir) => {
      const store = makeStore();
      saveAuthProfileStore(store, tempDir);

      await markAuthProfileFailure({
        store,
        profileId: "openai:default",
        model: "gpt-4",
        reason: "rate_limit",
        agentDir: tempDir,
      });

      expect(store.usageStats?.["openai:default:gpt-4"]?.cooldownUntil).toBeGreaterThan(Date.now());
      expect(store.usageStats?.["openai:default:gpt-4"]?.errorCount).toBe(1);
      expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBeUndefined();
      expect(store.usageStats?.["openai:default:gpt-3.5"]).toBeUndefined();
    });
  });

  it("tracks failure at profile level when model is not provided", async () => {
    await withTempDir(async (tempDir) => {
      const store = makeStore();
      saveAuthProfileStore(store, tempDir);

      await markAuthProfileFailure({
        store,
        profileId: "openai:default",
        reason: "auth",
        agentDir: tempDir,
      });

      expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBeGreaterThan(Date.now());
      expect(store.usageStats?.["openai:default"]?.errorCount).toBe(1);
    });
  });

  it("tracks billing failures with disabledUntil per model", async () => {
    await withTempDir(async (tempDir) => {
      const store = makeStore();
      saveAuthProfileStore(store, tempDir);

      await markAuthProfileFailure({
        store,
        profileId: "openai:default",
        model: "gpt-4",
        reason: "billing",
        agentDir: tempDir,
      });

      expect(store.usageStats?.["openai:default:gpt-4"]?.disabledUntil).toBeGreaterThan(Date.now());
      expect(store.usageStats?.["openai:default:gpt-4"]?.disabledReason).toBe("billing");
    });
  });
});

describe("clearAuthProfileCooldown with per-model support", () => {
  it("clears per-model cooldown when model is provided", async () => {
    await withTempDir(async (tempDir) => {
      const cooldownTime = Date.now() + 60_000;
      const store = makeStore({
        "openai:default": { cooldownUntil: cooldownTime },
        "openai:default:gpt-4": { cooldownUntil: cooldownTime, errorCount: 3 },
        "openai:default:gpt-3.5": { cooldownUntil: cooldownTime },
      });
      saveAuthProfileStore(store, tempDir);

      await clearAuthProfileCooldown({
        store,
        profileId: "openai:default",
        model: "gpt-4",
        agentDir: tempDir,
      });

      expect(store.usageStats?.["openai:default:gpt-4"]?.cooldownUntil).toBeUndefined();
      expect(store.usageStats?.["openai:default:gpt-4"]?.errorCount).toBe(0);
      expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBe(cooldownTime);
      expect(store.usageStats?.["openai:default:gpt-3.5"]?.cooldownUntil).toBe(cooldownTime);
    });
  });

  it("clears profile-level cooldown when model is not provided", async () => {
    await withTempDir(async (tempDir) => {
      const cooldownTime = Date.now() + 60_000;
      const store = makeStore({
        "openai:default": { cooldownUntil: cooldownTime, errorCount: 2 },
        "openai:default:gpt-4": { cooldownUntil: cooldownTime },
      });
      saveAuthProfileStore(store, tempDir);

      await clearAuthProfileCooldown({ store, profileId: "openai:default", agentDir: tempDir });

      expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBeUndefined();
      expect(store.usageStats?.["openai:default"]?.errorCount).toBe(0);
      expect(store.usageStats?.["openai:default:gpt-4"]?.cooldownUntil).toBe(cooldownTime);
    });
  });
});
