import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  loadInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecordsSync,
} from "./installed-plugin-index-records.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import {
  preflightPluginInstall,
  resolveInstalledClawHubPlugin,
} from "./plugin-install-preflight.js";

const tempDirs = createTempDirTracker();
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

describe("preflightPluginInstall", () => {
  it("reads a Gateway commit after the caller cached its earlier inventory", async () => {
    const stateDir = tempDirs.make("openclaw-claw-plugin-preflight-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await withPluginCache(createPluginCache(), async () => {
      expect(await loadInstalledPluginIndexInstallRecords()).toEqual({});
      withPluginCache(createPluginCache(), () =>
        writePersistedInstalledPluginIndexInstallRecordsSync(
          {
            audit: {
              source: "clawhub",
              clawhubPackage: "@acme/audit",
              resolvedVersion: "1.2.3",
              integrity: "sha256:committed",
            },
          },
          { stateDir, candidates: [] },
        ),
      );
      expect(await loadInstalledPluginIndexInstallRecords()).toEqual({});
      expect(
        await preflightPluginInstall({
          clawhubPackage: "@acme/audit",
          rawSpec: "clawhub:@acme/audit@1.2.3",
          expectedVersion: "1.2.3",
        }),
      ).toMatchObject({ ok: true, action: "reuse", installedId: "audit" });
      expect(await resolveInstalledClawHubPlugin({ clawhubPackage: "@acme/audit" })).toMatchObject({
        status: "found",
        record: { integrity: "sha256:committed" },
      });
    });
  });

  it("reuses an exact installed version", async () => {
    const result = await preflightPluginInstall({
      clawhubPackage: "@acme/audit",
      rawSpec: "clawhub:@acme/audit@1.2.3",
      expectedVersion: "1.2.3",
      loadInstallRecords: vi.fn().mockResolvedValue({
        audit: {
          source: "clawhub",
          clawhubPackage: "@acme/audit",
          resolvedVersion: "1.2.3",
          installedAt: "2026-07-17T00:00:00.000Z",
        },
      }),
    });
    expect(result).toMatchObject({
      ok: true,
      action: "reuse",
      installedVersion: "1.2.3",
      installedAt: "2026-07-17T00:00:00.000Z",
    });
  });

  it("rejects a different installed version", async () => {
    const result = await preflightPluginInstall({
      clawhubPackage: "@acme/audit",
      rawSpec: "clawhub:@acme/audit@1.2.3",
      expectedVersion: "1.2.3",
      loadInstallRecords: vi.fn().mockResolvedValue({
        audit: { source: "clawhub", clawhubPackage: "@acme/audit", resolvedVersion: "1.1.0" },
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      code: "plugin_version_conflict",
      installedVersion: "1.1.0",
    });
  });
});

describe("resolveInstalledClawHubPlugin", () => {
  it("returns the runtime plugin id for one ClawHub package", async () => {
    await expect(
      resolveInstalledClawHubPlugin({
        clawhubPackage: "@acme/audit",
        loadInstallRecords: vi.fn().mockResolvedValue({
          "audit-runtime": {
            source: "clawhub",
            clawhubPackage: "@acme/audit",
            resolvedVersion: "1.2.3",
          },
        }),
      }),
    ).resolves.toMatchObject({
      status: "found",
      pluginId: "audit-runtime",
      installedVersion: "1.2.3",
    });
  });

  it("reports ambiguous package identities instead of choosing one", async () => {
    await expect(
      resolveInstalledClawHubPlugin({
        clawhubPackage: "audit",
        loadInstallRecords: vi.fn().mockResolvedValue({
          first: { source: "clawhub", clawhubPackage: "audit", version: "1.0.0" },
          second: { source: "clawhub", clawhubPackage: "audit", version: "1.0.0" },
        }),
      }),
    ).resolves.toEqual({ status: "ambiguous", pluginIds: ["first", "second"] });
  });
});
