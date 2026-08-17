// `plugins doctor` reports effective-only plugins from the metadata snapshot it already
// built, so asking for effective ids must not re-derive plugin discovery.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";

const counters = vi.hoisted(() => ({ manifestRegistryRebuilds: 0, discoveryScans: 0 }));

vi.mock("../config/io.plugin-metadata.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/io.plugin-metadata.js")>();
  return {
    ...actual,
    resolveConfigWidePluginManifestRegistry: (
      ...args: Parameters<typeof actual.resolveConfigWidePluginManifestRegistry>
    ) => {
      counters.manifestRegistryRebuilds += 1;
      return actual.resolveConfigWidePluginManifestRegistry(...args);
    },
  };
});

vi.mock("./discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./discovery.js")>();
  return {
    ...actual,
    discoverOpenClawPlugins: (...args: Parameters<typeof actual.discoverOpenClawPlugins>) => {
      counters.discoveryScans += 1;
      return actual.discoverOpenClawPlugins(...args);
    },
  };
});

const { buildPluginDiagnosticsReport } = await import("./status.js");
const { resolveEffectivePluginIds } = await import("./effective-plugin-ids.js");
const { loadPluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-effective-plugin-ids-"));

function coldPluginRoot(pluginId: string, channelId: string): string {
  const rootDir = path.join(tempRoot, pluginId);
  fs.mkdirSync(rootDir, { recursive: true });
  createColdPluginFixture({
    rootDir,
    pluginId,
    channelId,
    providerId: `${pluginId}-provider`,
    packageName: `@example/${pluginId}`,
  });
  return rootDir;
}

const channelOwnerRoot = coldPluginRoot("cold-plugin", "cold-channel");
const otherRoot = coldPluginRoot("other-plugin", "other-channel");

const config: OpenClawConfig = {
  channels: { "cold-channel": { enabled: true } },
  plugins: {
    load: { paths: [channelOwnerRoot, otherRoot] },
    entries: { "cold-plugin": { enabled: true }, "other-plugin": { enabled: true } },
  },
} as OpenClawConfig;

function countReport(params: { effectiveOnly: boolean; onlyPluginIds?: readonly string[] }): {
  rebuilds: number;
  scans: number;
  ids: string[];
} {
  counters.manifestRegistryRebuilds = 0;
  counters.discoveryScans = 0;
  const report = buildPluginDiagnosticsReport({ config, env: process.env, ...params });
  return {
    rebuilds: counters.manifestRegistryRebuilds,
    scans: counters.discoveryScans,
    ids: report.plugins.map((plugin) => plugin.id).toSorted(),
  };
}

function countResolve(metadataSnapshot: PluginMetadataSnapshot): {
  rebuilds: number;
  ids: string[];
} {
  counters.manifestRegistryRebuilds = 0;
  const ids = resolveEffectivePluginIds({ config, env: process.env, metadataSnapshot });
  return { rebuilds: counters.manifestRegistryRebuilds, ids };
}

beforeEach(() => {
  clearCurrentPluginMetadataSnapshot();
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_HOME", path.join(tempRoot, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
});

afterEach(() => {
  clearCurrentPluginMetadataSnapshot();
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("does not re-derive discovery when reporting effective-only plugins", () => {
  const all = countReport({ effectiveOnly: false });
  const effective = countReport({ effectiveOnly: true });

  // The effective-only filter still selects the configured channel owner.
  expect(effective.ids).toEqual(["cold-plugin", "other-plugin"]);
  // ...and it reuses the snapshot the report already built instead of rediscovering.
  expect({
    rebuilds: effective.rebuilds,
    scansMoreThanFullReport: effective.scans > all.scans,
  }).toEqual({ rebuilds: 0, scansMoreThanFullReport: false });
});

// A supplied snapshot is an optimization, never an input to the answer.
it("only reuses a snapshot that answers for the whole config", () => {
  const env = process.env;
  const withoutSnapshot = resolveEffectivePluginIds({ config, env });
  const full = countResolve(loadPluginMetadataSnapshot({ config, env }));
  clearCurrentPluginMetadataSnapshot();
  // `recordPluginInstallSource` asks for one plugin's effective state, which scopes the
  // snapshot to that plugin and truncates its manifest set to that plugin alone.
  const scopedSnapshot = loadPluginMetadataSnapshot({
    config,
    env,
    pluginIds: ["other-plugin"],
  });
  clearCurrentPluginMetadataSnapshot();
  const scoped = countResolve(scopedSnapshot);

  expect({ full: full.ids, scoped: scoped.ids }).toEqual({
    full: withoutSnapshot,
    scoped: withoutSnapshot,
  });
  // A whole-config snapshot is reused; a plugin-scoped one cannot stand in for it.
  expect({ fullReused: full.rebuilds === 0, scopedReused: scoped.rebuilds === 0 }).toEqual({
    fullReused: true,
    scopedReused: false,
  });
});
