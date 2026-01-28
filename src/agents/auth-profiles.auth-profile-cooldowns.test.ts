import { describe, expect, it } from "vitest";
import {
  calculateAuthProfileCooldownMs,
  cooldownKey,
  isProfileInCooldown,
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
