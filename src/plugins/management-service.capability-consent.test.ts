import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolvePluginArtifactDeclaredSurface } from "./capability-artifact.js";
import {
  createManagedPluginArtifactConsentHandler,
  resolvePluginCapabilityConsent,
  type PluginCapabilityConsentHandler,
} from "./capability-consent.js";
import { buildPluginCapabilitySummary, computeDeclaredSurfaceHash } from "./capability-summary.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { loadInstalledPluginIndexWithDiscovery } from "./installed-plugin-index.js";
import {
  configSnapshot,
  emptyMetadataSnapshot,
  metadataSnapshot,
} from "./management-service.test-helpers.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { collectPluginCapabilityConsentDiagnostics } from "./status-snapshot.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
  readConfig: vi.fn(),
  records: {} as Record<string, import("../config/types.plugins.js").PluginInstallRecord>,
  replaceConfig: vi.fn(),
  writeRecords: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: () => undefined,
  readConfigFileSnapshotForWrite: () => mocks.readConfig(),
  replaceConfigFile: (params: unknown) => mocks.replaceConfig(params),
}));

vi.mock("./install-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install-persistence.js")>()),
  resolveInstallConfigMutationPreflights: () => ({
    hookMutation: { mode: "allowed" },
    pluginMutation: { mode: "allowed" },
  }),
  selectInstallMutationWriteOptions: (writeOptions: unknown) => writeOptions,
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: async () => ({ ...mocks.records }),
  writePersistedInstalledPluginIndexInstallRecordsWithLease: async (
    records: Record<string, import("../config/types.plugins.js").PluginInstallRecord>,
    options: unknown,
  ) => {
    mocks.records = { ...records };
    mocks.writeRecords(records, options);
  },
}));

vi.mock("./plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (
    _options: unknown,
    run: (lease: {
      assertOwned: () => void;
      assertOwnedInTransaction: () => void;
      signal: AbortSignal;
      databasePath: string;
    }) => Promise<unknown>,
  ) =>
    run({
      assertOwned: () => undefined,
      assertOwnedInTransaction: () => undefined,
      signal: new AbortController().signal,
      databasePath: "/tmp/managed-capability-consent.sqlite",
    }),
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
  resolvePluginMetadataSnapshot: (...args: unknown[]) => mocks.metadata(...args),
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: (...args: unknown[]) =>
    mocks.officialCatalog(...args),
}));

const { clearManagedPluginOfficialCatalogCache } = await import("./management-catalog.js");
const { inspectManagedPlugin, listManagedPlugins } = await import("./management-service.js");
const { setManagedPluginEnabled } = await import("./management-mutations.js");

const trackedArtifactDirs: string[] = [];

function createConsentArtifact(pluginId = "community-plugin", providers: string[] = []): string {
  const rootDir = makeTrackedTempDir("managed-capability-consent", trackedArtifactDirs);
  writeConsentArtifact(rootDir, pluginId, providers);
  return rootDir;
}

function writeConsentArtifact(rootDir: string, pluginId: string, providers: string[] = []): void {
  createColdPluginFixture({
    rootDir,
    pluginId,
    manifest: {
      name: "Community Plugin",
      providers,
      channels: [],
      channelConfigs: {},
      providerAuthChoices: [],
    },
  });
}

function installRecord(overrides: Partial<PluginInstallRecord> = {}): PluginInstallRecord {
  return {
    source: "npm",
    installPath: overrides.installPath ?? createConsentArtifact(),
    integrity: "sha512-verified-artifact",
    ...overrides,
  };
}

function artifactReviewToken(record: PluginInstallRecord): string {
  if (!record.installPath) {
    throw new Error("test plugin must have a tracked artifact path");
  }
  return computeDeclaredSurfaceHash(resolvePluginArtifactDeclaredSurface(record.installPath));
}

function configureExternalPlugin(
  record: PluginInstallRecord,
  enabled = false,
): ReturnType<typeof metadataSnapshot> {
  mocks.records = { "community-plugin": record };
  const snapshot = metadataSnapshot({
    id: "community-plugin",
    name: "Community Plugin",
    enabled,
    origin: "global",
    installRecord: record,
  });
  if (record.installPath) {
    snapshot.index.plugins[0]!.rootDir = record.installPath;
    snapshot.byPluginId.get("community-plugin")!.rootDir = record.installPath;
  }
  mocks.metadata.mockImplementation(() => ({
    ...snapshot,
    index: { ...snapshot.index, installRecords: { ...mocks.records } },
  }));
  return snapshot;
}

describe("managed plugin capability consent", () => {
  afterEach(() => cleanupTrackedTempDirs(trackedArtifactDirs));

  beforeEach(() => {
    vi.clearAllMocks();
    clearManagedPluginOfficialCatalogCache();
    clearPluginMetadataLifecycleCaches();
    mocks.records = {};
    mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [] });
    mocks.readConfig.mockResolvedValue(configSnapshot());
  });

  it("exempts release-bundled plugins from durable capability acceptance", async () => {
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false }));

    await expect(
      resolvePluginCapabilityConsent({ config: {}, env: {}, pluginId: "workboard" }),
    ).resolves.toBeUndefined();
    expect(mocks.writeRecords).not.toHaveBeenCalled();
  });

  function officialArtifact() {
    const rootDir = makeTrackedTempDir("official-capability-consent", trackedArtifactDirs);
    createColdPluginFixture({
      rootDir,
      pluginId: "diffs",
      packageName: "@openclaw/diffs",
      manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
    });
    return rootDir;
  }

  const officialSources: PluginInstallRecord[] = [
    {
      source: "npm",
      spec: "@openclaw/diffs@1.0.0",
      resolvedName: "@openclaw/diffs",
      resolvedSpec: "@openclaw/diffs@1.0.0",
      integrity: "sha512-official-artifact",
    },
    {
      source: "clawhub",
      spec: "clawhub:@openclaw/diffs@1.0.0",
      clawhubPackage: "@openclaw/diffs",
      clawhubUrl: "https://clawhub.ai",
      clawhubChannel: "official",
      integrity: "sha256-official-artifact",
    },
  ];

  it.each(officialSources)(
    "installs verified official $source artifacts without recording operator acceptance",
    async (sourceRecord) => {
      const rootDir = officialArtifact();
      const onCapabilityConsent = vi.fn<PluginCapabilityConsentHandler>();
      const handler = createManagedPluginArtifactConsentHandler({
        config: {},
        source: sourceRecord.source,
        spec: sourceRecord.spec,
        onCapabilityConsent,
      });
      await expect(
        handler.onBeforePluginArtifactCommit({
          pluginId: "diffs",
          stagedArtifactDir: rootDir,
          mode: "install",
          sourceRecord,
        }),
      ).resolves.toBeUndefined();
      expect(onCapabilityConsent).not.toHaveBeenCalled();
      expect(handler.applyAcceptedSurface("diffs", sourceRecord)).toEqual(sourceRecord);
    },
  );

  it.each([
    { name: "unverified catalog name", sourceRecord: undefined },
    {
      name: "local npm archive",
      sourceRecord: { ...officialSources[0]!, artifactKind: "npm-pack" as const },
    },
    {
      name: "conflicting registry identity",
      sourceRecord: { ...officialSources[0]!, resolvedName: "@vendor/diffs" },
    },
    {
      name: "custom ClawHub server",
      sourceRecord: { ...officialSources[1]!, clawhubUrl: "https://plugins.example" },
    },
    {
      name: "community ClawHub release",
      sourceRecord: { ...officialSources[1]!, clawhubChannel: "community" as const },
    },
  ])("requires review for $name", async ({ sourceRecord }) => {
    const handler = createManagedPluginArtifactConsentHandler({
      config: {},
      source: sourceRecord?.source ?? "npm",
      spec: sourceRecord?.spec ?? "@openclaw/diffs",
    });
    await expect(
      handler.onBeforePluginArtifactCommit({
        pluginId: "diffs",
        stagedArtifactDir: officialArtifact(),
        mode: "install",
        sourceRecord,
      }),
    ).rejects.toMatchObject({ capabilityConsent: { pluginId: "diffs" } });
  });

  it("rechecks first-party package identity after the commit guard yields", async () => {
    const rootDir = officialArtifact();
    const handler = createManagedPluginArtifactConsentHandler({
      config: {},
      source: "npm",
      beforePersistentEffect: async () => {
        const packagePath = path.join(rootDir, "package.json");
        const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
        fs.writeFileSync(packagePath, JSON.stringify({ ...manifest, name: "@vendor/diffs" }));
      },
    });
    await expect(
      handler.onBeforePluginArtifactCommit({
        pluginId: "diffs",
        stagedArtifactDir: rootDir,
        mode: "install",
        sourceRecord: officialSources[0],
      }),
    ).rejects.toMatchObject({ capabilityConsent: { pluginId: "diffs" } });
  });

  it("does not carry a first-party exemption into an unverified fallback stage", async () => {
    const rootDir = officialArtifact();
    const handler = createManagedPluginArtifactConsentHandler({ config: {}, source: "npm" });
    const artifact = { pluginId: "diffs", stagedArtifactDir: rootDir, mode: "install" as const };
    await handler.onBeforePluginArtifactCommit({ ...artifact, sourceRecord: officialSources[0] });
    await expect(handler.onBeforePluginArtifactCommit(artifact)).rejects.toMatchObject({
      capabilityConsent: { pluginId: "diffs" },
    });
    expect(() => handler.applyAcceptedSurface("diffs", officialSources[0]!)).toThrow(
      "did not expose its verified artifact",
    );
  });

  it("enables and reports a verified official install without legacy acceptance", async () => {
    const rootDir = officialArtifact();
    const record = { ...officialSources[0]!, installPath: rootDir };
    const config = {
      plugins: { load: { paths: [rootDir] }, entries: { diffs: { enabled: true } } },
    };
    const env = {
      HOME: rootDir,
      OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
    const { index, manifestRegistry } = loadInstalledPluginIndexWithDiscovery({
      config,
      env,
      installRecords: { diffs: record },
    });
    const byPluginId = new Map(manifestRegistry.plugins.map((manifest) => [manifest.id, manifest]));
    const metadata = {
      index,
      byPluginId,
      plugins: manifestRegistry.plugins,
      diagnostics: manifestRegistry.diagnostics,
      normalizePluginId: (pluginId: string) => pluginId,
    };
    mocks.records = { diffs: record };
    mocks.metadata.mockReturnValue(metadata);
    await expect(
      resolvePluginCapabilityConsent({ config, env, pluginId: "diffs" }),
    ).resolves.toBeUndefined();
    expect(mocks.writeRecords).not.toHaveBeenCalled();
    expect(collectPluginCapabilityConsentDiagnostics({ index, manifests: byPluginId })).toEqual([]);
    const catalog = await listManagedPlugins({ config, env });
    expect(catalog.diagnostics).not.toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("requires capability consent") }),
    );
  });

  it("rejects enabling an unaccepted plugin with only its reviewed-surface challenge", async () => {
    const record = installRecord();
    const snapshot = configureExternalPlugin(record);
    const manifest = snapshot.byPluginId.get("community-plugin")!;
    manifest.providers.push("community-provider");
    writeConsentArtifact(record.installPath!, "community-plugin", ["community-provider"]);

    await expect(
      setManagedPluginEnabled({ pluginId: "community-plugin", enabled: true, env: {} }),
    ).rejects.toMatchObject({
      capabilityConsent: {
        pluginId: "community-plugin",
        reviewToken: artifactReviewToken(record),
      },
      message: expect.stringContaining("--accept-capabilities"),
    });
    expect(mocks.replaceConfig).not.toHaveBeenCalled();
  });

  it.each(["supplied", "interactive"] as const)(
    "persists only a matching %s acknowledgment and reuses it",
    async (mode) => {
      const record = installRecord();
      configureExternalPlugin(record);
      const reviewToken = artifactReviewToken(record);

      const onCapabilityConsent = vi.fn<PluginCapabilityConsentHandler>(async (review) => ({
        reviewToken: review.reviewToken,
      }));
      await resolvePluginCapabilityConsent({
        config: {},
        env: {},
        pluginId: "community-plugin",
        ...(mode === "supplied" ? { acknowledge: { reviewToken } } : { onCapabilityConsent }),
      });

      const persisted = mocks.records["community-plugin"]!;
      expect(persisted).toMatchObject({
        acceptedSurfaceHash: reviewToken,
        acceptedSurfaceIntegrity: "sha512-verified-artifact",
        acceptedSurfaceAt: expect.any(String),
      });
      expect(mocks.writeRecords).toHaveBeenCalledWith(
        expect.objectContaining({ "community-plugin": persisted }),
        expect.objectContaining({ config: {}, env: {}, lease: expect.any(Object) }),
      );

      await expect(
        resolvePluginCapabilityConsent({
          config: {},
          env: {},
          pluginId: "community-plugin",
          onCapabilityConsent,
        }),
      ).resolves.toBeUndefined();
      expect(mocks.writeRecords).toHaveBeenCalledTimes(1);
      expect(onCapabilityConsent).toHaveBeenCalledTimes(mode === "interactive" ? 1 : 0);
    },
  );

  it("inspects the actual configured override and its package siblings before accepting either", async () => {
    const record = installRecord();
    const rootDir = record.installPath!;
    writeConsentArtifact(rootDir, "community-plugin", ["package-provider"]);
    for (const [directory, entry, provider] of [
      ["a", "first", "configured-provider"],
      ["b", "second", "ignored-provider"],
    ] as const) {
      const childDir = path.join(rootDir, directory);
      fs.mkdirSync(childDir);
      writeConsentArtifact(childDir, `${entry}-plugin`, [provider]);
      fs.writeFileSync(path.join(childDir, `${entry}.cjs`), "module.exports = {};");
    }
    fs.writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({
        name: "community-plugin",
        openclaw: { extensions: ["./a/first.cjs", "./b/second.cjs"] },
      }),
    );
    const config = {
      plugins: {
        load: { paths: [path.join(rootDir, "a/first.cjs")] },
        entries: {
          "first-plugin": { enabled: false },
          "community-plugin/second": { enabled: false },
        },
      },
    };
    const env = {
      HOME: rootDir,
      OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
    mocks.records = { "community-plugin": record };
    const { index, manifestRegistry } = loadInstalledPluginIndexWithDiscovery({
      config,
      env,
      installRecords: mocks.records,
    });
    const manifests = new Map(manifestRegistry.plugins.map((manifest) => [manifest.id, manifest]));
    mocks.metadata.mockImplementation(() => ({
      index: { ...index, installRecords: { ...mocks.records } },
      byPluginId: manifests,
      plugins: manifestRegistry.plugins,
      diagnostics: manifestRegistry.diagnostics,
      normalizePluginId: (pluginId: string) => pluginId,
    }));

    const inspections = await Promise.all(
      ["first-plugin", "community-plugin/second"].map((pluginId) =>
        inspectManagedPlugin({ config, env, pluginId }),
      ),
    );
    const declared = resolvePluginArtifactDeclaredSurface(rootDir, env, { config });
    expect(declared.providers).toEqual(["configured-provider", "package-provider"]);
    const reviewToken = computeDeclaredSurfaceHash(declared);

    for (const inspection of inspections) {
      expect(inspection.declared).toEqual(declared);
      expect(inspection.reviewToken).toBe(reviewToken);
      await expect(
        resolvePluginCapabilityConsent({
          config,
          env,
          pluginId: inspection.plugin.id,
          acknowledge: { reviewToken: inspection.reviewToken },
        }),
      ).resolves.toBeUndefined();
    }
    expect(mocks.records["community-plugin"]).toMatchObject({
      acceptedSurface: { providers: ["configured-provider", "package-provider"] },
      acceptedSurfaceHash: reviewToken,
    });
    expect(mocks.writeRecords).toHaveBeenCalledTimes(1);

    manifests.delete("community-plugin/second");
    await expect(inspectManagedPlugin({ config, env, pluginId: "first-plugin" })).rejects.toThrow(
      "incomplete manifest metadata",
    );
  });

  it("rejects stale approval after the installed artifact gains an unreviewed privilege", async () => {
    const record = installRecord();
    const snapshot = configureExternalPlugin(record);
    const staleReviewToken = artifactReviewToken(record);
    snapshot.byPluginId.get("community-plugin")!.providers.push("new-provider");
    writeConsentArtifact(record.installPath!, "community-plugin", ["new-provider"]);
    const currentReviewToken = artifactReviewToken(record);

    expect(currentReviewToken).not.toBe(staleReviewToken);
    await expect(
      resolvePluginCapabilityConsent({
        config: {},
        env: {},
        pluginId: "community-plugin",
        acknowledge: { reviewToken: staleReviewToken },
      }),
    ).rejects.toMatchObject({
      capabilityConsent: { pluginId: "community-plugin", reviewToken: currentReviewToken },
    });
    expect(mocks.writeRecords).not.toHaveBeenCalled();
  });

  it("rechecks the installed artifact after interactive consent yields", async () => {
    const record = installRecord();
    configureExternalPlugin(record);
    const reviewedToken = artifactReviewToken(record);
    const onCapabilityConsent = vi.fn<PluginCapabilityConsentHandler>(async (review) => {
      await Promise.resolve();
      writeConsentArtifact(record.installPath!, "community-plugin", ["unreviewed-provider"]);
      return { reviewToken: review.reviewToken };
    });

    await expect(
      resolvePluginCapabilityConsent({
        config: {},
        env: {},
        pluginId: "community-plugin",
        onCapabilityConsent,
      }),
    ).rejects.toMatchObject({
      capabilityConsent: { pluginId: "community-plugin" },
    });
    expect(onCapabilityConsent).toHaveBeenCalledWith(
      expect.objectContaining({ reviewToken: reviewedToken }),
    );
    expect(mocks.writeRecords).not.toHaveBeenCalled();
    const inspection = await inspectManagedPlugin({
      config: {},
      env: {},
      pluginId: "community-plugin",
    });
    expect(inspection.declared.providers).toEqual(["unreviewed-provider"]);
    expect(inspection.reviewToken).not.toBe(reviewedToken);
  });

  it("verifies a persisted home-relative install path against its actual artifact", async () => {
    const artifactDir = createConsentArtifact();
    const env = { HOME: path.dirname(artifactDir) };
    const installPath = `~/${path.basename(artifactDir)}`;
    const record = installRecord({ installPath });
    const snapshot = configureExternalPlugin(record);
    snapshot.index.plugins[0]!.rootDir = artifactDir;
    snapshot.byPluginId.get("community-plugin")!.rootDir = artifactDir;
    const reviewToken = computeDeclaredSurfaceHash(
      resolvePluginArtifactDeclaredSurface(artifactDir),
    );

    await resolvePluginCapabilityConsent({
      config: {},
      env,
      pluginId: "community-plugin",
      acknowledge: { reviewToken },
    });

    expect(mocks.records["community-plugin"]).toMatchObject({
      installPath,
      acceptedSurfaceHash: reviewToken,
    });
  });

  it("reports newly declared capabilities when the installed manifest outgrows acceptance", async () => {
    const previous = buildPluginCapabilitySummary({ manifest: {}, origin: "global" }).declared;
    const snapshot = configureExternalPlugin(
      installRecord({
        acceptedSurface: previous,
        acceptedSurfaceHash: computeDeclaredSurfaceHash(previous),
        acceptedSurfaceIntegrity: "sha512-verified-artifact",
        acceptedSurfaceAt: "2026-08-25T00:00:00.000Z",
      }),
    );
    snapshot.byPluginId.get("community-plugin")!.providers.push("new-provider");
    writeConsentArtifact(mocks.records["community-plugin"]!.installPath!, "community-plugin", [
      "new-provider",
    ]);

    await expect(
      resolvePluginCapabilityConsent({ config: {}, env: {}, pluginId: "community-plugin" }),
    ).rejects.toMatchObject({
      capabilityConsent: {
        widened: { providers: ["new-provider"] },
        acceptedAt: "2026-08-25T00:00:00.000Z",
      },
    });
  });

  it("fails closed when an installed plugin has ambiguous package ownership", async () => {
    const snapshot = configureExternalPlugin(installRecord());
    recordInstalledPluginIndexInstallOwner(snapshot.index.plugins[0]!, undefined, true);

    await expect(
      resolvePluginCapabilityConsent({ config: {}, env: {}, pluginId: "community-plugin" }),
    ).rejects.toThrow("ambiguous package ownership");
    expect(mocks.writeRecords).not.toHaveBeenCalled();
  });

  it("keeps untracked development plugins exempt without exempting ambiguous owners", async () => {
    const snapshot = metadataSnapshot({
      id: "community-plugin",
      name: "Community Plugin",
      enabled: false,
      origin: "global",
    });
    delete snapshot.index.plugins[0]!.installOwner;
    snapshot.index.installRecords = {};
    mocks.metadata.mockReturnValue(snapshot);

    await expect(
      resolvePluginCapabilityConsent({ config: {}, env: {}, pluginId: "community-plugin" }),
    ).resolves.toBeUndefined();
    expect(mocks.writeRecords).not.toHaveBeenCalled();
  });

  it("retains a rejected community install for inspection and refreshes stale reviews", async () => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    const artifactDir = createConsentArtifact();
    const firstReviewToken = computeDeclaredSurfaceHash(
      resolvePluginArtifactDeclaredSurface(artifactDir),
    );
    const firstHandler = createManagedPluginArtifactConsentHandler({
      config: {},
      source: "npm",
      spec: "community-plugin",
    });

    await expect(
      firstHandler.onBeforePluginArtifactCommit({
        pluginId: "community-plugin",
        stagedArtifactDir: artifactDir,
        mode: "install",
      }),
    ).rejects.toMatchObject({
      capabilityConsent: { pluginId: "community-plugin", reviewToken: firstReviewToken },
    });

    const firstInspection = await inspectManagedPlugin({
      config: {},
      env: {},
      pluginId: "community-plugin",
    });
    expect(firstInspection).toMatchObject({
      plugin: { id: "community-plugin", name: "Community Plugin", installed: false },
      declared: { providers: [] },
      reviewToken: firstReviewToken,
    });

    writeConsentArtifact(artifactDir, "community-plugin", ["unreviewed-provider"]);
    const refreshedToken = computeDeclaredSurfaceHash(
      resolvePluginArtifactDeclaredSurface(artifactDir),
    );
    const staleHandler = createManagedPluginArtifactConsentHandler({
      config: {},
      source: "npm",
      spec: "community-plugin",
      acknowledgeCapabilities: { reviewToken: firstReviewToken },
    });

    await expect(
      staleHandler.onBeforePluginArtifactCommit({
        pluginId: "community-plugin",
        stagedArtifactDir: artifactDir,
        mode: "install",
      }),
    ).rejects.toMatchObject({
      capabilityConsent: { pluginId: "community-plugin", reviewToken: refreshedToken },
    });
    await expect(
      inspectManagedPlugin({ config: {}, env: {}, pluginId: "community-plugin" }),
    ).resolves.toMatchObject({
      declared: { providers: ["unreviewed-provider"] },
      reviewToken: refreshedToken,
    });
  });
});
