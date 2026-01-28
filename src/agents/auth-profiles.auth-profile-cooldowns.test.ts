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
  markAuthProfileCooldown,
  markAuthProfileFailure,
  markAuthProfileUsed,
  saveAuthProfileStore,
} from "./auth-profiles.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";

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
  it("returns profileId when model is not provided", () => {
    expect(cooldownKey("openai:default")).toBe("openai:default");
    expect(cooldownKey("openai:default", undefined)).toBe("openai:default");
  });

  it("returns composite key when model is provided", () => {
    expect(cooldownKey("openai:default", "gpt-4")).toBe("openai:default:gpt-4");
    expect(cooldownKey("github-copilot:default", "gpt-5.2")).toBe("github-copilot:default:gpt-5.2");
  });
});

describe("isProfileInCooldown with per-model support", () => {
  it("returns false when no cooldown exists", () => {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test" },
      },
    };
    expect(isProfileInCooldown(store, "openai:default")).toBe(false);
    expect(isProfileInCooldown(store, "openai:default", "gpt-4")).toBe(false);
  });

  it("checks profile-level cooldown when model not provided", () => {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test" },
      },
      usageStats: {
        "openai:default": { cooldownUntil: Date.now() + 60_000 },
      },
    };
    expect(isProfileInCooldown(store, "openai:default")).toBe(true);
  });

  it("checks per-model cooldown when model is provided", () => {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test" },
      },
      usageStats: {
        "openai:default:gpt-4": { cooldownUntil: Date.now() + 60_000 },
      },
    };
    // model-specific cooldown exists
    expect(isProfileInCooldown(store, "openai:default", "gpt-4")).toBe(true);
    // different model is not in cooldown
    expect(isProfileInCooldown(store, "openai:default", "gpt-3.5")).toBe(false);
    // profile-level is not in cooldown
    expect(isProfileInCooldown(store, "openai:default")).toBe(false);
  });

  it("allows independent cooldowns per model", () => {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "github-copilot:default": {
          type: "api_key",
          provider: "github-copilot",
          key: "test",
        },
      },
      usageStats: {
        // gpt-5.2 is in cooldown (rate limited)
        "github-copilot:default:gpt-5.2": { cooldownUntil: Date.now() + 60_000 },
        // gpt-5-mini has no cooldown (unlimited quota)
      },
    };
    expect(isProfileInCooldown(store, "github-copilot:default", "gpt-5.2")).toBe(true);
    expect(isProfileInCooldown(store, "github-copilot:default", "gpt-5-mini")).toBe(false);
  });

  it("returns false when cooldown has expired", () => {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test" },
      },
      usageStats: {
        "openai:default:gpt-4": { cooldownUntil: Date.now() - 1000 }, // expired
      },
    };
    expect(isProfileInCooldown(store, "openai:default", "gpt-4")).toBe(false);
  });
});

describe("markAuthProfileUsed with per-model support", () => {
  it("clears per-model cooldown when model is provided", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-auth-"));
    const cooldownTime = Date.now() + 60_000;
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test" },
      },
      usageStats: {
        "openai:default": { cooldownUntil: cooldownTime },
        "openai:default:gpt-4": { cooldownUntil: cooldownTime, errorCount: 3 },
        "openai:default:gpt-3.5": { cooldownUntil: cooldownTime },
      },
    };
    saveAuthProfileStore(store, tempDir);

    try {
      // Mark gpt-4 as used (successful)
      await markAuthProfileUsed({
        store,
        profileId: "openai:default",
        model: "gpt-4",
        agentDir: tempDir,
      });

      // Profile-level cooldown should be cleared
      expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBeUndefined();
      // Per-model cooldown for gpt-4 should be cleared
      expect(store.usageStats?.["openai:default:gpt-4"]?.cooldownUntil).toBeUndefined();
      expect(store.usageStats?.["openai:default:gpt-4"]?.errorCount).toBe(0);
      // Per-model cooldown for gpt-3.5 should remain (different model)
      expect(store.usageStats?.["openai:default:gpt-3.5"]?.cooldownUntil).toBe(cooldownTime);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("only clears profile-level cooldown when model is not provided", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-auth-"));
    const cooldownTime = Date.now() + 60_000;
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test" },
      },
      usageStats: {
        "openai:default": { cooldownUntil: cooldownTime },
        "openai:default:gpt-4": { cooldownUntil: cooldownTime },
      },
    };
    saveAuthProfileStore(store, tempDir);

    try {
      // Mark profile as used without specifying model
      await markAuthProfileUsed({ store, profileId: "openai:default", agentDir: tempDir });

      // Profile-level cooldown should be cleared
      expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBeUndefined();
      // Per-model cooldown should remain (no model specified)
      expect(store.usageStats?.["openai:default:gpt-4"]?.cooldownUntil).toBe(cooldownTime);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("cooldownKey edge cases", () => {
  it("treats empty string model the same as undefined", () => {
    // Empty string should be treated as "no model" to avoid trailing colon
    expect(cooldownKey("openai:default", "")).toBe("openai:default");
    expect(cooldownKey("openai:default", "   ")).toBe("openai:default");
  });
});

describe("isProfileInCooldown backward compatibility", () => {
  it("returns true for any model when profile-level cooldown exists", () => {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test" },
      },
      usageStats: {
        "openai:default": { cooldownUntil: Date.now() + 60_000 }, // profile-level only
      },
    };
    // Any model should be blocked when profile-level cooldown exists
    expect(isProfileInCooldown(store, "openai:default", "gpt-4")).toBe(true);
    expect(isProfileInCooldown(store, "openai:default", "gpt-3.5")).toBe(true);
    expect(isProfileInCooldown(store, "openai:default", "o1-preview")).toBe(true);
    // Profile-level check also works
    expect(isProfileInCooldown(store, "openai:default")).toBe(true);
  });

  it("checks disabledUntil for per-model cooldowns (billing failures)", () => {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test" },
      },
      usageStats: {
        "openai:default:gpt-4": { disabledUntil: Date.now() + 60_000 }, // billing failure
      },
    };
    expect(isProfileInCooldown(store, "openai:default", "gpt-4")).toBe(true);
    expect(isProfileInCooldown(store, "openai:default", "gpt-3.5")).toBe(false);
  });
});

describe("markAuthProfileFailure with per-model support", () => {
  it("tracks failure per model when model is provided", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-auth-"));
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test" },
      },
    };
    saveAuthProfileStore(store, tempDir);

    try {
      await markAuthProfileFailure({
        store,
        profileId: "openai:default",
        model: "gpt-4",
        reason: "rate_limit",
        agentDir: tempDir,
      });

      // Per-model key should have cooldown
      expect(store.usageStats?.["openai:default:gpt-4"]?.cooldownUntil).toBeGreaterThan(Date.now());
      expect(store.usageStats?.["openai:default:gpt-4"]?.errorCount).toBe(1);
      // Profile-level should NOT have cooldown (only model-specific)
      expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBeUndefined();
      // Other models should not be affected
      expect(store.usageStats?.["openai:default:gpt-3.5"]).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("tracks failure at profile level when model is not provided", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-auth-"));
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test" },
      },
    };
    saveAuthProfileStore(store, tempDir);

    try {
      await markAuthProfileFailure({
        store,
        profileId: "openai:default",
        reason: "auth",
        agentDir: tempDir,
      });

      // Profile-level key should have cooldown
      expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBeGreaterThan(Date.now());
      expect(store.usageStats?.["openai:default"]?.errorCount).toBe(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("tracks billing failures with disabledUntil per model", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-auth-"));
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test" },
      },
    };
    saveAuthProfileStore(store, tempDir);

    try {
      await markAuthProfileFailure({
        store,
        profileId: "openai:default",
        model: "gpt-4",
        reason: "billing",
        agentDir: tempDir,
      });

      // Billing failures use disabledUntil instead of cooldownUntil
      expect(store.usageStats?.["openai:default:gpt-4"]?.disabledUntil).toBeGreaterThan(Date.now());
      expect(store.usageStats?.["openai:default:gpt-4"]?.disabledReason).toBe("billing");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("markAuthProfileCooldown with per-model support", () => {
  it("marks cooldown per model when model is provided", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-auth-"));
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test" },
      },
    };
    saveAuthProfileStore(store, tempDir);

    try {
      await markAuthProfileCooldown({
        store,
        profileId: "openai:default",
        model: "gpt-4",
        agentDir: tempDir,
      });

      // Per-model key should have cooldown
      expect(store.usageStats?.["openai:default:gpt-4"]?.cooldownUntil).toBeGreaterThan(Date.now());
      // Profile-level should NOT have cooldown
      expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("clearAuthProfileCooldown with per-model support", () => {
  it("clears per-model cooldown when model is provided", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-auth-"));
    const cooldownTime = Date.now() + 60_000;
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test" },
      },
      usageStats: {
        "openai:default": { cooldownUntil: cooldownTime },
        "openai:default:gpt-4": { cooldownUntil: cooldownTime, errorCount: 3 },
        "openai:default:gpt-3.5": { cooldownUntil: cooldownTime },
      },
    };
    saveAuthProfileStore(store, tempDir);

    try {
      await clearAuthProfileCooldown({
        store,
        profileId: "openai:default",
        model: "gpt-4",
        agentDir: tempDir,
      });

      // Per-model cooldown for gpt-4 should be cleared
      expect(store.usageStats?.["openai:default:gpt-4"]?.cooldownUntil).toBeUndefined();
      expect(store.usageStats?.["openai:default:gpt-4"]?.errorCount).toBe(0);
      // Profile-level cooldown should remain (different key)
      expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBe(cooldownTime);
      // Other model cooldown should remain
      expect(store.usageStats?.["openai:default:gpt-3.5"]?.cooldownUntil).toBe(cooldownTime);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("clears profile-level cooldown when model is not provided", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-auth-"));
    const cooldownTime = Date.now() + 60_000;
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:default": { type: "api_key", provider: "openai", key: "test" },
      },
      usageStats: {
        "openai:default": { cooldownUntil: cooldownTime, errorCount: 2 },
        "openai:default:gpt-4": { cooldownUntil: cooldownTime },
      },
    };
    saveAuthProfileStore(store, tempDir);

    try {
      await clearAuthProfileCooldown({
        store,
        profileId: "openai:default",
        agentDir: tempDir,
      });

      // Profile-level cooldown should be cleared
      expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBeUndefined();
      expect(store.usageStats?.["openai:default"]?.errorCount).toBe(0);
      // Per-model cooldown should remain (different key)
      expect(store.usageStats?.["openai:default:gpt-4"]?.cooldownUntil).toBe(cooldownTime);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
