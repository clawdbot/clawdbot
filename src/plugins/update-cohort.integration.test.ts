import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { convergePluginReleaseCohort } from "./update-cohort.js";

describe("plugin release cohort real synchronization", () => {
  const tempDirs: string[] = [];
  afterEach(() => cleanupTrackedTempDirs(tempDirs));
  it.each([false, true])(
    "checks current payloads after a dev switch (missing npm sibling: %s)",
    async (missingSibling) => {
      const root = fs.realpathSync(makeTrackedTempDir("openclaw-cohort-dev", tempDirs));
      const bundledRoot = path.join(root, "bundled");
      const bundledPath = path.join(bundledRoot, "cohort");
      const oldPath = path.join(root, "removed-npm-package");
      fs.mkdirSync(bundledPath, { recursive: true });
      fs.writeFileSync(
        path.join(bundledPath, "package.json"),
        JSON.stringify({
          name: "@example/cohort",
          version: "1.0.0",
          openclaw: { extensions: ["./index.js"] },
        }),
      );
      fs.writeFileSync(
        path.join(bundledPath, "openclaw.plugin.json"),
        JSON.stringify({
          id: "cohort",
          configSchema: { type: "object" },
        }),
      );
      fs.writeFileSync(path.join(bundledPath, "index.js"), "module.exports = {};\n");
      const records: Record<string, PluginInstallRecord> = {
        ...(missingSibling
          ? {
              broken: {
                source: "npm" as const,
                spec: "@example/broken",
                installPath: path.join(root, "missing-package"),
              },
            }
          : {}),
        cohort: { source: "npm", spec: "@example/cohort", installPath: oldPath },
      };
      const config: OpenClawConfig = {
        plugins: {
          installs: records,
          entries: {
            cohort: { enabled: true },
            ...(missingSibling ? { broken: { enabled: true } } : {}),
          },
        },
      };
      let registryRequests = 0;
      await withServer(
        (_request, response) => {
          registryRequests += 1;
          response.writeHead(404);
          response.end("Fixture package is unavailable");
        },
        async (registry) => {
          const env = {
            HOME: root,
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
            NPM_CONFIG_REGISTRY: registry,
            npm_config_registry: registry,
            NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
            NPM_CONFIG_USERCONFIG: path.join(root, "empty.npmrc"),
          };
          await withEnvAsync(env, async () => {
            const result = await withPluginCache(createPluginCache(), () =>
              convergePluginReleaseCohort({
                config,
                channel: "dev",
                timeoutMs: 60_000,
                env,
              }),
            );
            expect(result.sync.summary.switchedToBundled).toEqual(["cohort"]);
            expect(result.config.plugins?.installs?.cohort).toMatchObject({
              source: "path",
              installPath: bundledPath,
            });
            expect(result.remainingMissingPayloads).toEqual([]);
            expect(result.missingPayloads.map((entry) => entry.pluginId)).toEqual(
              missingSibling ? ["broken"] : [],
            );
            if (missingSibling) {
              expect(registryRequests).toBeGreaterThan(0);
              expect(result.repairOutcomes).toEqual([
                expect.objectContaining({
                  pluginId: "broken",
                  status: "skipped",
                  message: expect.stringContaining("after plugin update failure"),
                }),
              ]);
              expect(result.config.plugins?.entries?.broken?.enabled).toBe(false);
            } else {
              expect(registryRequests).toBe(0);
              expect(result.repairOutcomes).toEqual([]);
            }
          });
        },
      );
    },
  );
});
