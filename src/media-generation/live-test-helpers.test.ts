// Tests for media-generation live test helpers.
import { describe, expect, it } from "vitest";
import {
  parseLiveCsvFilter,
  parseProviderModelMap,
  redactLiveApiKey,
  resolveConfiguredLiveProviderModels,
  resolveLiveAuthStore,
} from "./live-test-helpers.js";

describe("media-generation live-test helpers", () => {
  it("parses provider filters and treats empty/all as unfiltered", () => {
    expect(parseLiveCsvFilter()).toBeNull();
    expect(parseLiveCsvFilter("all")).toBeNull();
    expect(parseLiveCsvFilter(" openai , google ")).toEqual(new Set(["openai", "google"]));
  });

  it("parses provider model overrides by provider id", () => {
    expect(
      parseProviderModelMap("openai/gpt-image-2, google/gemini-3.1-flash-image-preview, invalid"),
    ).toEqual(
      new Map([
        ["openai", "openai/gpt-image-2"],
        ["google", "google/gemini-3.1-flash-image-preview"],
      ]),
    );
  });

  it("collects configured models from primary and fallbacks", () => {
    const cfg = {
      agents: {
        defaults: {
          videoGenerationModel: {
            primary: "google/veo-3.1-fast-generate-preview",
            fallbacks: ["openai/sora-2", "invalid"],
          },
        },
      },
    };

    expect(resolveConfiguredLiveProviderModels(cfg.agents!.defaults!.videoGenerationModel)).toEqual(
      new Map([
        ["google", "google/veo-3.1-fast-generate-preview"],
        ["openai", "openai/sora-2"],
      ]),
    );
  });

  it("uses an empty auth store when live env keys should override stale profiles", () => {
    expect(
      resolveLiveAuthStore({
        requireProfileKeys: false,
        hasLiveKeys: true,
      }),
    ).toEqual({
      version: 1,
      profiles: {},
    });
  });

  it("keeps profile-store mode when requested or when no live keys exist", () => {
    expect(
      resolveLiveAuthStore({
        requireProfileKeys: true,
        hasLiveKeys: true,
      }),
    ).toBeUndefined();
    expect(
      resolveLiveAuthStore({
        requireProfileKeys: false,
        hasLiveKeys: false,
      }),
    ).toBeUndefined();
  });

  it("redacts live API keys for diagnostics", () => {
    expect(redactLiveApiKey(undefined)).toBe("none");
    expect(redactLiveApiKey("   ")).toBe("none");
    expect(redactLiveApiKey("short-key")).toBe("<redacted>");
    expect(redactLiveApiKey("sk-proj-1234567890")).toBe("<redacted>");
  });

  it("handles keys with UTF-16 surrogate pairs by fully redacting", () => {
    // 😀 (U+1F600) is a surrogate pair at code-unit positions 7-8.
    // Full redaction means the credential never reaches the output, so
    // surrogate pairs in the key value are inherently safe.
    const key = "abcdefg😀hijklmnop";
    const result = redactLiveApiKey(key);
    expect(result).toBe("<redacted>");
    expect(result).not.toMatch(/[\uD800-\uDBFF]/u);
    expect(result).not.toMatch(/[\uDC00-\uDFFF]/u);
  });
});
