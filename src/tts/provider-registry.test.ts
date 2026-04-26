import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";

const resolvePluginCapabilityProviderMock = vi.hoisted(() => vi.fn());
const resolvePluginCapabilityProvidersMock = vi.hoisted(() => vi.fn());

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProvider: resolvePluginCapabilityProviderMock,
  resolvePluginCapabilityProviders: resolvePluginCapabilityProvidersMock,
}));

let getSpeechProvider: typeof import("./provider-registry.js").getSpeechProvider;
let listSpeechProviders: typeof import("./provider-registry.js").listSpeechProviders;
let canonicalizeSpeechProviderId: typeof import("./provider-registry.js").canonicalizeSpeechProviderId;
let normalizeSpeechProviderId: typeof import("./provider-registry.js").normalizeSpeechProviderId;

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
  beforeAll(async () => {
    ({
      getSpeechProvider,
      listSpeechProviders,
      canonicalizeSpeechProviderId,
      normalizeSpeechProviderId,
    } = await import("./provider-registry.js"));
  });

  beforeEach(() => {
    resolvePluginCapabilityProviderMock.mockReset();
    resolvePluginCapabilityProviderMock.mockReturnValue(undefined);
    resolvePluginCapabilityProvidersMock.mockReset();
    resolvePluginCapabilityProvidersMock.mockReturnValue([]);
  });

  it("lists providers from the speech capability runtime", () => {
    const cfg = {} as OpenClawConfig;
    resolvePluginCapabilityProvidersMock.mockReturnValue([createSpeechProvider("demo-speech")]);

    expect(listSpeechProviders(cfg).map((provider) => provider.id)).toEqual(["demo-speech"]);
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "speechProviders",
      cfg,
    });
  });

  it("gets providers by normalized id through the capability runtime", () => {
    const cfg = {} as OpenClawConfig;
    const provider = createSpeechProvider("microsoft", ["edge"]);
    resolvePluginCapabilityProviderMock.mockReturnValue(provider);

    expect(getSpeechProvider(" MICROSOFT ", cfg)).toBe(provider);
    expect(resolvePluginCapabilityProviderMock).toHaveBeenCalledWith({
      key: "speechProviders",
      providerId: "microsoft",
      cfg,
    });
  });

  it("canonicalizes aliases from listed providers when direct lookup misses", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createSpeechProvider("microsoft", ["edge"]),
    ]);

    expect(normalizeSpeechProviderId("edge")).toBe("edge");
    expect(canonicalizeSpeechProviderId("edge")).toBe("microsoft");
  });

  it("returns empty results when the capability runtime has no speech providers", () => {
    expect(listSpeechProviders()).toEqual([]);
    expect(getSpeechProvider("demo-speech")).toBeUndefined();
    expect(canonicalizeSpeechProviderId("demo-speech")).toBe("demo-speech");
  });
});
