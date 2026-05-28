import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  PIXVERSE_BASE_URL_BY_REGION,
  PIXVERSE_DEFAULT_VIDEO_MODEL_REF,
  PIXVERSE_PROVIDER_ID,
} from "./constants.js";
import plugin from "./index.js";
import { applyPixVerseConfig, applyPixVerseProviderConfig } from "./onboard.js";

function registerPixVerseProvider() {
  const captured = capturePluginRegistration(plugin);
  expect(captured.videoGenerationProviders.map((provider) => provider.id)).toEqual([
    PIXVERSE_PROVIDER_ID,
  ]);
  const provider = captured.providers[0];
  if (!provider) {
    throw new Error("expected PixVerse setup provider");
  }
  expect(provider.id).toBe(PIXVERSE_PROVIDER_ID);
  return provider;
}

function createRuntimeContext(region: "international" | "cn") {
  const select = vi.fn(async (params: { message: string }) => {
    expect(params.message).toBe("Select PixVerse API region");
    return region;
  });
  const ctx = {
    config: {
      models: {
        providers: {
          pixverse: {
            baseUrl: "https://proxy.example/openapi/v2",
            models: [],
            params: { quality: "720p" },
          },
        },
      },
    },
    env: {},
    prompter: {
      intro: vi.fn(),
      outro: vi.fn(),
      note: vi.fn(),
      select,
      multiselect: vi.fn(),
      text: vi.fn(async () => "pixverse-test-key"),
      confirm: vi.fn(),
      progress: vi.fn(() => ({
        update: vi.fn(),
        stop: vi.fn(),
      })),
    },
    runtime: {
      error: vi.fn(),
      exit: vi.fn(),
      log: vi.fn(),
    },
    secretInputMode: "plaintext",
    isRemote: false,
    openUrl: vi.fn(),
    oauth: {
      createVpsAwareHandlers: vi.fn(),
    },
  } as never;
  return { ctx, select };
}

describe("pixverse plugin", () => {
  it("registers provider auth for the setup wizard", () => {
    const provider = registerPixVerseProvider();
    const auth = provider?.auth?.[0];

    expect(provider).toMatchObject({
      id: PIXVERSE_PROVIDER_ID,
      label: "PixVerse",
      docsPath: "/providers/pixverse",
      envVars: ["PIXVERSE_API_KEY"],
    });
    expect(auth).toMatchObject({
      id: "api-key",
      label: "PixVerse API key",
      kind: "api_key",
      wizard: {
        choiceId: "pixverse-api-key",
        choiceLabel: "PixVerse API key",
        choiceHint: "Prompts for International or CN endpoint",
        groupId: "pixverse",
        groupLabel: "PixVerse",
        groupHint: "Video generation",
        onboardingScopes: ["image-generation"],
      },
    });
  });

  it("prompts for the PixVerse region and writes provider config", async () => {
    const provider = registerPixVerseProvider();
    const auth = provider?.auth?.[0];
    if (!auth) {
      throw new Error("expected PixVerse auth method");
    }

    const { ctx, select } = createRuntimeContext("cn");
    const result = await auth.run(ctx);
    const regionSelect = select.mock.calls[0]?.[0];

    expect(regionSelect).toEqual({
      message: "Select PixVerse API region",
      initialValue: "international",
      options: [
        {
          value: "international",
          label: "International",
          hint: PIXVERSE_BASE_URL_BY_REGION.international,
        },
        {
          value: "cn",
          label: "CN",
          hint: PIXVERSE_BASE_URL_BY_REGION.cn,
        },
      ],
    });
    expect(result.profiles).toEqual([
      {
        profileId: "pixverse:default",
        credential: {
          type: "api_key",
          provider: PIXVERSE_PROVIDER_ID,
          key: "pixverse-test-key",
        },
      },
    ]);
    expect(result.configPatch?.models?.providers?.pixverse).toEqual({
      baseUrl: PIXVERSE_BASE_URL_BY_REGION.cn,
      models: [],
      params: { quality: "720p" },
      region: "cn",
    });
    expect(result.defaultModel).toBeUndefined();
    expect(result.configPatch?.agents?.defaults?.videoGenerationModel).toEqual({
      primary: PIXVERSE_DEFAULT_VIDEO_MODEL_REF,
    });
    expect(result.notes).toEqual([`PixVerse endpoint: CN (${PIXVERSE_BASE_URL_BY_REGION.cn})`]);
  });

  it("only resets custom baseUrl when a region is explicitly selected", () => {
    const config = {
      models: {
        providers: {
          pixverse: {
            baseUrl: "https://proxy.example/openapi/v2",
            models: [],
            params: { quality: "720p" },
          },
        },
      },
    };

    expect(
      applyPixVerseProviderConfig(config, "international").models?.providers?.pixverse,
    ).toEqual({
      baseUrl: "https://proxy.example/openapi/v2",
      models: [],
      params: { quality: "720p" },
      region: "international",
    });
    expect(
      applyPixVerseProviderConfig(config, "cn", { resetBaseUrl: true }).models?.providers?.pixverse,
    ).toEqual({
      baseUrl: PIXVERSE_BASE_URL_BY_REGION.cn,
      models: [],
      params: { quality: "720p" },
      region: "cn",
    });
  });

  it("preserves an existing video generation default", () => {
    const result = applyPixVerseConfig(
      {
        agents: {
          defaults: {
            videoGenerationModel: {
              primary: "openai/sora-2",
            },
          },
        },
      },
      "international",
    );

    expect(result.agents?.defaults?.videoGenerationModel).toEqual({
      primary: "openai/sora-2",
    });
  });
});
