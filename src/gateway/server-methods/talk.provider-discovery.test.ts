import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  resetPluginLoaderTestStateForTest,
} from "../../plugins/loader.test-fixtures.js";
import { createVoiceProviderFixture } from "../../talk/provider-discovery.test-fixtures.js";
import { listRealtimeVoiceProviders } from "../../talk/provider-registry.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { callGatewayHandler } from "./skills.test-helpers.js";
import { talkHandlers } from "./talk.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

describe("Talk catalog provider discovery", () => {
  it("includes configured realtime candidates missing from the active registry", async () => {
    const { cfg, env } = createVoiceProviderFixture();
    cfg.plugins = {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        "voice-call": {
          config: { realtime: { providers: { "configured-voice": { ready: true } } } },
        },
      },
    };
    await withEnvAsync(env, async () => {
      const registry = loadOpenClawPlugins({ config: cfg, onlyPluginIds: ["active-voice"] });
      const result = await callGatewayHandler(
        talkHandlers,
        "talk.catalog",
        {},
        {
          context: { getRuntimeConfig: () => cfg },
        },
      );

      expect(result).toMatchObject({
        ok: true,
        error: undefined,
        response: {
          realtime: {
            ready: true,
            activeProvider: "configured-voice",
            providers: [
              { id: "active-voice", configured: false },
              { id: "configured-voice", configured: true },
            ],
          },
        },
      });
      expect(listRealtimeVoiceProviders(cfg)).toEqual(
        registry.realtimeVoiceProviders.map((entry) => entry.provider),
      );
    });
  });
});
