import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  canRunBufferBackedImageToVideoLiveLane,
  canRunBufferBackedVideoToVideoLiveLane,
  parseCsvFilter,
  parseProviderModelMap,
  redactLiveApiKey,
  resolveConfiguredLiveVideoModels,
  resolveLiveVideoAuthStore,
} from "./live-test-helpers.js";

describe("video-generation live-test helpers", () => {
  it("parses provider filters and treats empty/all as unfiltered", () => {
    expect(parseCsvFilter()).toBeNull();
    expect(parseCsvFilter("all")).toBeNull();
    expect(parseCsvFilter(" google , openai ")).toEqual(new Set(["google", "openai"]));
  });

  it("parses provider model overrides by provider id", () => {
    expect(
      parseProviderModelMap("google/veo-3.1-fast-generate-preview, openai/sora-2, invalid"),
    ).toEqual(
      new Map([
        ["google", "google/veo-3.1-fast-generate-preview"],
        ["openai", "openai/sora-2"],
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
    } as OpenClawConfig;

    expect(resolveConfiguredLiveVideoModels(cfg)).toEqual(
      new Map([
        ["google", "google/veo-3.1-fast-generate-preview"],
        ["openai", "openai/sora-2"],
      ]),
    );
  });

  it("uses an empty auth store when live env keys should override stale profiles", () => {
    expect(
      resolveLiveVideoAuthStore({
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
      resolveLiveVideoAuthStore({
        requireProfileKeys: true,
        hasLiveKeys: true,
      }),
    ).toBeUndefined();
    expect(
      resolveLiveVideoAuthStore({
        requireProfileKeys: false,
        hasLiveKeys: false,
      }),
    ).toBeUndefined();
  });

  it("redacts live API keys for diagnostics", () => {
    expect(redactLiveApiKey(undefined)).toBe("none");
    expect(redactLiveApiKey("short-key")).toBe("short-key");
    expect(redactLiveApiKey("sk-proj-1234567890")).toBe("sk-proj-...7890");
  });

  it("runs buffer-backed video-to-video only for supported providers/models", () => {
    expect(
      canRunBufferBackedVideoToVideoLiveLane({
        providerId: "google",
        modelRef: "google/veo-3.1-fast-generate-preview",
      }),
    ).toBe(false);
    expect(
      canRunBufferBackedVideoToVideoLiveLane({
        providerId: "openai",
        modelRef: "openai/sora-2",
      }),
    ).toBe(false);
    expect(
      canRunBufferBackedVideoToVideoLiveLane({
        providerId: "runway",
        modelRef: "runway/gen4_aleph",
      }),
    ).toBe(true);
    expect(
      canRunBufferBackedVideoToVideoLiveLane({
        providerId: "runway",
        modelRef: "runway/gen4.5",
      }),
    ).toBe(false);
    expect(
      canRunBufferBackedVideoToVideoLiveLane({
        providerId: "alibaba",
        modelRef: "alibaba/wan2.6-r2v",
      }),
    ).toBe(false);
    expect(
      canRunBufferBackedVideoToVideoLiveLane({
        providerId: "qwen",
        modelRef: "qwen/wan2.6-r2v",
      }),
    ).toBe(false);
    expect(
      canRunBufferBackedVideoToVideoLiveLane({
        providerId: "xai",
        modelRef: "xai/grok-imagine-video",
      }),
    ).toBe(false);
  });

  it("runs buffer-backed image-to-video only for providers that accept bundled image inputs", () => {
    expect(
      canRunBufferBackedImageToVideoLiveLane({
        providerId: "openai",
        modelRef: "openai/sora-2",
      }),
    ).toBe(true);
    expect(
      canRunBufferBackedImageToVideoLiveLane({
        providerId: "vydra",
        modelRef: "vydra/veo3",
      }),
    ).toBe(false);
  });
});
