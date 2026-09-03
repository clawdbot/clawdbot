import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import {
  createSyncSuiteTempRootTracker,
  mkdirSafeDir,
} from "../../plugins/test-helpers/fs-fixtures.js";
import { loadStaticManifestCatalogRowsForList } from "./list.manifest-catalog.js";

const tempRoots = createSyncSuiteTempRootTracker("manifest-catalog");

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  tempRoots.cleanup();
});

function prepareFixture() {
  const root = fs.realpathSync(tempRoots.makeTempDir());
  const bundled = path.join(root, "bundled");
  const workspaceDir = path.join(root, "workspace");
  const declarations = [
    ["catalog-owner", "fixture-provider", bundled],
    ["fixture-direct", "fixture-direct", bundled],
    ["disabled-owner", "fixture-disabled", bundled],
    ["workspace-owner", "fixture-workspace", path.join(workspaceDir, ".openclaw/extensions")],
  ] as const;
  const fixtures = declarations.map(([pluginId, providerId, parent]) => {
    const rootDir = path.join(parent, pluginId);
    mkdirSafeDir(rootDir);
    return createColdPluginFixture({
      rootDir,
      pluginId,
      providerId,
      packageName: `@example/${pluginId}`,
      manifest: {
        channels: [],
        channelConfigs: {},
        providerAuthChoices: [],
        modelCatalog: {
          providers: {
            [providerId]: {
              api: "openai-completions",
              baseUrl: "https://canonical.example.invalid/v1",
              models: [{ id: "tiny-model", name: "Tiny model", contextWindow: 8192 }],
            },
          },
          discovery: { [providerId]: "static" },
          ...(pluginId === "catalog-owner"
            ? {
                aliases: {
                  // A competing declaration must not displace same-name convention rows.
                  "fixture-direct": {
                    provider: providerId,
                    baseUrl: "https://competing.example.invalid/v1",
                  },
                  "fixture-alias": {
                    provider: providerId,
                    api: "openai-responses",
                    baseUrl: "https://alias.example.invalid/v1",
                  },
                },
              }
            : {}),
        },
      },
    });
  });
  const cfg: OpenClawConfig = {
    models: { catalogRefresh: { enabled: false } },
    plugins: {
      entries: Object.fromEntries(
        fixtures.map(({ pluginId }) => [pluginId, { enabled: pluginId !== "disabled-owner" }]),
      ),
    },
  };
  const env: NodeJS.ProcessEnv = {
    HOME: path.join(root, "home"),
    OPENCLAW_HOME: path.join(root, "home"),
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "state/openclaw.json"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundled,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
    OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    VITEST: "true",
  };
  const metadataSnapshot = loadPluginMetadataSnapshot({
    config: cfg,
    env,
    workspaceDir,
    allowCurrent: false,
    preferPersisted: false,
  });
  expect(metadataSnapshot.plugins.map((plugin) => plugin.id).toSorted()).toEqual(
    fixtures.map((fixture) => fixture.pluginId).toSorted(),
  );
  expect(metadataSnapshot.workspaceDir).toBe(workspaceDir);
  expect(metadataSnapshot.byPluginId.get("workspace-owner")?.origin).toBe("workspace");
  expect(metadataSnapshot.byPluginId.get("catalog-owner")?.origin).toBe("bundled");
  expect(metadataSnapshot.diagnostics.filter((diagnostic) => diagnostic.level === "error")).toEqual(
    [],
  );
  const manifestPaths = fixtures.map((fixture) =>
    path.join(fixture.rootDir, "openclaw.plugin.json"),
  );
  return { cfg, env, workspaceDir, metadataSnapshot, fixtures, manifestPaths };
}

// Count actual filesystem work, including manifest reads through pinned descriptors.
// All spies call through; a parse-cache hit still opens a file but reads no bytes.
function observeManifestIo(manifestPaths: string[]) {
  const manifests = new Set(manifestPaths);
  const descriptors = new Map<number, string>();
  const opens: string[] = [];
  const reads: string[] = [];
  const originalOpen = fs.openSync;
  const originalRead = fs.readFileSync;
  const originalClose = fs.closeSync;
  const openSpy = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
    const fd = originalOpen(...args);
    const file = args[0] instanceof URL ? fileURLToPath(args[0]) : String(args[0]);
    if (manifests.has(file)) {
      descriptors.set(fd, file);
      opens.push(path.basename(path.dirname(file)));
    }
    return fd;
  });
  const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
    const result = originalRead(...args);
    const file = typeof args[0] === "number" ? descriptors.get(args[0]) : String(args[0]);
    if (file && manifests.has(file)) {
      reads.push(path.basename(path.dirname(file)));
    }
    return result;
  });
  const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
    descriptors.delete(fd);
    return originalClose(fd);
  });
  return {
    opens,
    reads,
    stop() {
      openSpy.mockRestore();
      readSpy.mockRestore();
      closeSpy.mockRestore();
    },
  };
}

function withoutManifestIo<T>(fixture: ReturnType<typeof prepareFixture>, run: () => T) {
  const io = observeManifestIo(fixture.manifestPaths);
  let output: T;
  try {
    output = run();
  } finally {
    io.stop();
  }
  expect(fixture.fixtures.some(isColdPluginRuntimeLoaded)).toBe(false);
  expect.soft(io.reads).toEqual([]);
  expect.soft(io.opens).toEqual([]);
  return output;
}

describe("model-list prepared manifest snapshot", () => {
  it("loads static provider and alias rows without manifest I/O", () => {
    const loadRows = loadStaticManifestCatalogRowsForList;
    const fixture = prepareFixture();
    for (const providerFilter of [
      " FIXTURE-PROVIDER ",
      " FIXTURE-ALIAS ",
      "fixture-direct",
      "fixture-disabled",
    ]) {
      const rows = withoutManifestIo(fixture, () =>
        loadRows({ ...fixture, providerFilter }).map(({ ref, api, baseUrl }) => ({
          ref,
          api,
          baseUrl,
        })),
      );
      const provider = providerFilter.trim().toLowerCase();
      expect(rows).toEqual(
        provider === "fixture-disabled"
          ? []
          : [
              {
                ref: `${provider}/tiny-model`,
                api: provider === "fixture-alias" ? "openai-responses" : "openai-completions",
                baseUrl: `https://${provider === "fixture-alias" ? "alias" : "canonical"}.example.invalid/v1`,
              },
            ],
      );
    }
  });

  it.each(["change", "remove"] as const)("keeps prepared rows after manifest %s", (mutation) => {
    const fixture = prepareFixture();
    const owner = fixture.metadataSnapshot.byPluginId.get("catalog-owner");
    if (!owner) {
      throw new Error("missing fixture catalog owner");
    }
    if (mutation === "remove") {
      fs.unlinkSync(owner.manifestPath);
    } else {
      fs.writeFileSync(
        owner.manifestPath,
        JSON.stringify({
          id: owner.id,
          configSchema: { type: "object" },
          providers: [],
        }),
      );
    }
    const alias = withoutManifestIo(fixture, () =>
      loadStaticManifestCatalogRowsForList({ ...fixture, providerFilter: "fixture-alias" }).map(
        (row) => row.ref,
      ),
    );
    expect(alias).toEqual(["fixture-alias/tiny-model"]);
    const broad = withoutManifestIo(fixture, () =>
      loadStaticManifestCatalogRowsForList(fixture).map((row) => row.ref),
    );
    expect(broad).toEqual([
      "fixture-direct/tiny-model",
      "fixture-disabled/tiny-model",
      "fixture-provider/tiny-model",
      "fixture-workspace/tiny-model",
    ]);
  });

  it.each<[string, NonNullable<OpenClawConfig["plugins"]>, string, boolean]>([
    ["global disable", { enabled: false }, "fixture-alias", false],
    ["denylist", { deny: ["catalog-owner"] }, "fixture-alias", false],
    ["restrictive allowlist", { allow: ["fixture-direct"] }, "fixture-alias", false],
    ["allowlisted owner", { allow: ["catalog-owner"] }, "fixture-alias", true],
    ["entry disable", { entries: { "catalog-owner": { enabled: false } } }, "fixture-alias", false],
    ["entry enable", { entries: { "catalog-owner": { enabled: true } } }, "fixture-alias", true],
    ["index-disabled owner", {}, "fixture-disabled", false],
    [
      "explicit reenable",
      { entries: { "disabled-owner": { enabled: true } } },
      "fixture-disabled",
      true,
    ],
  ])(
    "applies current config to prepared ownership and rows: %s",
    (_label, plugins, provider, enabled) => {
      const fixture = prepareFixture();
      const params = {
        ...fixture,
        cfg: { ...fixture.cfg, plugins: { ...fixture.cfg.plugins, ...plugins } },
      };
      withoutManifestIo(fixture, () => {
        expect(
          loadStaticManifestCatalogRowsForList({ ...params, providerFilter: provider }).map(
            (row) => row.ref,
          ),
        ).toEqual(enabled ? [`${provider}/tiny-model`] : []);
      });
    },
  );
});
