import { describe, expect, it } from "vitest";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";

function createTestRegistry() {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
}

describe("plugin registry provider-like registrations", () => {
  it("does not duplicate manifest-declared capability provider ids during runtime registration", () => {
    const pluginRegistry = createTestRegistry();
    const record = createPluginRecord({
      id: "kitchen-sink",
      name: "Kitchen Sink",
      source: "/tmp/kitchen-sink/index.js",
      origin: "global",
      enabled: true,
      contracts: {
        speechProviders: ["kitchen-sink-speech-provider"],
      },
      configSchema: false,
    });

    pluginRegistry.registerSpeechProvider(record, {
      id: "kitchen-sink-speech-provider",
      label: "Kitchen Sink Speech",
      isConfigured: () => true,
      synthesize: async () => ({
        audioBuffer: Buffer.alloc(0),
        fileExtension: "mp3",
        outputFormat: "audio/mpeg",
        voiceCompatible: true,
      }),
    });

    expect(record.speechProviderIds).toEqual(["kitchen-sink-speech-provider"]);
    expect(pluginRegistry.registry.speechProviders).toHaveLength(1);
  });
});
