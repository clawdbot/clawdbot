import { describe, expect, it } from "vitest";
import {
  isLiveProfileKeyModeEnabled,
  isLiveTestEnabled,
  requiresLiveProfileCredential,
  resolveLiveCredentialPrecedence,
} from "./live-test-helpers.js";

describe("isLiveTestEnabled", () => {
  it("treats LIVE and OPENCLAW_LIVE_TEST as shared live gates", () => {
    expect(isLiveTestEnabled([], { LIVE: "1" })).toBe(true);
    expect(isLiveTestEnabled([], { OPENCLAW_LIVE_TEST: "1" })).toBe(true);
    expect(isLiveTestEnabled([], {})).toBe(false);
  });

  it("supports provider-specific live flags", () => {
    expect(isLiveTestEnabled(["MINIMAX_LIVE_TEST"], { MINIMAX_LIVE_TEST: "1" })).toBe(true);
    expect(isLiveTestEnabled(["MINIMAX_LIVE_TEST"], { MINIMAX_LIVE_TEST: "0" })).toBe(false);
  });
});

describe("isLiveProfileKeyModeEnabled", () => {
  it("only enables profile-key mode for the dedicated flag", () => {
    expect(isLiveProfileKeyModeEnabled({ OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS: "1" })).toBe(true);
    expect(isLiveProfileKeyModeEnabled({ OPENCLAW_LIVE_TEST: "1" })).toBe(false);
    expect(isLiveProfileKeyModeEnabled({ LIVE: "1" })).toBe(false);
  });
});

describe("live credential precedence", () => {
  it("uses profile-first auth for Codex even when the global live mode is env-first", () => {
    expect(resolveLiveCredentialPrecedence("openai-codex", false)).toBe("profile-first");
    expect(requiresLiveProfileCredential("openai-codex", false)).toBe(true);
  });

  it("keeps env-first auth for normal providers unless profile keys are required", () => {
    expect(resolveLiveCredentialPrecedence("openai", false)).toBe("env-first");
    expect(resolveLiveCredentialPrecedence("openai", true)).toBe("profile-first");
    expect(requiresLiveProfileCredential("openai", false)).toBe(false);
    expect(requiresLiveProfileCredential("openai", true)).toBe(true);
  });
});
