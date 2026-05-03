import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../../../../infra/tmp-openclaw-dir.js";
import { getChannelPluginCatalogEntry, listChannelPluginCatalogEntries } from "../../catalog.js";

type CatalogEntryMeta = {
  id: string;
  label: string;
  selectionLabel: string;
  docsPath: string;
  blurb: string;
  detailLabel?: string;
  aliases?: string[];
};

function createCatalogFixtureEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
  };
}

function createCatalogFallbackOnlyEnv(): NodeJS.ProcessEnv {
  return createCatalogFixtureEnv({
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
  });
}

export function describeChannelCatalogEntryContract(params: {
  channelId: string;
  npmSpec: string;
  alias?: string;
}) {
  describe(`${params.channelId} channel catalog contract`, () => {
    it("keeps the shipped catalog entry aligned", () => {
      const entry = getChannelPluginCatalogEntry(params.channelId);
      expect(entry?.install.npmSpec).toBe(params.npmSpec);
      if (params.alias) {
        expect(entry?.meta.aliases).toContain(params.alias);
      }
    });

    it("appears in the channel catalog listing", () => {
      const ids = listChannelPluginCatalogEntries().map((entry) => entry.id);
      expect(ids).toContain(params.channelId);
    });
  });
}

export function describeBundledMetadataOnlyChannelCatalogContract(params: {
  pluginId: string;
  packageName: string;
  npmSpec: string;
  meta: CatalogEntryMeta;
  defaultChoice?: string;
}) {
  describe(`${params.pluginId} bundled metadata-only channel catalog contract`, () => {
    it("includes the bundled metadata-only channel entry when the runtime entrypoint is omitted", () => {
      const workspaceDir = fs.mkdtempSync(
        path.join(resolvePreferredOpenClawTmpDir(), "openclaw-bundled-catalog-"),
      );
      const bundledDir = path.join(workspaceDir, ".openclaw", "extensions", params.pluginId);
      fs.mkdirSync(bundledDir, { recursive: true });
      fs.writeFileSync(
        path.join(workspaceDir, "package.json"),
        JSON.stringify({ name: "openclaw" }),
        "utf8",
      );
      fs.writeFileSync(
        path.join(bundledDir, "package.json"),
        JSON.stringify({
          name: params.packageName,
          openclaw: {
            extensions: ["./index.js"],
            channel: params.meta,
            install: {
              npmSpec: params.npmSpec,
              defaultChoice: params.defaultChoice,
            },
          },
        }),
        "utf8",
      );
      fs.writeFileSync(path.join(bundledDir, "index.js"), "export default {};\n", "utf8");
      fs.writeFileSync(
        path.join(bundledDir, "openclaw.plugin.json"),
        JSON.stringify({ id: params.pluginId, channels: [params.meta.id], configSchema: {} }),
        "utf8",
      );

      const entry = listChannelPluginCatalogEntries({
        workspaceDir,
        env: createCatalogFixtureEnv({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }),
      }).find((item) => item.id === params.meta.id);

      expect(entry?.install.npmSpec).toBe(params.npmSpec);
      expect(entry?.pluginId).toBe(params.pluginId);
    });
  });
}

export function describeOfficialFallbackChannelCatalogContract(params: {
  channelId: string;
  npmSpec: string;
  meta: CatalogEntryMeta;
  packageName: string;
  pluginId: string;
  externalNpmSpec: string;
  externalLabel: string;
}) {
  describe(`${params.channelId} official fallback channel catalog contract`, () => {
    it("includes shipped official channel catalog entries when bundled metadata is omitted", () => {
      const dir = fs.mkdtempSync(
        path.join(resolvePreferredOpenClawTmpDir(), "openclaw-official-catalog-"),
      );
      const catalogPath = path.join(dir, "channel-catalog.json");
      fs.writeFileSync(
        catalogPath,
        JSON.stringify({
          entries: [
            {
              name: params.packageName,
              openclaw: {
                channel: params.meta,
                install: {
                  npmSpec: params.npmSpec,
                  defaultChoice: "npm",
                },
              },
            },
          ],
        }),
      );

      const entry = listChannelPluginCatalogEntries({
        env: createCatalogFallbackOnlyEnv(),
        officialCatalogPaths: [catalogPath],
      }).find((item) => item.id === params.channelId);

      expect(entry?.install.npmSpec).toBe(params.npmSpec);
      expect(entry?.pluginId).toBeUndefined();
      expect(entry?.trustedSourceLinkedOfficialInstall).toBe(true);
    });

    it("lets external catalogs override shipped fallback channel metadata", () => {
      const dir = fs.mkdtempSync(
        path.join(resolvePreferredOpenClawTmpDir(), "openclaw-fallback-catalog-"),
      );
      const bundledDir = path.join(dir, "dist", "extensions", params.pluginId);
      const officialCatalogPath = path.join(dir, "channel-catalog.json");
      const externalCatalogPath = path.join(dir, "catalog.json");
      fs.mkdirSync(bundledDir, { recursive: true });
      fs.writeFileSync(
        path.join(bundledDir, "package.json"),
        JSON.stringify({
          name: params.packageName,
          openclaw: {
            channel: {
              ...params.meta,
              label: `${params.meta.label} Bundled`,
              selectionLabel: `${params.meta.label} Bundled`,
              blurb: "bundled fallback",
            },
            install: { npmSpec: params.npmSpec },
          },
        }),
        "utf8",
      );
      fs.writeFileSync(
        officialCatalogPath,
        JSON.stringify({
          entries: [
            {
              name: params.packageName,
              openclaw: {
                channel: {
                  ...params.meta,
                  label: `${params.meta.label} Official`,
                  selectionLabel: `${params.meta.label} Official`,
                  blurb: "official fallback",
                },
                install: { npmSpec: params.npmSpec },
              },
            },
          ],
        }),
        "utf8",
      );
      fs.writeFileSync(
        externalCatalogPath,
        JSON.stringify({
          entries: [
            {
              name: params.externalNpmSpec,
              openclaw: {
                channel: {
                  ...params.meta,
                  label: params.externalLabel,
                  selectionLabel: params.externalLabel,
                  blurb: "external override",
                },
                install: { npmSpec: params.externalNpmSpec },
              },
            },
          ],
        }),
        "utf8",
      );

      const entry = listChannelPluginCatalogEntries({
        catalogPaths: [externalCatalogPath],
        officialCatalogPaths: [officialCatalogPath],
        env: createCatalogFallbackOnlyEnv(),
      }).find((item) => item.id === params.channelId);

      expect(entry?.install.npmSpec).toBe(params.externalNpmSpec);
      expect(entry?.meta.label).toBe(params.externalLabel);
      expect(entry?.pluginId).toBeUndefined();
      expect(entry?.trustedSourceLinkedOfficialInstall).toBeUndefined();
    });

    it("surfaces package-name drift in external channel catalog install metadata", () => {
      const dir = fs.mkdtempSync(
        path.join(resolvePreferredOpenClawTmpDir(), "openclaw-drifted-catalog-"),
      );
      const catalogPath = path.join(dir, "catalog.json");
      fs.writeFileSync(
        catalogPath,
        JSON.stringify({
          entries: [
            {
              name: params.packageName,
              openclaw: {
                channel: params.meta,
                install: {
                  npmSpec: `${params.packageName}-fork@1.2.3`,
                  expectedIntegrity: "sha512-drifted",
                },
              },
            },
          ],
        }),
        "utf8",
      );

      const entry = listChannelPluginCatalogEntries({
        catalogPaths: [catalogPath],
        officialCatalogPaths: [],
        env: createCatalogFallbackOnlyEnv(),
      }).find((item) => item.id === params.channelId);

      expect(entry?.installSource?.npm).toMatchObject({
        packageName: `${params.packageName}-fork`,
        expectedPackageName: params.packageName,
      });
      expect(entry?.installSource?.warnings).toEqual(["npm-spec-package-name-mismatch"]);
    });
  });
}
