/** Tests live image-generation helper parsing and provider selection. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  parseCaseFilter,
  parseImageProviderFilter,
  resolveConfiguredLiveImageModels,
  resolveLiveImageAuthStore,
} from "./live-test-helpers.js";

describe("image-generation live-test helpers", () => {
  it("parses provider filters and treats empty/all as unfiltered", () => {
    expect(parseImageProviderFilter()).toBeNull();
    expect(parseImageProviderFilter("all")).toBeNull();
    expect(parseImageProviderFilter(" openai , google ")).toEqual(new Set(["openai", "google"]));
  });

  it("parses live case filters and treats empty/all as unfiltered", () => {
    expect(parseCaseFilter()).toBeNull();
    expect(parseCaseFilter("all")).toBeNull();
    expect(parseCaseFilter(" google:flash , openai:default ")).toEqual(
      new Set(["google:flash", "openai:default"]),
    );
  });

  it("collects configured models from primary and fallbacks", () => {
    const cfg = {
      agents: {
        defaults: {
          mediaModels: {
            image: {
              primary: "openai/gpt-image-2",
              fallbacks: ["google/gemini-3.1-flash-image-preview", "invalid"],
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveConfiguredLiveImageModels(cfg)).toEqual(
      new Map([
        ["openai", "openai/gpt-image-2"],
        ["google", "google/gemini-3.1-flash-image-preview"],
      ]),
    );
  });

  it("uses an empty auth store when live env keys should override stale profiles", () => {
    expect(
      resolveLiveImageAuthStore({
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
      resolveLiveImageAuthStore({
        requireProfileKeys: true,
        hasLiveKeys: true,
      }),
    ).toBeUndefined();
    expect(
      resolveLiveImageAuthStore({
        requireProfileKeys: false,
        hasLiveKeys: false,
      }),
    ).toBeUndefined();
  });
});
