// Talk provider resolver tests cover provider selection from config.
import { describe, expect, it } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import {
  resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceProviderCapabilities,
} from "./provider-resolver.js";

const INTERNAL_REALTIME_VOICE_PROVIDER = Symbol.for("openclaw.internal.realtime-voice-provider.v1");

function attachInternalRealtimeVoiceProviderApi(
  provider: RealtimeVoiceProviderPlugin,
  api: {
    isBrowserSessionConfigured: () => boolean;
    resolveBrowserSessionCapabilities?: (ctx: {
      providerConfig: Record<string, unknown>;
    }) => object;
  },
): void {
  Object.defineProperty(provider, INTERNAL_REALTIME_VOICE_PROVIDER, {
    configurable: true,
    value: api,
  });
}

describe("realtime voice provider resolver", () => {
  const providers: RealtimeVoiceProviderPlugin[] = [
    {
      id: "first",
      label: "First",
      autoSelectOrder: 1,
      isConfigured: () => false,
      createBridge: () => {
        throw new Error("unused");
      },
    },
    {
      id: "second",
      label: "Second",
      autoSelectOrder: 2,
      resolveConfig: ({ rawConfig }) => ({ ...rawConfig, resolved: true }),
      isConfigured: ({ providerConfig }) => providerConfig.enabled === true,
      createBridge: () => {
        throw new Error("unused");
      },
    },
  ];

  it("auto-selects the first configured realtime voice provider", () => {
    const resolution = resolveConfiguredRealtimeVoiceProvider({
      cfg: {},
      providers,
      providerConfigs: {
        second: { enabled: true },
      },
    });

    expect(resolution).toStrictEqual({
      provider: providers[1],
      providerConfig: {
        enabled: true,
        resolved: true,
      },
    });
  });

  it("keeps browser-only providers out of bridge auto-selection", () => {
    const browserOnly: RealtimeVoiceProviderPlugin = {
      id: "browser-only",
      label: "Browser only",
      autoSelectOrder: 1,
      isConfigured: () => false,
      createBridge: () => {
        throw new Error("unused");
      },
    };
    attachInternalRealtimeVoiceProviderApi(browserOnly, {
      isBrowserSessionConfigured: () => true,
    });
    const bridge: RealtimeVoiceProviderPlugin = {
      id: "bridge",
      label: "Bridge",
      autoSelectOrder: 2,
      isConfigured: () => true,
      createBridge: () => {
        throw new Error("unused");
      },
    };

    expect(
      resolveConfiguredRealtimeVoiceProvider({
        cfg: {},
        providers: [browserOnly, bridge],
      }).provider.id,
    ).toBe("bridge");
    expect(
      resolveConfiguredRealtimeVoiceProvider({
        cfg: {},
        providers: [browserOnly, bridge],
        surface: "browser-session",
      }).provider.id,
    ).toBe("browser-only");
  });

  it("applies a default model before provider config resolution", () => {
    const resolution = resolveConfiguredRealtimeVoiceProvider({
      cfg: {},
      configuredProviderId: "second",
      defaultModel: "gpt-realtime",
      providers,
      providerConfigs: {
        second: { enabled: true },
      },
    });

    expect(resolution.providerConfig).toStrictEqual({
      enabled: true,
      model: "gpt-realtime",
      resolved: true,
    });
  });

  it("keeps explicit provider model over the default model", () => {
    const resolution = resolveConfiguredRealtimeVoiceProvider({
      cfg: {},
      configuredProviderId: "second",
      defaultModel: "gpt-realtime",
      providers,
      providerConfigs: {
        second: { enabled: true, model: "custom-realtime" },
      },
    });

    expect(resolution.providerConfig).toStrictEqual({
      enabled: true,
      model: "custom-realtime",
      resolved: true,
    });
  });

  it("applies caller overrides to the auto-selected realtime voice provider", () => {
    const resolution = resolveConfiguredRealtimeVoiceProvider({
      cfg: {},
      defaultModel: "gpt-realtime",
      providerConfigOverrides: {
        model: "gpt-realtime-2",
        voice: "cedar",
      },
      providers,
      providerConfigs: {
        second: { enabled: true, model: "provider-default", voice: "marin" },
      },
    });

    expect(resolution.providerConfig).toStrictEqual({
      enabled: true,
      model: "gpt-realtime-2",
      voice: "cedar",
      resolved: true,
    });
  });

  it("throws a caller-specified message when no providers exist", () => {
    expect(() =>
      resolveConfiguredRealtimeVoiceProvider({
        cfg: {},
        providers: [],
        noRegisteredProviderMessage: "No configured realtime voice provider registered",
      }),
    ).toThrow("No configured realtime voice provider registered");
  });

  it("resolves config-specific provider capabilities", () => {
    const provider: RealtimeVoiceProviderPlugin = {
      id: "dynamic",
      label: "Dynamic",
      capabilities: {
        transports: ["webrtc"],
        inputAudioFormats: [],
        outputAudioFormats: [],
        supportsVideoFrames: true,
      },
      isConfigured: () => true,
      createBridge: () => {
        throw new Error("unused");
      },
    };
    attachInternalRealtimeVoiceProviderApi(provider, {
      isBrowserSessionConfigured: () => true,
      resolveBrowserSessionCapabilities: ({ providerConfig }) => ({
        transports: ["webrtc"],
        inputAudioFormats: [],
        outputAudioFormats: [],
        supportsVideoFrames: providerConfig.authMode !== "native",
      }),
    });

    expect(
      resolveRealtimeVoiceProviderCapabilities({
        provider,
        providerConfig: { authMode: "native" },
        surface: "browser-session",
      })?.supportsVideoFrames,
    ).toBe(false);
  });
});
