import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { cleanupTrackedTempDirs } from "../plugins/test-helpers/fs-fixtures.js";

vi.mock("../plugins/bundled-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/bundled-dir.js")>();
  return {
    ...actual,
    resolveBundledPluginsDir: (env: NodeJS.ProcessEnv = process.env) =>
      env.OPENCLAW_BUNDLED_PLUGINS_DIR,
  };
});

const tempDirs: string[] = [];

function makeTempDir(): string {
  const trustedRoot = path.resolve("dist-runtime", "extensions");
  fs.mkdirSync(trustedRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(trustedRoot, ".openclaw-plugin-prefer-over-"));
  tempDirs.push(dir);
  return dir;
}

function writeBundledChannelPackage(rootDir: string, channelId: string): void {
  const pluginDir = path.join(rootDir, channelId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      openclaw: {
        channel: {
          id: channelId,
          label: "Cache Drift",
          selectionLabel: "Cache Drift",
          docsPath: `/channels/${channelId}`,
          blurb: "Cache drift fixture",
        },
      },
    }),
    "utf-8",
  );
}

const EMPTY_MANIFEST_REGISTRY: PluginManifestRegistry = {
  plugins: [],
  diagnostics: [],
};

async function setBundledPluginsDirFixture(dir: string | undefined): Promise<void> {
  const { setBundledPluginsDirOverrideForTest } = await import("../plugins/bundled-dir.js");
  setBundledPluginsDirOverrideForTest(dir);
}

afterEach(async () => {
  await setBundledPluginsDirFixture(undefined);
  vi.unstubAllEnvs();
  vi.resetModules();
  cleanupTrackedTempDirs(tempDirs);
});

describe("plugin auto-enable preferOver", () => {
  it("tolerates bundled channel id metadata drift during auto-enable", async () => {
    vi.resetModules();
    const rootDir = makeTempDir();
    const channelId = "cache-drift-channel";
    writeBundledChannelPackage(rootDir, channelId);

    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", rootDir);
    await setBundledPluginsDirFixture(rootDir);
    const { normalizeChatChannelId } = await import("../channels/ids.js");
    expect(normalizeChatChannelId(channelId)).toBe(channelId);

    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.join(rootDir, "missing"));
    await setBundledPluginsDirFixture(undefined);
    const { materializePluginAutoEnableCandidates } = await import("./plugin-auto-enable.js");

    const result = materializePluginAutoEnableCandidates({
      config: {
        channels: {
          [channelId]: { token: "configured" },
          fallback: { token: "configured" },
        },
      },
      candidates: [
        {
          pluginId: channelId,
          kind: "channel-configured",
          channelId,
        },
        {
          pluginId: "fallback",
          kind: "channel-configured",
          channelId: "fallback",
        },
      ],
      env: {
        OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(rootDir, "missing"),
      },
      manifestRegistry: EMPTY_MANIFEST_REGISTRY,
    });

    expect(result.config.channels?.[channelId]?.enabled).toBe(true);
  });
});
