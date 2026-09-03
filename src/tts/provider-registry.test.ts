// TTS provider registry tests cover registration and provider resolution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import {
  createSpeechProviderRegistry,
  normalizeSpeechProviderId,
} from "./provider-registry-core.js";
import {
  isTtsProviderConfigured,
  resolvePreparedTtsProvider,
  resolveTtsProviderOrder,
} from "./tts-provider-resolution.js";
import { resolveTtsConfig } from "./tts-settings.js";

const mocks = vi.hoisted(() => ({
  canonicalizeSpeechProviderId: vi.fn((providerId: string | undefined) => {
    const normalized = providerId?.trim().toLowerCase();
    return normalized === "edge" ? "microsoft" : normalized || undefined;
  }),
  getSpeechProvider: vi.fn(),
  listSpeechProviders: vi.fn(),
}));

vi.mock("./provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider-registry.js")>()),
  canonicalizeSpeechProviderId: mocks.canonicalizeSpeechProviderId,
  getSpeechProvider: mocks.getSpeechProvider,
  listSpeechProviders: mocks.listSpeechProviders,
}));

function createSpeechProvider(id: string, aliases?: string[]): SpeechProviderPlugin {
  return {
    id,
    label: id,
    ...(aliases ? { aliases } : {}),
    isConfigured: () => true,
    synthesize: async () => ({
      audioBuffer: Buffer.from("audio"),
      outputFormat: "mp3",
      voiceCompatible: false,
      fileExtension: ".mp3",
    }),
  };
}

describe("speech provider registry", () => {
  const getProviderCalls: Array<{ providerId: string; cfg?: OpenClawConfig }> = [];
  const listProvidersCalls: Array<{ cfg?: OpenClawConfig }> = [];
  let providers: SpeechProviderPlugin[] = [];
  let directProvider: SpeechProviderPlugin | undefined;
  let registry: ReturnType<typeof createSpeechProviderRegistry>;

  beforeEach(() => {
    mocks.canonicalizeSpeechProviderId.mockClear();
    mocks.getSpeechProvider.mockReset();
    mocks.listSpeechProviders.mockReset();
    providers = [];
    directProvider = undefined;
    getProviderCalls.length = 0;
    listProvidersCalls.length = 0;
    registry = createSpeechProviderRegistry({
      getProvider: (providerId, cfg) => {
        getProviderCalls.push({ providerId, cfg });
        return directProvider;
      },
      listProviders: (cfg) => {
        listProvidersCalls.push({ cfg });
        return providers;
      },
    });
  });

  it("lists providers from the speech capability runtime", () => {
    const cfg = {} as OpenClawConfig;
    providers = [createSpeechProvider("demo-speech")];

    expect(registry.listSpeechProviders(cfg).map((provider) => provider.id)).toEqual([
      "demo-speech",
    ]);
    expect(listProvidersCalls).toEqual([{ cfg }]);
  });

  it("gets providers by normalized id through the capability runtime", () => {
    const cfg = {} as OpenClawConfig;
    directProvider = createSpeechProvider("microsoft", ["edge"]);

    expect(registry.getSpeechProvider(" MICROSOFT ", cfg)).toBe(directProvider);
    expect(getProviderCalls).toEqual([{ providerId: "microsoft", cfg }]);
  });

  it("canonicalizes aliases from listed providers when direct lookup misses", () => {
    providers = [createSpeechProvider("microsoft", ["edge"])];

    expect(normalizeSpeechProviderId("edge")).toBe("edge");
    expect(registry.canonicalizeSpeechProviderId("edge")).toBe("microsoft");
  });

  it("resolves deterministic fallback order and aliases from a supplied provider inventory", () => {
    const inventory = [
      { ...createSpeechProvider("openai", ["oai"]), autoSelectOrder: 5 },
      { ...createSpeechProvider("google"), autoSelectOrder: 1 },
      { ...createSpeechProvider("azure"), autoSelectOrder: 1 },
      { ...createSpeechProvider("elevenlabs"), autoSelectOrder: 3 },
    ];

    expect(
      resolveTtsProviderOrder(
        " OAI " as Parameters<typeof resolveTtsProviderOrder>[0],
        undefined,
        inventory,
      ),
    ).toEqual(["openai", "azure", "google", "elevenlabs"]);
  });

  it("selects the first configured provider entirely from prepared facts", () => {
    const openaiConfigured = vi.fn(() => false);
    const googleConfigured = vi.fn(() => true);
    const inventory = [
      { ...createSpeechProvider("openai"), autoSelectOrder: 1, isConfigured: openaiConfigured },
      { ...createSpeechProvider("google"), autoSelectOrder: 2, isConfigured: googleConfigured },
    ];

    expect(
      resolvePreparedTtsProvider({
        config: resolveTtsConfig({}),
        providers: inventory,
        configuredByProvider: new Map([
          ["openai", false],
          ["google", true],
        ]),
      }),
    ).toBe("google");
    expect(mocks.listSpeechProviders).not.toHaveBeenCalled();
    expect(openaiConfigured).not.toHaveBeenCalled();
    expect(googleConfigured).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "persisted aliases",
      preference: { provider: "oai", source: "prefs" } as const,
      inventory: [createSpeechProvider("openai", ["oai"])],
      expected: "openai",
    },
    {
      name: "configured providers",
      preference: { provider: "custom", source: "config" } as const,
      inventory: [],
      expected: "custom",
    },
  ])("preserves $name in prepared selection", ({ preference, inventory, expected }) => {
    expect(
      resolvePreparedTtsProvider({
        config: resolveTtsConfig({}),
        preference,
        providers: inventory,
        configuredByProvider: new Map(),
      }),
    ).toBe(expected);
  });

  it("keeps persona selection conditional on provider availability", () => {
    const availablePersonaProvider = createSpeechProvider("persona-provider");
    mocks.getSpeechProvider.mockReturnValueOnce(availablePersonaProvider);
    const config = resolveTtsConfig({});
    const preference = { provider: "persona-provider", source: "persona" } as const;

    expect(
      resolvePreparedTtsProvider({
        config,
        preference,
        providers: [],
        configuredByProvider: new Map(),
      }),
    ).toBe("persona-provider");
    expect(
      resolvePreparedTtsProvider({
        config,
        preference,
        providers: [createSpeechProvider("fallback")],
        configuredByProvider: new Map([["fallback", true]]),
      }),
    ).toBe("fallback");
  });

  it("uses prepared provider objects for configuration without registry rediscovery", () => {
    const resolveConfig = vi.fn(() => ({}));
    const isConfigured = vi.fn(() => true);
    const provider = {
      ...createSpeechProvider("openai"),
      resolveConfig,
      isConfigured,
    };
    const cfg = {} as OpenClawConfig;

    expect(isTtsProviderConfigured(resolveTtsConfig(cfg), provider, cfg)).toBe(true);
    expect(resolveConfig).toHaveBeenCalledOnce();
    expect(isConfigured).toHaveBeenCalledOnce();
    expect(mocks.canonicalizeSpeechProviderId).not.toHaveBeenCalled();
    expect(mocks.getSpeechProvider).not.toHaveBeenCalled();
  });

  it("canonicalizes a voice-model alias omitted from the supplied inventory", () => {
    const inventory = [createSpeechProvider("openai")];
    const cfg = {
      agents: { defaults: { voiceModel: { primary: "edge/edge-tts" } } },
    } as OpenClawConfig;

    expect(resolveTtsProviderOrder("openai", cfg, inventory)).toEqual(["openai", "microsoft"]);
    expect(mocks.canonicalizeSpeechProviderId).toHaveBeenCalledWith("edge", expect.any(Object));
  });

  it("returns empty results when the capability runtime has no speech providers", () => {
    expect(registry.listSpeechProviders()).toStrictEqual([]);
    expect(registry.getSpeechProvider("demo-speech")).toBeUndefined();
    expect(registry.canonicalizeSpeechProviderId("demo-speech")).toBe("demo-speech");
  });
});
