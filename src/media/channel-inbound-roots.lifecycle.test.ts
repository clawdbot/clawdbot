import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { withEnv } from "../test-utils/env.js";
import { resolveChannelInboundAttachmentRootsForChannel } from "./channel-inbound-roots.js";

const tempDirs = createTempDirTracker();
const caches: ReturnType<typeof createPluginCache>[] = [];

afterEach(() => {
  for (const cache of caches.splice(0)) {
    cache.disposeModules?.();
  }
  tempDirs.cleanup();
});

describe("channel media artifact cache ownership", () => {
  it.each(["present", "missing"] as const)(
    "isolates an initially %s media artifact between operations while using current config",
    (initial) => {
      const channelId = `media-owner-${initial}`;
      const firstRoot = tempDirs.make("openclaw-media-owner-first-");
      const secondRoot = tempDirs.make("openclaw-media-owner-second-");
      const firstCache = createPluginCache();
      const secondCache = createPluginCache();
      caches.push(firstCache, secondCache);
      const writeArtifact = (rootDir: string, marker: string) => {
        const pluginDir = path.join(rootDir, channelId);
        fs.mkdirSync(pluginDir);
        fs.writeFileSync(path.join(pluginDir, "package.json"), '{"type":"commonjs"}\n');
        fs.writeFileSync(
          path.join(pluginDir, "media-contract-api.js"),
          `module.exports.resolveInboundAttachmentRoots = ({ cfg, accountId }) => [cfg.agents.defaults.workspace + "/" + ${JSON.stringify(marker)} + "/" + accountId];\n`,
        );
      };
      if (initial === "present") {
        writeArtifact(firstRoot, "first");
      }
      writeArtifact(secondRoot, "second");
      const resolveFor = (
        cache: typeof firstCache,
        rootDir: string,
        workspace: string,
        accountId: string,
      ) =>
        withEnv(
          {
            OPENCLAW_BUNDLED_PLUGINS_DIR: rootDir,
            OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          },
          () =>
            withPluginCache(cache, () =>
              resolveChannelInboundAttachmentRootsForChannel({
                cfg: { agents: { defaults: { workspace } } },
                channelId,
                accountId,
              }),
            ),
        );

      expect(resolveFor(firstCache, firstRoot, "/input-a", "work")).toEqual(
        initial === "present" ? ["/input-a/first/work"] : undefined,
      );
      expect(resolveFor(firstCache, firstRoot, "/input-b", "personal")).toEqual(
        initial === "present" ? ["/input-b/first/personal"] : undefined,
      );
      expect(resolveFor(secondCache, secondRoot, "/input-b", "personal")).toEqual([
        "/input-b/second/personal",
      ]);
      expect(resolveFor(firstCache, firstRoot, "/input-a", "work")).toEqual(
        initial === "present" ? ["/input-a/first/work"] : undefined,
      );
    },
  );
});
