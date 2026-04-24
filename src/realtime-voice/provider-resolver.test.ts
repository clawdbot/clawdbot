import { describe, expect, it } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import { resolveConfiguredRealtimeVoiceProvider } from "./provider-resolver.js";

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

    expect(resolution).toMatchObject({
      provider: providers[1],
      providerConfig: {
        enabled: true,
        resolved: true,
      },
    });
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

    expect(resolution.providerConfig).toMatchObject({
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

    expect(resolution.providerConfig).toMatchObject({
      model: "custom-realtime",
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
});
