// `status --all` must carry its prepared manifest records through missing-channel
// repair rows instead of rebuilding the manifest registry once per row.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { getOrCreatePluginMetadataOwner } from "../../plugins/plugin-metadata-collection.js";

const counters = vi.hoisted(() => ({
  installedIndexPreparations: 0,
}));

vi.mock("../../plugins/installed-plugin-index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/installed-plugin-index.js")>();
  return {
    ...actual,
    loadInstalledPluginIndexWithDiscovery: (
      ...args: Parameters<typeof actual.loadInstalledPluginIndexWithDiscovery>
    ) => {
      counters.installedIndexPreparations += 1;
      return actual.loadInstalledPluginIndexWithDiscovery(...args);
    },
  };
});

const { buildChannelsTable } = await import("./channels.js");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-status-all-discovery-"));
const OWNERLESS_CHANNEL_IDS = ["feishu", "googlechat", "matrix", "twitch"] as const;

function configFor(channelIds: readonly string[]): OpenClawConfig {
  return {
    channels: Object.fromEntries(channelIds.map((channelId) => [channelId, { enabled: true }])),
  } as OpenClawConfig;
}

async function runStatusChannels(channelIds: readonly string[]) {
  counters.installedIndexPreparations = 0;
  const table = await buildChannelsTable(configFor(channelIds));
  return {
    preparations: counters.installedIndexPreparations,
    table,
  };
}

beforeEach(() => {
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_DISABLE_UPDATE_CHECK", "1");
  vi.stubEnv("OPENCLAW_HOME", path.join(tempRoot, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempRoot, "openclaw.json"));
  vi.stubEnv("FEISHU_APP_ID", "");
  vi.stubEnv("FEISHU_APP_SECRET", "");
  vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", "");
  vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT_FILE", "");
  vi.stubEnv("MATRIX_HOMESERVER", "");
  vi.stubEnv("MATRIX_ACCESS_TOKEN", "");
  vi.stubEnv("OPENCLAW_TWITCH_ACCESS_TOKEN", "");
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("keeps status-all manifest preparation constant as missing repair rows increase", async () => {
  const runColdAndWarm = (channelIds: readonly string[]) =>
    withPluginCache(createPluginCache(), async () => {
      const owner = getOrCreatePluginMetadataOwner();
      try {
        return {
          cold: await runStatusChannels(channelIds),
          warm: await runStatusChannels(channelIds),
        };
      } finally {
        owner.dispose();
      }
    });
  const one = await runColdAndWarm(OWNERLESS_CHANNEL_IDS.slice(0, 1));
  const four = await runColdAndWarm(OWNERLESS_CHANNEL_IDS);

  for (const result of [four.cold, four.warm]) {
    expect(result.table.rows.map((row) => row.id)).toEqual(
      expect.arrayContaining([...OWNERLESS_CHANNEL_IDS]),
    );
  }
  expect(one.cold.preparations).toBeGreaterThan(0);
  expect(four.cold.preparations).toBe(one.cold.preparations);
  expect({ oneRow: one.warm.preparations, fourRows: four.warm.preparations }).toStrictEqual({
    oneRow: 0,
    fourRows: 0,
  });
});
