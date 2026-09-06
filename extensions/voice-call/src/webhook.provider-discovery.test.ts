import fs from "node:fs";
import path from "node:path";
import {
  createEmptyPluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getRealtimeTranscriptionProvider } from "openclaw/plugin-sdk/realtime-transcription";
import { useAutoCleanupTempDirTracker, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { CallManager } from "./manager.js";
import { MockProvider } from "./providers/mock.js";
import { createVoiceCallBaseConfig } from "./test-fixtures.js";
import { VoiceCallWebhookServer } from "./webhook.js";

afterEach(resetPluginRuntimeStateForTest);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("VoiceCallWebhookServer transcription provider discovery", () => {
  it.each(
    ["configured-stt", "configured-stt-alias"].flatMap((configKey) =>
      [undefined, configKey].map((configuredProviderId) => ({ configKey, configuredProviderId })),
    ),
  )(
    "initializes streaming from $configKey config with explicit selection $configuredProviderId",
    async ({ configuredProviderId, configKey }) => {
      const root = tempDirs.make("voice-call-provider-discovery-");
      const workspace = path.join(root, "workspace");
      fs.mkdirSync(workspace, { recursive: true });
      for (const id of ["active-stt", "configured-stt"]) {
        const pluginDir = path.join(root, "extensions", id);
        fs.mkdirSync(pluginDir, { recursive: true });
        fs.writeFileSync(
          path.join(pluginDir, "index.cjs"),
          `module.exports = { id: "${id}", register(api) {
            api.registerRealtimeTranscriptionProvider({
              id: "${id}", aliases: ["${id}-alias"], label: "${id}",
              isConfigured: ({ providerConfig }) => providerConfig.ready === true,
              createSession: () => { throw new Error("startup must not start transcription"); },
            });
          } };`,
        );
        fs.writeFileSync(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id,
            configSchema: { type: "object", additionalProperties: false, properties: {} },
            contracts: { realtimeTranscriptionProviders: [id] },
          }),
        );
        fs.writeFileSync(
          path.join(pluginDir, "package.json"),
          JSON.stringify({ openclaw: { extensions: ["./index.cjs"] } }),
        );
      }
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace } },
        plugins: {
          allow: ["active-stt", "configured-stt"],
          entries: {
            "active-stt": { enabled: true },
            "configured-stt": { enabled: true },
          },
        },
      };
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "extensions"),
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        },
        async () => {
          const activeProvider = getRealtimeTranscriptionProvider("active-stt", cfg);
          if (!activeProvider) {
            throw new Error("expected the real loader to discover the active fixture provider");
          }
          const registry = createEmptyPluginRegistry();
          registry.realtimeTranscriptionProviders.push({
            pluginId: "active-stt",
            pluginName: "active-stt",
            source: path.join(root, "extensions", "active-stt", "index.cjs"),
            provider: activeProvider,
          });
          setActivePluginRegistry(registry, undefined, "default", workspace);
          const config = createVoiceCallBaseConfig();
          config.serve.port = 0;
          config.streaming.enabled = true;
          config.streaming.provider = configuredProviderId;
          config.streaming.providers = {
            "active-stt": { ready: false },
            [configKey]: { ready: true },
          };
          const server = new VoiceCallWebhookServer(
            config,
            new CallManager(config, path.join(root, "calls")),
            new MockProvider(),
            cfg,
          );
          try {
            await server.start();
            expect(server.getMediaStreamHandler()).not.toBeNull();
          } finally {
            await server.stop();
          }
        },
      );
    },
  );
});
