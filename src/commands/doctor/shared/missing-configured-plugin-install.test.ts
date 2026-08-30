// Missing configured plugin install tests cover doctor diagnostics for absent plugin installs.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig, PluginsConfig } from "../../../config/types.js";
import { resolveRegistryUpdateChannel } from "../../../infra/update-channels.js";
import type { PluginCapabilityConsentHandler } from "../../../plugins/capability-consent.js";
import { computeDeclaredSurfaceHash } from "../../../plugins/capability-summary.js";
import {
  resolveClawHubInstallSpecsForUpdateChannel,
  resolveNpmInstallSpecsForUpdateChannel,
} from "../../../plugins/install-channel-specs.js";
import type { PluginInstallArtifactConsentHandler } from "../../../plugins/install-types.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../../plugins/installed-plugin-index-policy.js";
import { hasRetainedManagedNpmInstallMarker } from "../../../plugins/managed-npm-retention.js";
import type { BundledProviderPolicySurface } from "../../../plugins/provider-policy-surface.js";
import { createColdPluginFixture } from "../../../plugins/test-helpers/cold-plugin-fixtures.js";
import { VERSION } from "../../../version.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import {
  brokenPluginSnapshot,
  channelPluginEntry,
  installedRecords,
  officialPluginEntry,
  officialWebSearchPluginEntry,
  successfulInstall,
  successfulUpdate,
} from "./missing-configured-plugin-install.test-helpers.js";

function expectedNpmInstallSpec(spec: string): string {
  return resolveNpmInstallSpecsForUpdateChannel({
    spec,
    updateChannel: resolveRegistryUpdateChannel({ currentVersion: VERSION }),
  }).installSpec;
}

function expectedClawHubInstallSpec(spec: string): string {
  return resolveClawHubInstallSpecsForUpdateChannel({
    spec,
    updateChannel: resolveRegistryUpdateChannel({ currentVersion: VERSION }),
  }).installSpec;
}

function expectedCodexInstallSpec(): string {
  return resolveNpmInstallSpecsForUpdateChannel({
    spec: "@openclaw/codex",
    updateChannel: resolveRegistryUpdateChannel({ currentVersion: VERSION }),
    officialPackageName: "@openclaw/codex",
    coreVersion: VERSION,
    versionBoundToCore: true,
  }).installSpec;
}

function currentOpenClawReleaseBase(): string {
  return VERSION.replace(/-(?:alpha|beta)\.[1-9]\d*$/u, "");
}

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

type ProspectiveNpmArtifactPrecommitHandler = (
  request: Parameters<PluginInstallArtifactConsentHandler>[0] & {
    npmResolution: { version?: string };
  },
) => Promise<void>;

type MockNpmInstallCallbacks = {
  onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
  onBeforeNpmPluginArtifactCommit?: ProspectiveNpmArtifactPrecommitHandler;
};

async function invokeMockNpmInstallPrecommit(params: {
  callbacks: MockNpmInstallCallbacks;
  artifact: Parameters<PluginInstallArtifactConsentHandler>[0];
  npmResolution: { version?: string };
}): Promise<void> {
  await params.callbacks.onBeforeNpmPluginArtifactCommit?.({
    ...params.artifact,
    npmResolution: params.npmResolution,
  });
  await params.callbacks.onBeforePluginArtifactCommit?.(params.artifact);
}

const mocks = vi.hoisted(() => ({
  installPluginFromClawHub: vi.fn(),
  installPluginFromNpmSpec: vi.fn(),
  listChannelPluginCatalogEntries: vi.fn(),
  listOfficialExternalChannelEnvVars: vi.fn(() => []),
  listOfficialExternalPluginCatalogEntries: vi.fn(),
  loadInstalledPluginIndex: vi.fn(),
  loadInstalledPluginIndexInstallRecords: vi.fn(),
  loadPluginMetadataSnapshot: vi.fn(),
  getOfficialExternalPluginCatalogManifest: vi.fn(
    (entry: { openclaw?: unknown }) => entry.openclaw,
  ),
  resolveOfficialExternalPluginId: vi.fn((entry: { id?: string }) => entry.id),
  resolveOfficialExternalPluginInstall: vi.fn(
    (entry: { install?: unknown }) => entry.install ?? null,
  ),
  resolveOfficialExternalPluginLabel: vi.fn(
    (entry: { label?: string; id?: string }) => entry.label ?? entry.id ?? "plugin",
  ),
  resolveOfficialExternalProviderContractPluginIds: vi.fn(),
  resolveOfficialExternalProviderPluginIds: vi.fn(),
  resolveOfficialExternalProviderPluginIdsForEnv: vi.fn(),
  resolveOfficialExternalWebProviderContractPluginIdsForEnv: vi.fn(),
  resolveDirectBundledProviderPolicySurface: vi.fn(
    (pluginId: string): BundledProviderPolicySurface | null =>
      pluginId === "openai"
        ? {
            normalizeModelCatalogId: ({ modelId }) => modelId,
            resolveModelRoutes: ({ requestTransportOverrides }) => ({
              kind: "routes",
              routes: [
                {
                  api: "openai-responses",
                  baseUrl: "https://api.openai.com/v1",
                  authRequirement: "api-key",
                  requestTransportOverrides: requestTransportOverrides ?? "none",
                  runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
                },
              ],
              defaultRuntimeId: "codex",
            }),
          }
        : null,
  ),
  resolveDefaultPluginExtensionsDir: vi.fn(() => "/tmp/openclaw-plugins"),
  resolveDefaultPluginNpmDir: vi.fn(() => "/tmp/openclaw-npm"),
  resolvePluginNpmProjectsDir: vi.fn((npmDir = "/tmp/openclaw-npm") =>
    path.join(npmDir, "projects"),
  ),
  resolvePluginNpmPackageDir: vi.fn(
    ({ npmDir, packageName }: { npmDir?: string; packageName: string }) =>
      path.join(
        npmDir ?? "/tmp/openclaw-npm",
        "projects",
        packageName.replace(/[^a-zA-Z0-9._-]+/g, "-"),
        "node_modules",
        ...packageName.split("/"),
      ),
  ),
  resolvePluginInstallDir: vi.fn(
    (pluginId: string, extensionsDir = "/tmp/openclaw-plugins") => `${extensionsDir}/${pluginId}`,
  ),
  validatePluginId: vi.fn(() => null),
  resolveProviderInstallCatalogEntries: vi.fn(),
  updateNpmInstalledPlugins: vi.fn(),
  writePersistedInstalledPluginIndexInstallRecords: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const prepareManagedPluginArtifactConsentHandler = vi.hoisted(() =>
  vi.fn<
    typeof import("../../../plugins/capability-consent.js").prepareManagedPluginArtifactConsentHandler
  >(),
);
vi.mock("../../../plugins/capability-consent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/capability-consent.js")>()),
  prepareManagedPluginArtifactConsentHandler,
}));

function mockCurrentBundledPlugin(pluginId: string, packageName: string): void {
  mocks.loadInstalledPluginIndex.mockReturnValue({
    plugins: [{ pluginId, origin: "bundled", packageName }],
    diagnostics: [],
    installRecords: {},
  });
}

function writeLegacyNpmDeclarationStub(params: {
  pluginDir: string;
  pluginId: string;
  npmSpec: string;
}): void {
  fs.mkdirSync(params.pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(params.pluginDir, "openclaw.extension.json"),
    JSON.stringify({
      name: params.pluginId,
      type: "npm",
      npmSpec: params.npmSpec,
    }),
    "utf8",
  );
}

async function repairConfiguredPlugins(
  cfg: OpenClawConfig,
  env: Record<string, string | undefined> = {},
) {
  const { repairMissingConfiguredPluginInstalls } =
    await import("./missing-configured-plugin-install.js");
  return repairMissingConfiguredPluginInstalls({ cfg, env });
}

function useManifestCatalogResolvers(): void {
  mocks.resolveOfficialExternalPluginId.mockImplementation(
    (entry: { id?: string; openclaw?: { plugin?: { id?: string } } }) =>
      entry.openclaw?.plugin?.id ?? entry.id,
  );
  mocks.resolveOfficialExternalPluginInstall.mockImplementation(
    (entry: { install?: unknown; openclaw?: { install?: unknown } }) =>
      entry.openclaw?.install ?? entry.install ?? null,
  );
  mocks.resolveOfficialExternalPluginLabel.mockImplementation(
    (entry: { label?: string; openclaw?: { plugin?: { label?: string } } }) =>
      entry.openclaw?.plugin?.label ?? entry.label ?? "plugin",
  );
}

function mockBrokenBraveInstall(
  installDir: string,
  recordOverrides: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const records = installedRecords("brave", {
    installPath: installDir,
    ...recordOverrides,
  });
  mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
  mocks.loadPluginMetadataSnapshot.mockReturnValue(brokenPluginSnapshot("brave"));
  mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
    officialWebSearchPluginEntry({
      id: "brave",
      npmSpec: "@openclaw/brave-plugin",
      envVar: "BRAVE_API_KEY",
      label: "Brave",
      providerLabel: "Brave Search",
    }),
  ]);
  return records;
}

vi.mock("../../../channels/plugins/catalog.js", () => ({
  listRawChannelPluginCatalogEntries: mocks.listChannelPluginCatalogEntries,
}));

vi.mock("../../../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: mocks.loadInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords:
    mocks.writePersistedInstalledPluginIndexInstallRecords,
}));

vi.mock("../../../plugins/installed-plugin-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/installed-plugin-index.js")>()),
  loadInstalledPluginIndex: mocks.loadInstalledPluginIndex,
}));

vi.mock("../../../plugins/install-paths.js", () => ({
  resolveDefaultPluginExtensionsDir: mocks.resolveDefaultPluginExtensionsDir,
  resolveDefaultPluginNpmDir: mocks.resolveDefaultPluginNpmDir,
  resolvePluginNpmProjectsDir: mocks.resolvePluginNpmProjectsDir,
  resolvePluginNpmPackageDir: mocks.resolvePluginNpmPackageDir,
  resolvePluginInstallDir: mocks.resolvePluginInstallDir,
  validatePluginId: mocks.validatePluginId,
}));

vi.mock("../../../plugins/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/install.js")>()),
  installPluginFromNpmSpec: mocks.installPluginFromNpmSpec,
}));

vi.mock("../../../plugins/clawhub.js", () => ({
  CLAWHUB_INSTALL_ERROR_CODE: {
    PACKAGE_NOT_FOUND: "package_not_found",
    VERSION_NOT_FOUND: "version_not_found",
    ARTIFACT_UNAVAILABLE: "artifact_unavailable",
    ARTIFACT_DOWNLOAD_UNAVAILABLE: "artifact_download_unavailable",
    CLAWHUB_DOWNLOAD_BLOCKED: "clawhub_download_blocked",
    CLAWHUB_SECURITY_UNAVAILABLE: "clawhub_security_unavailable",
  },
  installPluginFromClawHub: mocks.installPluginFromClawHub,
}));

vi.mock("../../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
}));

vi.mock("../../../plugins/manifest-contract-eligibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/manifest-contract-eligibility.js")>()),
  loadManifestMetadataSnapshot: mocks.loadPluginMetadataSnapshot,
}));

vi.mock("../../../plugins/doctor-contract-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/doctor-contract-registry.js")>()),
  // Plugin-owned compatibility is outside this install-repair suite. Avoid scanning
  // the real plugin registry when the legacy-config fixture reaches that follow-up pass.
  applyPluginDoctorCompatibilityMigrations: (cfg: OpenClawConfig) => ({
    config: cfg,
    changes: [],
  }),
}));

vi.mock("../../../plugins/official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../plugins/official-external-plugin-catalog.js")
  >()),
  getOfficialExternalPluginCatalogManifest: mocks.getOfficialExternalPluginCatalogManifest,
  listOfficialExternalChannelEnvVars: mocks.listOfficialExternalChannelEnvVars,
  listOfficialExternalPluginCatalogEntries: mocks.listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId: mocks.resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall: mocks.resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLabel: mocks.resolveOfficialExternalPluginLabel,
  resolveOfficialExternalProviderContractPluginIds:
    mocks.resolveOfficialExternalProviderContractPluginIds,
  resolveOfficialExternalProviderPluginIds: mocks.resolveOfficialExternalProviderPluginIds,
  resolveOfficialExternalProviderPluginIdsForEnv:
    mocks.resolveOfficialExternalProviderPluginIdsForEnv,
  resolveOfficialExternalWebProviderContractPluginIdsForEnv:
    mocks.resolveOfficialExternalWebProviderContractPluginIdsForEnv,
}));

vi.mock("../../../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntries: mocks.resolveProviderInstallCatalogEntries,
}));

vi.mock("../../../plugins/provider-policy-surface.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/provider-policy-surface.js")>()),
  // This suite owns install repair. Provider artifact loading and route policy
  // have dedicated tests, so keep the OpenAI runtime-selection seam in memory.
  resolveDirectBundledProviderPolicySurface: mocks.resolveDirectBundledProviderPolicySurface,
}));

vi.mock("../../../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../plugins/doctor-contract-registry.js")>();
  return {
    ...actual,
    // Plugin-owned compatibility discovery has its own coverage. Keep this
    // install-repair suite focused and avoid scanning every source plugin.
    applyPluginDoctorCompatibilityMigrations: (cfg: OpenClawConfig) => ({
      config: cfg,
      changes: [],
    }),
  };
});

vi.mock("../../../plugins/update.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../plugins/update.js")>();
  return {
    ...actual,
    updateNpmInstalledPlugins: mocks.updateNpmInstalledPlugins,
  };
});

describe("repairMissingConfiguredPluginInstalls", () => {
  it.each(["legacy", "accepted", "missing", "damaged", "stale-descriptor", "disabled"] as const)(
    "preserves a %s installed artifact when replacement capability consent is pending",
    async (previousState) => {
      const actual = await vi.importActual<typeof import("../../../plugins/capability-consent.js")>(
        "../../../plugins/capability-consent.js",
      );
      prepareManagedPluginArtifactConsentHandler.mockImplementation(
        actual.prepareManagedPluginArtifactConsentHandler,
      );
      const installDir = tempDirs.make("openclaw-doctor-retained-consent-");
      const stageDir = tempDirs.make("openclaw-doctor-staged-consent-");
      const stateDir = tempDirs.make("openclaw-doctor-consent-state-");
      for (const [rootDir, widened] of [
        [installDir, false],
        [stageDir, true],
      ] as const) {
        createColdPluginFixture({
          rootDir,
          pluginId: "codex",
          packageName: "@openclaw/codex",
          packageVersion: "2026.5.6",
          manifest: {
            contracts: { tools: widened ? ["fixture.read", "fixture.write"] : ["fixture.read"] },
          },
        });
      }
      const originalManifest = fs.readFileSync(
        path.join(installDir, "openclaw.plugin.json"),
        "utf8",
      );
      const records = installedRecords("codex", {
        spec: "@openclaw/codex",
        resolvedSpec: "@openclaw/codex@2026.5.6",
        resolvedVersion: "2026.5.6",
        integrity: "sha512-previous",
        installPath: installDir,
        ...(previousState === "accepted"
          ? {
              acceptedSurface: actual.resolvePluginArtifactDeclaredSurface(installDir),
              acceptedSurfaceHash: computeDeclaredSurfaceHash(
                actual.resolvePluginArtifactDeclaredSurface(installDir),
              ),
              acceptedSurfaceAt: "2026-01-01T00:00:00.000Z",
              acceptedSurfaceIntegrity: "sha512-previous",
            }
          : {}),
      });
      if (previousState === "missing") {
        fs.rmSync(path.join(installDir, "package.json"));
      } else if (previousState === "damaged") {
        fs.rmSync(path.join(installDir, "index.cjs"));
      }
      const originalRecords = structuredClone(records);
      const originalFiles = fs.readdirSync(installDir).map((file) => ({
        file,
        bytes: fs.readFileSync(path.join(installDir, file)),
      }));
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      const pluginMetadata = {
        id: "codex",
        packageName: "@openclaw/codex",
        packageVersion: "2026.5.6",
        channels: ["codex"],
        origin: "global" as const,
        rootDir: installDir,
      };
      mocks.loadPluginMetadataSnapshot.mockReturnValue({
        index: { plugins: [] },
        plugins: [pluginMetadata],
        diagnostics:
          previousState === "damaged"
            ? brokenPluginSnapshot("codex").diagnostics
            : previousState === "stale-descriptor"
              ? [{ level: "error", pluginId: "codex", message: "without channelConfigs metadata" }]
              : [],
        byPluginId: new Map([["codex", pluginMetadata]]),
      });
      mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
        officialPluginEntry({ id: "codex", npmSpec: "@openclaw/codex" }),
      ]);
      let committed = false;
      mocks.installPluginFromNpmSpec.mockImplementation(
        async (params: { onBeforePluginArtifactCommit: PluginInstallArtifactConsentHandler }) => {
          await params.onBeforePluginArtifactCommit({
            pluginId: "codex",
            stagedArtifactDir: stageDir,
            mode: "update",
          });
          committed = true;
          return successfulInstall({
            pluginId: "codex",
            npmSpec: "@openclaw/codex",
            targetDir: stageDir,
          });
        },
      );
      const cfg: OpenClawConfig = {
        plugins: { entries: { codex: { enabled: previousState !== "disabled" } } },
      };
      const { repairMissingPluginInstallsForIds } =
        await import("./missing-configured-plugin-install.js");
      const result = await repairMissingPluginInstallsForIds({
        cfg,
        pluginIds: ["codex"],
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(committed).toBe(false);
      expect(fs.readFileSync(path.join(installDir, "openclaw.plugin.json"), "utf8")).toBe(
        originalManifest,
      );
      expect(result.records).toBe(records);
      expect(result.records).toEqual(originalRecords);
      for (const { file, bytes } of originalFiles) {
        expect(fs.readFileSync(path.join(installDir, file))).toEqual(bytes);
      }
      expect(result.failedPluginIds).toEqual(["codex"]);
      expect(result.repairedPluginIds).toBeUndefined();
      expect(result.pluginInventoryChanged).toBeUndefined();
      expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
      expect(cfg.plugins?.entries?.codex?.enabled).toBe(previousState !== "disabled");
      if (previousState === "legacy" || previousState === "accepted") {
        expect(result.warnings).toEqual([]);
        expect(result.notices).toEqual([expect.stringContaining("--accept-capabilities")]);
      } else {
        expect(result.warnings).toEqual([expect.stringContaining("--accept-capabilities")]);
        expect(result.notices).toBeUndefined();
      }
    },
  );

  it.each([false, true])(
    "preserves refused repair records with a successful sibling=%s",
    async (siblingSucceeded) => {
      const records = installedRecords("demo", {
        spec: "@example/demo",
        resolvedSpec: "@example/demo@1.0.0",
        resolvedVersion: "1.0.0",
        installPath: path.join(tempDirs.make("openclaw-doctor-missing-consent-"), "missing"),
        integrity: "sha512-previous",
      });
      const updatedSibling = {
        source: "npm",
        spec: "@example/sibling",
        version: "2.0.0",
        installPath: tempDirs.make("openclaw-doctor-sibling-"),
      };
      if (siblingSucceeded) {
        records.sibling = { ...updatedSibling, version: "1.0.0" };
      }
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mocks.updateNpmInstalledPlugins.mockImplementation(
        async ({ config }: { config: OpenClawConfig }) => ({
          config: siblingSucceeded
            ? {
                ...config,
                plugins: {
                  ...config.plugins,
                  installs: { ...config.plugins?.installs, sibling: updatedSibling },
                },
              }
            : config,
          changed: siblingSucceeded,
          outcomes: [
            ...(siblingSucceeded
              ? [{ pluginId: "sibling", status: "updated", message: "Updated sibling." }]
              : []),
            {
              pluginId: "demo",
              status: "error",
              code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
              message: "Review replacement capabilities.",
            },
          ],
        }),
      );

      const result = await repairConfiguredPlugins({
        plugins: { entries: { demo: { enabled: true }, sibling: { enabled: true } } },
      });

      expect(result.records.demo).toBe(records.demo);
      expect(result.records).toEqual(
        siblingSucceeded ? { ...records, sibling: updatedSibling } : records,
      );
      expect(result.warnings).toEqual(["Review replacement capabilities."]);
      expect(result.notices).toBeUndefined();
      if (siblingSucceeded) {
        expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
          result.records,
          expect.any(Object),
        );
      } else {
        expect(result.records).toBe(records);
        expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
      }
    },
  );

  it.each(
    (["npm", "npm-retry", "clawhub", "adopt"] as const).flatMap((source) =>
      [false, true].map((accepted) => ({ source, accepted })),
    ),
  )(
    "reviews doctor $source artifact capabilities before publication, accepted=$accepted",
    async ({ source, accepted }) => {
      const actual = await vi.importActual<typeof import("../../../plugins/capability-consent.js")>(
        "../../../plugins/capability-consent.js",
      );
      prepareManagedPluginArtifactConsentHandler.mockImplementation(
        actual.prepareManagedPluginArtifactConsentHandler,
      );
      const root = tempDirs.make("openclaw-doctor-consent-");
      const npmRoot = path.join(root, "npm");
      const artifactDir =
        source === "adopt"
          ? path.join(npmRoot, "node_modules", "@example", "matrix")
          : path.join(root, "artifact");
      fs.mkdirSync(artifactDir, { recursive: true });
      const fixture = createColdPluginFixture({
        rootDir: artifactDir,
        pluginId: "matrix",
        packageName: "@example/matrix",
        manifest: { contracts: { tools: ["matrix.write"] } },
      });
      mocks.resolveDefaultPluginNpmDir.mockReturnValue(npmRoot);
      mocks.resolveDefaultPluginExtensionsDir.mockReturnValue(path.join(root, "extensions"));
      mocks.listChannelPluginCatalogEntries.mockReturnValue([
        {
          id: "matrix",
          pluginId: "matrix",
          meta: { label: "Matrix" },
          install:
            source === "clawhub"
              ? { clawhubSpec: "clawhub:@example/matrix@1.0.0" }
              : { npmSpec: "@example/matrix@1.0.0", defaultChoice: "npm" },
        },
      ]);
      let committed = false;
      const install = async (params: {
        onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
      }) => {
        await params.onBeforePluginArtifactCommit?.({
          pluginId: "matrix",
          stagedArtifactDir: artifactDir,
          mode: "install",
        });
        committed = true;
        return {
          ...successfulInstall({
            pluginId: "matrix",
            npmSpec: "@example/matrix",
            version: "1.0.0",
            targetDir: artifactDir,
          }),
          clawhub: {
            source: "clawhub",
            clawhubPackage: "@example/matrix",
            integrity: "sha256-matrix",
          },
        };
      };
      if (source === "npm-retry") {
        mocks.installPluginFromNpmSpec.mockResolvedValueOnce({
          ok: false,
          error: `plugin already exists: ${artifactDir}`,
        });
      }
      mocks.installPluginFromNpmSpec.mockImplementation(install);
      mocks.installPluginFromClawHub.mockImplementation(install);
      const consent = vi.fn<PluginCapabilityConsentHandler>(async (review) => ({
        reviewToken: review.reviewToken,
      }));
      const cfg: OpenClawConfig = { plugins: { entries: { matrix: { enabled: true } } } };
      const { repairMissingConfiguredPluginInstalls } =
        await import("./missing-configured-plugin-install.js");
      const result = await repairMissingConfiguredPluginInstalls({
        cfg,
        env: {
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          ...(source === "adopt" ? { OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" } : {}),
        },
        ...(accepted ? { onCapabilityConsent: consent } : {}),
      });

      if (source !== "adopt") {
        expect(committed).toBe(accepted);
      }
      expect(fs.existsSync(fixture.runtimeMarker)).toBe(false);
      if (accepted) {
        expect(consent).toHaveBeenCalledOnce();
        expect(result.warnings).toEqual([]);
        expect(result.records.matrix).toMatchObject({
          acceptedSurface: { tools: ["matrix.write"] },
          acceptedSurfaceHash: expect.stringMatching(/^[a-f\d]{64}$/),
          acceptedSurfaceAt: expect.any(String),
        });
        expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
          result.records,
          expect.any(Object),
        );
      } else {
        expect(result.records).toEqual({});
        expect(result.failedPluginIds).toEqual(["matrix"]);
        expect(result.warnings.join("\n")).toMatch(/capabilit/i);
        expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
      }
    },
  );

  beforeAll(async () => {
    // The doctor module owns a broad install/catalog graph. Its cold import is
    // suite setup; individual cases measure detection and repair behavior.
    await import("./missing-configured-plugin-install.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prepareManagedPluginArtifactConsentHandler.mockResolvedValue({
      onBeforePluginArtifactCommit: async () => {},
      applyAcceptedSurface: (_pluginId, record) => record,
    });
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    mocks.loadInstalledPluginIndex.mockReturnValue({
      plugins: [],
      diagnostics: [],
      installRecords: {},
    });
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({});
    mocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([]);
    mocks.resolveDefaultPluginExtensionsDir.mockReturnValue("/tmp/openclaw-plugins");
    mocks.resolveDefaultPluginNpmDir.mockReturnValue("/tmp/openclaw-npm");
    mocks.resolveProviderInstallCatalogEntries.mockReturnValue([]);
    mocks.resolveOfficialExternalProviderPluginIdsForEnv.mockReturnValue([]);
    mocks.resolveOfficialExternalWebProviderContractPluginIdsForEnv.mockReturnValue([]);
    mocks.resolveOfficialExternalProviderContractPluginIds.mockImplementation(
      ({ contract, providerIds }: { contract: string; providerIds: ReadonlySet<string> }) => {
        const configuredProviderIds = new Set(
          [...providerIds].map((providerId) => providerId.trim().toLowerCase()),
        );
        const entries = mocks.listOfficialExternalPluginCatalogEntries.getMockImplementation()?.();
        if (!Array.isArray(entries)) {
          return [];
        }
        return entries.flatMap((entry) => {
          if (!entry || typeof entry !== "object") {
            return [];
          }
          const candidate = entry as {
            id?: string;
            openclaw?: {
              plugin?: { id?: string };
              contracts?: Record<string, unknown>;
            };
          };
          const pluginId = candidate.openclaw?.plugin?.id ?? candidate.id;
          const ownedProviderIds = candidate.openclaw?.contracts?.[contract];
          if (
            !pluginId ||
            !Array.isArray(ownedProviderIds) ||
            !ownedProviderIds.some(
              (providerId) =>
                typeof providerId === "string" &&
                configuredProviderIds.has(providerId.trim().toLowerCase()),
            )
          ) {
            return [];
          }
          return [pluginId];
        });
      },
    );
    mocks.resolveOfficialExternalProviderPluginIds.mockImplementation(
      ({ providerIds }: { providerIds: ReadonlySet<string> }) => {
        const configuredProviderIds = new Set(
          [...providerIds].map((providerId) => providerId.trim().toLowerCase()),
        );
        const entries = mocks.listOfficialExternalPluginCatalogEntries.getMockImplementation()?.();
        if (!Array.isArray(entries)) {
          return [];
        }
        return entries.flatMap((entry) => {
          if (!entry || typeof entry !== "object") {
            return [];
          }
          const candidate = entry as {
            id?: string;
            openclaw?: {
              plugin?: { id?: string };
              providers?: Array<{ id?: string; aliases?: string[] }>;
            };
          };
          const pluginId = candidate.openclaw?.plugin?.id ?? candidate.id;
          const ownsConfiguredProvider = candidate.openclaw?.providers?.some((provider) =>
            [provider.id, ...(provider.aliases ?? [])].some(
              (providerId) =>
                typeof providerId === "string" &&
                configuredProviderIds.has(providerId.trim().toLowerCase()),
            ),
          );
          return pluginId && ownsConfiguredProvider ? [pluginId] : [];
        });
      },
    );
    mocks.installPluginFromClawHub.mockResolvedValue({
      ok: true,
      pluginId: "matrix",
      targetDir: "/tmp/openclaw-plugins/matrix",
      version: "1.2.3",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "@openclaw/plugin-matrix",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        version: "1.2.3",
        integrity: "sha256-clawhub",
        resolvedAt: "2026-05-01T00:00:00.000Z",
        clawpackSha256: "0".repeat(64),
        clawpackSpecVersion: 1,
        clawpackManifestSha256: "1".repeat(64),
        clawpackSize: 1234,
      },
    });
    mocks.installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "matrix",
      targetDir: "/tmp/openclaw-plugins/matrix",
      version: "1.2.3",
      npmResolution: {
        name: "@openclaw/plugin-matrix",
        version: "1.2.3",
        resolvedSpec: "@openclaw/plugin-matrix@1.2.3",
        integrity: "sha512-test",
        resolvedAt: "2026-05-01T00:00:00.000Z",
      },
    });
  });

  it("maps a missing configured plugin install to a structured finding and dry-run effect", async () => {
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: {
          npmSpec: "@openclaw/plugin-matrix@1.2.3",
          expectedIntegrity: "sha512-test",
        },
        trustedSourceLinkedOfficialInstall: true,
      },
    ]);

    const {
      configuredPluginInstallIssueToHealthFinding,
      configuredPluginInstallIssueToRepairEffect,
      detectConfiguredPluginInstallHealthIssues,
    } = await import("./missing-configured-plugin-install.js");
    const [issue] = await detectConfiguredPluginInstallHealthIssues({
      cfg: {
        channels: {
          matrix: { enabled: true, homeserver: "https://matrix.example.org" },
        },
      },
      env: {},
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(issue).toEqual({
      kind: "missing-install-record",
      pluginId: "matrix",
      installSpec: "@openclaw/plugin-matrix@1.2.3",
    });
    expect(
      configuredPluginInstallIssueToHealthFinding(expectDefined(issue, "issue test invariant")),
    ).toMatchObject({
      checkId: "core/doctor/configured-plugin-installs",
      severity: "warning",
      target: "matrix",
      fixHint: "Run `openclaw doctor --fix` to install @openclaw/plugin-matrix@1.2.3.",
    });
    expect(
      configuredPluginInstallIssueToRepairEffect(expectDefined(issue, "issue test invariant")),
    ).toEqual({
      kind: "package",
      action: "would-install-configured-plugin",
      target: "matrix",
      dryRunSafe: false,
    });
  });

  it("maps package-update deferrals to structured findings without installing packages", async () => {
    const missingDiscordPath = path.resolve("/missing/discord");
    const records = {
      discord: {
        source: "npm",
        spec: "@openclaw/discord",
        installPath: missingDiscordPath,
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "discord",
        pluginId: "discord",
        meta: { label: "Discord" },
        install: {
          npmSpec: "@openclaw/discord",
        },
      },
    ]);

    const {
      configuredPluginInstallIssueToHealthFinding,
      configuredPluginInstallIssueToRepairEffect,
      detectConfiguredPluginInstallHealthIssues,
    } = await import("./missing-configured-plugin-install.js");
    const [issue] = await detectConfiguredPluginInstallHealthIssues({
      cfg: {
        plugins: {
          entries: {
            discord: { enabled: true },
          },
        },
        channels: {
          discord: { enabled: true },
        },
      },
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
      },
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(issue).toEqual({
      kind: "deferred-package-manager-repair",
      pluginId: "discord",
      installPath: missingDiscordPath,
    });
    expect(
      configuredPluginInstallIssueToHealthFinding(expectDefined(issue, "issue test invariant")),
    ).toMatchObject({
      checkId: "core/doctor/configured-plugin-installs",
      severity: "warning",
      path: missingDiscordPath,
      target: "discord",
    });
    expect(
      configuredPluginInstallIssueToRepairEffect(expectDefined(issue, "issue test invariant")),
    ).toEqual({
      kind: "package",
      action: "would-defer-configured-plugin-install-repair",
      target: "discord",
      dryRunSafe: true,
    });
  });

  it("reports one finding when a configured plugin record points at a missing package", async () => {
    const missingDiscordPath = path.resolve("/missing/discord");
    const records = {
      discord: {
        source: "npm",
        spec: "@openclaw/discord",
        installPath: missingDiscordPath,
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "discord",
        pluginId: "discord",
        meta: { label: "Discord" },
        install: {
          npmSpec: "@openclaw/discord",
        },
      },
    ]);

    const { detectConfiguredPluginInstallHealthIssues } =
      await import("./missing-configured-plugin-install.js");
    const issues = await detectConfiguredPluginInstallHealthIssues({
      cfg: {
        plugins: {
          entries: {
            discord: { enabled: true },
          },
        },
        channels: {
          discord: { enabled: true },
        },
      },
      env: {},
    });

    expect(issues).toEqual([
      {
        kind: "missing-installed-payload",
        pluginId: "discord",
        installPath: missingDiscordPath,
        installSpec: "@openclaw/discord",
      },
    ]);
  });

  it("persists no-op baseline records with the active plugin policy", async () => {
    const cfg = {
      plugins: {
        enabled: false,
        allow: ["matrix"],
        entries: { matrix: { enabled: false } },
      },
      channels: { matrix: { enabled: false } },
    } satisfies OpenClawConfig;
    const baselineRecords = {};
    expect(resolveInstalledPluginIndexPolicyHash(cfg)).not.toBe(
      resolveInstalledPluginIndexPolicyHash(undefined),
    );

    const { repairMissingPluginInstallsForIds } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingPluginInstallsForIds({
      cfg,
      pluginIds: [],
      env: {},
      baselineRecords,
    });

    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledOnce();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
      baselineRecords,
      {
        config: cfg,
        env: {},
      },
    );
    expect(result.records).toBe(baselineRecords);
  });

  it("installs a missing configured OpenClaw channel plugin from npm by default", async () => {
    const cfg = {
      security: { installPolicy: { enabled: true } },
      channels: {
        matrix: { enabled: true, homeserver: "https://matrix.example.org" },
      },
    } satisfies OpenClawConfig;
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: {
          npmSpec: "@openclaw/plugin-matrix@1.2.3",
          expectedIntegrity: "sha512-test",
        },
        trustedSourceLinkedOfficialInstall: true,
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg,
      env: {},
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: "@openclaw/plugin-matrix@1.2.3",
      extensionsDir: "/tmp/openclaw-plugins",
      expectedPluginId: "matrix",
      expectedIntegrity: "sha512-test",
      trustedSourceLinkedOfficialInstall: true,
      config: cfg,
    });
    const records = mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords);
    expectRecordFields((records as Record<string, unknown>).matrix, {
      source: "npm",
      spec: "@openclaw/plugin-matrix@1.2.3",
      installPath: "/tmp/openclaw-plugins/matrix",
      version: "1.2.3",
    });
    expect(mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords, 0, 1)).toEqual({
      config: cfg,
      env: {},
    });
    expect(result.changes).toEqual([
      'Installed missing configured plugin "matrix" from @openclaw/plugin-matrix@1.2.3.',
    ]);
    expect(result.warnings).toStrictEqual([]);
  });

  it("falls back to the operator selector when no beta release is published", async () => {
    const cfg = {
      security: { installPolicy: { enabled: true } },
      update: { channel: "beta" },
      channels: {
        matrix: { enabled: true, homeserver: "https://matrix.example.org" },
      },
    } satisfies OpenClawConfig;
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: { npmSpec: "@openclaw/plugin-matrix" },
        trustedSourceLinkedOfficialInstall: true,
      },
    ]);
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce({
      ok: false,
      code: "npm_package_not_found",
      error: "Package not found on npm: @openclaw/plugin-matrix@beta.",
    });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({ cfg, env: {} });

    expect(mockCallArg(mocks.installPluginFromNpmSpec, 0)).toMatchObject({
      spec: "@openclaw/plugin-matrix@beta",
    });
    expect(mockCallArg(mocks.installPluginFromNpmSpec, 1)).toMatchObject({
      spec: "@openclaw/plugin-matrix",
    });
    expect(result.notices).toEqual(
      expect.arrayContaining([
        expect.stringContaining("No @openclaw/plugin-matrix@beta release is published"),
      ]),
    );
  });

  it("retries the operator ClawHub selector when no beta release is published", async () => {
    const cfg = {
      security: { installPolicy: { enabled: true } },
      update: { channel: "beta" },
      channels: {
        matrix: { enabled: true, homeserver: "https://matrix.example.org" },
      },
    } satisfies OpenClawConfig;
    mocks.installPluginFromClawHub
      .mockResolvedValueOnce({
        ok: false,
        code: "version_not_found",
        error: "Version not found on ClawHub: @openclaw/plugin-matrix@beta.",
      })
      .mockResolvedValue({
        ok: true,
        pluginId: "matrix",
        targetDir: "/tmp/openclaw-plugins/matrix",
        version: "1.2.3",
        clawhub: {
          source: "clawhub",
          clawhubUrl: "https://clawhub.ai",
          clawhubPackage: "@openclaw/plugin-matrix",
          clawhubFamily: "code-plugin",
          clawhubChannel: "official",
          version: "1.2.3",
          integrity: "sha256-clawhub",
          resolvedAt: "2026-05-01T00:00:00.000Z",
          clawpackSha256: "0".repeat(64),
          clawpackSpecVersion: 1,
          clawpackManifestSha256: "1".repeat(64),
          clawpackSize: 1234,
        },
      });
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: { clawhubSpec: "clawhub:@openclaw/plugin-matrix" },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({ cfg, env: {} });

    expect(mockCallArg(mocks.installPluginFromClawHub, 0)).toMatchObject({
      spec: "clawhub:@openclaw/plugin-matrix@beta",
    });
    expect(mockCallArg(mocks.installPluginFromClawHub, 1)).toMatchObject({
      spec: "clawhub:@openclaw/plugin-matrix",
    });
    expect(result.notices).toEqual(
      expect.arrayContaining([
        expect.stringContaining("No clawhub:@openclaw/plugin-matrix@beta release is published"),
      ]),
    );
  });

  it("uses an explicit ClawHub install spec before npm", async () => {
    const cfg = {
      security: { installPolicy: { enabled: true } },
      channels: {
        matrix: { enabled: true, homeserver: "https://matrix.example.org" },
      },
    } satisfies OpenClawConfig;
    const reviewNotice =
      "╭─ REVIEW RECOMMENDED - ClawHub has not completed a fresh clean check ─╮\n" +
      "│ • Status:            security scan is pending                         │\n" +
      "╰───────────────────────────────────────────────────────────────────────╯";
    const coloredReviewNotice = `\u001b[33m${reviewNotice}\u001b[39m`;
    mocks.installPluginFromClawHub.mockImplementationOnce(
      async (params: { logger?: { warn?: (message: string) => void } }) => {
        params.logger?.warn?.(coloredReviewNotice);
        return {
          ok: true,
          pluginId: "matrix",
          targetDir: "/tmp/openclaw-plugins/matrix",
          version: "1.2.3",
          clawhub: {
            source: "clawhub",
            clawhubUrl: "https://clawhub.ai",
            clawhubPackage: "@openclaw/plugin-matrix",
            clawhubFamily: "code-plugin",
            clawhubChannel: "official",
            version: "1.2.3",
            integrity: "sha256-clawhub",
            resolvedAt: "2026-05-01T00:00:00.000Z",
            clawpackSha256: "0".repeat(64),
            clawpackSpecVersion: 1,
            clawpackManifestSha256: "1".repeat(64),
            clawpackSize: 1234,
          },
        };
      },
    );
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: {
          clawhubSpec: "clawhub:@openclaw/plugin-matrix@stable",
          npmSpec: "@openclaw/plugin-matrix@1.2.3",
          expectedIntegrity: "sha512-test",
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg,
      env: {},
    });

    const clawHubCall = expectRecordFields(mockCallArg(mocks.installPluginFromClawHub), {
      spec: "clawhub:@openclaw/plugin-matrix@stable",
      expectedPluginId: "matrix",
      config: cfg,
    });
    expect(clawHubCall.logger).toEqual(expect.objectContaining({ terminalLinks: false }));
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(result.changes).toEqual([
      'Installed missing configured plugin "matrix" from clawhub:@openclaw/plugin-matrix@stable.',
    ]);
    expect(result.notices).toContain(reviewNotice);
    expect(result.notices?.[0]).not.toContain("\u001b");
    expect(result.warnings).toStrictEqual([]);
  });

  it("adds repair warnings for blocked ClawHub update outcomes", async () => {
    const records = {
      demo: {
        source: "clawhub",
        spec: "clawhub:@openclaw/plugin-demo@stable",
        clawhubPackage: "@openclaw/plugin-demo",
        installPath: "/missing/demo",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.updateNpmInstalledPlugins.mockResolvedValueOnce({
      changed: false,
      config: {
        plugins: {
          installs: records,
        },
      },
      outcomes: [
        {
          pluginId: "demo",
          status: "skipped",
          code: "clawhub_download_blocked",
          message:
            'Skipped demo ClawHub update: ClawHub release "@openclaw/plugin-demo@1.2.4" cannot be installed because ClawHub flagged it as blocked or malicious. Review the security details above or choose a different version. Existing installed plugin left unchanged.',
        },
      ],
    });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: {
            demo: { enabled: true },
          },
        },
      },
      env: {},
    });

    expect(mocks.updateNpmInstalledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginIds: ["demo"],
      }),
    );
    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([
      'Skipped demo ClawHub update: ClawHub release "@openclaw/plugin-demo@1.2.4" cannot be installed because ClawHub flagged it as blocked or malicious. Review the security details above or choose a different version. Existing installed plugin left unchanged.',
    ]);
  });

  it("installs a missing channel plugin selected by environment config from npm", async () => {
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "matrix",
        npmSpec: "@openclaw/plugin-matrix",
        version: "1.2.3",
      }),
    );
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: {
          npmSpec: "@openclaw/plugin-matrix@1.2.3",
        },
        trustedSourceLinkedOfficialInstall: true,
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {},
      env: { MATRIX_HOMESERVER: "https://matrix.example.org" },
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: "@openclaw/plugin-matrix@1.2.3",
      extensionsDir: "/tmp/openclaw-plugins",
      expectedPluginId: "matrix",
      trustedSourceLinkedOfficialInstall: true,
    });
    const records = mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords);
    expectRecordFields((records as Record<string, unknown>).matrix, {
      source: "npm",
      spec: "@openclaw/plugin-matrix@1.2.3",
      installPath: "/tmp/openclaw-plugins/matrix",
    });
    expect(mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords, 0, 1)).toEqual({
      config: {},
      env: { MATRIX_HOMESERVER: "https://matrix.example.org" },
    });
    expect(result.changes).toEqual([
      'Installed missing configured plugin "matrix" from @openclaw/plugin-matrix@1.2.3.',
    ]);
    expect(result.warnings).toStrictEqual([]);
  });

  it("falls back to npm when an OpenClaw channel plugin artifact is unavailable on ClawHub", async () => {
    mocks.installPluginFromClawHub.mockResolvedValueOnce({
      ok: false,
      code: "artifact_unavailable",
      error: "ClawHub artifact download is not available yet.",
    });
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: {
          clawhubSpec: "clawhub:@openclaw/plugin-matrix@stable",
          npmSpec: "@openclaw/plugin-matrix@1.2.3",
        },
        trustedSourceLinkedOfficialInstall: true,
      },
    ]);

    const { repairMissingPluginInstallsForIds } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingPluginInstallsForIds({
      cfg: {},
      pluginIds: [],
      channelIds: ["matrix"],
      env: {},
    });

    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: "@openclaw/plugin-matrix@1.2.3",
      expectedPluginId: "matrix",
      trustedSourceLinkedOfficialInstall: true,
    });
    expect(result.changes).toEqual([
      'ClawHub clawhub:@openclaw/plugin-matrix@stable unavailable for "matrix"; falling back to npm @openclaw/plugin-matrix@1.2.3.',
      'Installed missing configured plugin "matrix" from @openclaw/plugin-matrix@1.2.3.',
    ]);
    expect(result.warnings).toStrictEqual([]);
  });

  it("does not fall back from ClawHub to non-OpenClaw npm packages", async () => {
    mocks.installPluginFromClawHub.mockResolvedValueOnce({
      ok: false,
      code: "artifact_download_unavailable",
      error: "ClawHub artifact download is not available yet.",
    });
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: {
          clawhubSpec: "clawhub:@openclaw/plugin-matrix@stable",
          npmSpec: "@someone-else/plugin-matrix@1.2.3",
        },
      },
    ]);

    const { repairMissingPluginInstallsForIds } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingPluginInstallsForIds({
      cfg: {},
      pluginIds: [],
      channelIds: ["matrix"],
      env: {},
    });

    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toEqual([
      'Failed to install missing configured plugin "matrix" from clawhub:@openclaw/plugin-matrix@stable: ClawHub artifact download is not available yet.',
    ]);
  });

  it("honors npm-first catalog metadata for missing OpenClaw channel plugins", async () => {
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "twitch",
        npmSpec: "@openclaw/twitch",
        version: "2026.5.2",
      }),
    );
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "twitch",
        pluginId: "twitch",
        meta: { label: "Twitch" },
        install: {
          npmSpec: "@openclaw/twitch",
          defaultChoice: "npm",
        },
        trustedSourceLinkedOfficialInstall: true,
      },
    ]);

    const { repairMissingPluginInstallsForIds } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingPluginInstallsForIds({
      cfg: {},
      pluginIds: [],
      channelIds: ["twitch"],
      env: {},
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: expectedNpmInstallSpec("@openclaw/twitch"),
      expectedPluginId: "twitch",
      trustedSourceLinkedOfficialInstall: true,
    });
    expect(result.changes).toEqual([
      `Installed missing configured plugin "twitch" from ${expectedNpmInstallSpec("@openclaw/twitch")}.`,
    ]);
  });

  it("repairs official plugins at the exact extended-stable core version", async () => {
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "diagnostics-otel",
        npmSpec: "@openclaw/diagnostics-otel",
        version: VERSION,
      }),
    );
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        id: "diagnostics-otel",
        label: "Diagnostics OpenTelemetry",
        install: {
          npmSpec: "@openclaw/diagnostics-otel",
          defaultChoice: "npm",
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    await repairMissingConfiguredPluginInstalls({
      cfg: {
        update: { channel: "extended-stable" },
        plugins: { entries: { "diagnostics-otel": { enabled: true } } },
      },
      env: {},
    });

    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: `@openclaw/diagnostics-otel@${VERSION}`,
      expectedPluginId: "diagnostics-otel",
      trustedSourceLinkedOfficialInstall: true,
    });
    const persistedRecords = mockCallArg(
      mocks.writePersistedInstalledPluginIndexInstallRecords,
    ) as Record<string, unknown>;
    expectRecordFields(persistedRecords["diagnostics-otel"], {
      spec: "@openclaw/diagnostics-otel",
      resolvedSpec: `@openclaw/diagnostics-otel@${VERSION}`,
    });
  });

  it("does not install disabled configured plugin entries", async () => {
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        id: "diagnostics-otel",
        label: "Diagnostics OpenTelemetry",
        install: {
          npmSpec: "@openclaw/diagnostics-otel",
          defaultChoice: "npm",
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: {
            "diagnostics-otel": { enabled: false },
          },
        },
      },
      env: {},
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], warnings: [], records: {} });
  });

  it.each([
    ["enabled-only disabled stub", { channels: { matrix: { enabled: false } } }],
    [
      "channel metadata",
      {
        channels: {
          modelByChannel: { matrix: { default: "openai/gpt-5.6-luna" } },
          " ": { homeserver: "https://matrix.example.org" },
        },
      },
    ],
    [
      "disabled configured channel",
      { channels: { matrix: { enabled: false, homeserver: "https://matrix.example.org" } } },
    ],
    [
      "matching disabled plugin entry",
      {
        plugins: { entries: { matrix: { enabled: false } } },
        channels: { matrix: { homeserver: "https://matrix.example.org" } },
      },
    ],
  ])("does not install channel plugins for a %s", async (_label, cfg) => {
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: {
          npmSpec: "@openclaw/plugin-matrix@1.2.3",
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg,
      env: {},
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], warnings: [], records: {} });
  });

  it("does not download configured channel plugins that are still bundled", async () => {
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        origin: "bundled",
        meta: { label: "Matrix" },
        install: {
          npmSpec: "@openclaw/matrix",
        },
      },
    ]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "matrix",
          origin: "bundled",
          packageName: "@openclaw/matrix",
          channels: ["matrix"],
        },
      ],
      diagnostics: [],
    });
    mockCurrentBundledPlugin("matrix", "@openclaw/matrix");

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: {
            matrix: { enabled: true },
          },
        },
        channels: {
          matrix: { enabled: true, homeserver: "https://matrix.example.org" },
        },
      },
      env: {},
    });

    expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], warnings: [], records: {} });
  });

  it("removes stale managed install records when the configured plugin is bundled", async () => {
    const records = {
      matrix: {
        source: "npm",
        spec: "@openclaw/matrix",
        installPath: "/missing/matrix",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        origin: "bundled",
        meta: { label: "Matrix" },
        install: {
          npmSpec: "@openclaw/matrix",
        },
      },
    ]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "matrix",
          origin: "bundled",
          packageName: "@openclaw/matrix",
          channels: ["matrix"],
        },
      ],
      diagnostics: [
        {
          pluginId: "matrix",
          message: "manifest without channelConfigs metadata",
        },
      ],
    });
    mockCurrentBundledPlugin("matrix", "@openclaw/matrix");

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: {
            matrix: { enabled: true },
          },
        },
        channels: {
          matrix: { enabled: true, homeserver: "https://matrix.example.org" },
        },
      },
      env: {},
    });

    expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
      {},
      {
        config: expect.any(Object),
        env: {},
      },
    );
    expect(result).toEqual({
      changes: ['Removed stale managed install record for bundled plugin "matrix".'],
      warnings: [],
      pluginInventoryChanged: true,
      records: {},
    });
  });

  it("uses current bundled discovery to remove records before stale snapshots can reinstall official plugins", async () => {
    const records = {
      "google-meet": {
        source: "npm",
        spec: "@openclaw/google-meet",
        resolvedName: "@openclaw/google-meet",
        installPath: "/missing/google-meet",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "google-meet",
          origin: "npm",
          packageName: "@openclaw/google-meet",
        },
      ],
      diagnostics: [],
    });
    mockCurrentBundledPlugin("google-meet", "@openclaw/google-meet");
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        id: "google-meet",
        label: "Google Meet",
        install: { npmSpec: "@openclaw/google-meet" },
        openclaw: {
          id: "google-meet",
          install: { npmSpec: "@openclaw/google-meet" },
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: {
            "google-meet": { enabled: true },
          },
        },
      },
      env: {},
    });

    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
      {},
      {
        config: expect.any(Object),
        env: {},
      },
    );
    expect(result).toEqual({
      changes: ['Removed stale managed install record for bundled plugin "google-meet".'],
      warnings: [],
      pluginInventoryChanged: true,
      records: {},
    });
  });

  it("installs an official external plugin when only a stale bundled descriptor remains", async () => {
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "discord",
          origin: "bundled",
          packageName: "@openclaw/discord",
          channels: ["discord"],
        },
      ],
      diagnostics: [],
    });
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        id: "discord",
        label: "Discord",
        install: { npmSpec: "@openclaw/discord", defaultChoice: "npm" },
      },
    ]);
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "discord",
        npmSpec: "@openclaw/discord",
        version: "2026.8.1",
      }),
    );

    const result = await repairConfiguredPlugins({
      plugins: {
        entries: {
          discord: { enabled: true },
        },
      },
    });

    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: expectedNpmInstallSpec("@openclaw/discord"),
      expectedPluginId: "discord",
      trustedSourceLinkedOfficialInstall: true,
    });
    expectRecordFields(result.records.discord, {
      source: "npm",
      spec: "@openclaw/discord",
      installPath: "/tmp/openclaw-plugins/discord",
    });
    expect(result.changes).toEqual([
      `Installed missing configured plugin "discord" from ${expectedNpmInstallSpec("@openclaw/discord")}.`,
    ]);
  });

  it("removes stale bundled install records even when the plugin is not configured", async () => {
    const records = {
      "google-meet": {
        source: "npm",
        spec: "@openclaw/google-meet",
        resolvedName: "@openclaw/google-meet",
        installPath: "/missing/google-meet",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    mockCurrentBundledPlugin("google-meet", "@openclaw/google-meet");

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {},
      env: {},
    });

    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
      {},
      {
        config: {},
        env: {},
      },
    );
    expect(result).toEqual({
      changes: ['Removed stale managed install record for bundled plugin "google-meet".'],
      warnings: [],
      pluginInventoryChanged: true,
      records: {},
    });
  });

  it.each([
    [
      "npm",
      {
        source: "npm",
        spec: "@openclaw/matrix-fork",
        resolvedName: "@openclaw/matrix-fork",
        resolvedSpec: "@openclaw/matrix-fork@1.2.3",
        installPath: "/missing/matrix-fork",
      },
    ],
    [
      "clawhub",
      {
        source: "clawhub",
        spec: "clawhub:@openclaw/matrix-fork@stable",
        clawhubPackage: "@openclaw/matrix-fork",
        installPath: "/missing/matrix-fork",
      },
    ],
  ])(
    "keeps %s install records whose package names only share a bundled prefix",
    async (_, record) => {
      const records = { matrix: record };
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mocks.listChannelPluginCatalogEntries.mockReturnValue([
        {
          id: "matrix",
          pluginId: "matrix",
          origin: "bundled",
          meta: { label: "Matrix" },
          install: {
            npmSpec: "@openclaw/matrix",
          },
        },
      ]);
      mocks.loadPluginMetadataSnapshot.mockReturnValue({
        plugins: [
          {
            id: "matrix",
            origin: "bundled",
            packageName: "@openclaw/matrix",
            channels: ["matrix"],
          },
        ],
        diagnostics: [
          {
            pluginId: "matrix",
            message: "manifest without channelConfigs metadata",
          },
        ],
      });
      mockCurrentBundledPlugin("matrix", "@openclaw/matrix");

      const { repairMissingConfiguredPluginInstalls } =
        await import("./missing-configured-plugin-install.js");
      const result = await repairMissingConfiguredPluginInstalls({
        cfg: {
          plugins: {
            entries: {
              matrix: { enabled: true },
            },
          },
          channels: {
            matrix: { enabled: true, homeserver: "https://matrix.example.org" },
          },
        },
        env: {},
      });

      expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
      expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
      expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
      expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
      expect(result).toEqual({ changes: [], warnings: [], records });
    },
  );

  it("defers missing external payload repair during the package update doctor pass", async () => {
    const records = {
      discord: {
        source: "npm",
        spec: "@openclaw/discord",
        installPath: "/missing/discord",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "discord",
        pluginId: "discord",
        meta: { label: "Discord" },
        install: {
          npmSpec: "@openclaw/discord",
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: {
            discord: { enabled: true },
          },
        },
        channels: {
          discord: { enabled: true },
        },
      },
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
      },
    });

    expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(result).toEqual({
      changes: [
        'Skipped package-manager repair for configured plugin "discord" during package update; rerun "openclaw doctor --fix" after the update completes.',
      ],
      warnings: [],
      deferredRepairDetails: [
        'Skipped package-manager repair for configured plugin "discord" during package update; rerun "openclaw doctor --fix" after the update completes.',
      ],
      records,
    });
  });

  it("updates an existing npm target when stale baseline records miss an installed package", async () => {
    const npmRoot = tempDirs.make("openclaw-plugin-stub-repair-");
    const packageDir = path.join(npmRoot, "node_modules", "@openclaw", "discord");
    fs.mkdirSync(packageDir, { recursive: true });
    mocks.resolveDefaultPluginNpmDir.mockReturnValue(npmRoot);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "discord",
        pluginId: "discord",
        meta: { label: "Discord" },
        install: {
          npmSpec: "@openclaw/discord",
        },
      },
    ]);
    mocks.installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "discord",
      targetDir: packageDir,
      version: "1.2.3",
      npmResolution: {
        name: "@openclaw/discord",
        version: "1.2.3",
        resolvedSpec: "@openclaw/discord@1.2.3",
        integrity: "sha512-discord",
        resolvedAt: "2026-05-01T00:00:00.000Z",
      },
    });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: {
            discord: { enabled: true },
          },
        },
        channels: {
          discord: { enabled: true },
        },
      },
      env: {
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: expectedNpmInstallSpec("@openclaw/discord"),
      expectedPluginId: "discord",
      npmDir: npmRoot,
      mode: "update",
    });
    expect(result.changes).toEqual([
      `Installed missing configured plugin "discord" from ${expectedNpmInstallSpec("@openclaw/discord")}.`,
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.records.discord?.installPath).toBe(packageDir);
  });

  it("retries npm repair as an update when the install target appears stale", async () => {
    const cfg = {
      security: { installPolicy: { enabled: true } },
      plugins: {
        entries: {
          discord: { enabled: true },
        },
      },
    } satisfies OpenClawConfig;
    const npmRoot = tempDirs.make("openclaw-plugin-stub-repair-");
    const packageDir = path.join(npmRoot, "node_modules", "@openclaw", "discord");
    mocks.resolveDefaultPluginNpmDir.mockReturnValue(npmRoot);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "discord",
        pluginId: "discord",
        meta: { label: "Discord" },
        install: {
          npmSpec: "@openclaw/discord",
        },
      },
    ]);
    mocks.installPluginFromNpmSpec
      .mockResolvedValueOnce({
        ok: false,
        error: `plugin already exists: ${packageDir} (delete it first)`,
      })
      .mockResolvedValueOnce({
        ok: true,
        pluginId: "discord",
        targetDir: packageDir,
        version: "1.2.3",
        npmResolution: {
          name: "@openclaw/discord",
          version: "1.2.3",
          resolvedSpec: "@openclaw/discord@1.2.3",
          integrity: "sha512-discord",
          resolvedAt: "2026-05-01T00:00:00.000Z",
        },
      });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg,
      env: {
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
    });

    expect(mocks.installPluginFromNpmSpec).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec, 0), {
      spec: expectedNpmInstallSpec("@openclaw/discord"),
      npmDir: npmRoot,
      mode: "install",
      config: cfg,
    });
    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec, 1), {
      spec: expectedNpmInstallSpec("@openclaw/discord"),
      npmDir: npmRoot,
      mode: "update",
      config: cfg,
    });
    expect(result.warnings).toEqual([]);
    expect(result.records.discord?.installPath).toBe(packageDir);
  });

  it("prefers an existing npm payload over ClawHub during post-core repair", async () => {
    const npmRoot = tempDirs.make("openclaw-plugin-stub-repair-");
    const packageDir = path.join(npmRoot, "node_modules", "@openclaw", "matrix");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "@openclaw/matrix", version: "1.2.3" }),
    );
    mocks.resolveDefaultPluginNpmDir.mockReturnValue(npmRoot);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: {
          clawhubSpec: "clawhub:@openclaw/matrix",
          npmSpec: "@openclaw/matrix",
        },
      },
    ]);
    mocks.installPluginFromClawHub.mockResolvedValue({
      ok: false,
      error: 'Plugin "@openclaw/matrix" requires plugin API >=2026.5.18.',
    });
    mocks.installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "matrix",
      targetDir: packageDir,
      version: "1.2.3",
      npmResolution: {
        name: "@openclaw/matrix",
        version: "1.2.3",
        resolvedSpec: "@openclaw/matrix@1.2.3",
        integrity: "sha512-matrix",
        resolvedAt: "2026-05-01T00:00:00.000Z",
      },
    });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: {
            matrix: { enabled: true },
          },
        },
        channels: {
          matrix: { enabled: true },
        },
      },
      env: {
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([]);
    expectRecordFields(result.records.matrix, {
      source: "npm",
      spec: "@openclaw/matrix",
      installPath: packageDir,
      version: "1.2.3",
      resolvedName: "@openclaw/matrix",
      resolvedVersion: "1.2.3",
      resolvedSpec: "@openclaw/matrix@1.2.3",
    });
  });

  it("passes the post-core compatibility host version to ClawHub repair", async () => {
    const npmRoot = tempDirs.make("openclaw-plugin-stub-repair-");
    mocks.resolveDefaultPluginNpmDir.mockReturnValue(npmRoot);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "whatsapp",
        pluginId: "whatsapp",
        meta: { label: "WhatsApp" },
        install: {
          clawhubSpec: "clawhub:@openclaw/whatsapp",
          npmSpec: "@openclaw/whatsapp",
        },
      },
    ]);
    mocks.installPluginFromClawHub.mockResolvedValue({
      ok: true,
      pluginId: "whatsapp",
      targetDir: "/tmp/openclaw-plugins/whatsapp",
      version: "1.2.3",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "@openclaw/whatsapp",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        version: "1.2.3",
        integrity: "sha256-whatsapp",
        resolvedAt: "2026-05-01T00:00:00.000Z",
        clawpackSha256: "2".repeat(64),
        clawpackSpecVersion: 1,
        clawpackManifestSha256: "3".repeat(64),
        clawpackSize: 1234,
      },
    });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: {
            whatsapp: { enabled: true },
          },
        },
        channels: {
          whatsapp: { enabled: true },
        },
      },
      env: {
        OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.19",
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
    });

    expectRecordFields(mockCallArg(mocks.installPluginFromClawHub), {
      spec: expectedClawHubInstallSpec("clawhub:@openclaw/whatsapp"),
      env: {
        OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.19",
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
      mode: "install",
    });
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([]);
    expectRecordFields(result.records.whatsapp, {
      source: "clawhub",
      spec: "clawhub:@openclaw/whatsapp",
      installPath: "/tmp/openclaw-plugins/whatsapp",
      clawhubPackage: "@openclaw/whatsapp",
    });
  });

  it("repairs missing external payload during post-core convergence even with OPENCLAW_UPDATE_IN_PROGRESS=1", async () => {
    const records = {
      discord: {
        source: "npm",
        spec: "@openclaw/discord",
        installPath: "/missing/discord",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "discord",
        pluginId: "discord",
        meta: { label: "Discord" },
        install: { npmSpec: "@openclaw/discord" },
      },
    ]);
    mocks.updateNpmInstalledPlugins.mockResolvedValue({
      config: {
        plugins: {
          installs: { discord: { source: "npm", installPath: "/repaired/discord" } },
        },
      },
      changed: true,
      outcomes: [{ pluginId: "discord", status: "updated", message: "ok" }],
    });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: { discord: { enabled: true } },
        },
        channels: {
          discord: { enabled: true },
        },
      },
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
    });

    expect(mocks.updateNpmInstalledPlugins).toHaveBeenCalledTimes(1);
    expect(result.warnings).toEqual([]);
    expect(result.changes[0]).toBe('Repaired missing configured plugin "discord".');
    expectRecordFields(result.records.discord, {
      source: "npm",
      installPath: "/repaired/discord",
    });
  });

  it("defers channel-selected external payload repair during the package update doctor pass", async () => {
    const records = {
      discord: {
        source: "npm",
        spec: "@openclaw/discord",
        installPath: "/missing/discord",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "discord",
        pluginId: "discord",
        meta: { label: "Discord" },
        install: {
          npmSpec: "@openclaw/discord",
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        channels: {
          discord: { enabled: true, token: "secret" },
        },
      },
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
      },
    });

    expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(result).toEqual({
      changes: [
        'Skipped package-manager repair for configured plugin "discord" during package update; rerun "openclaw doctor --fix" after the update completes.',
      ],
      warnings: [],
      deferredRepairDetails: [
        'Skipped package-manager repair for configured plugin "discord" during package update; rerun "openclaw doctor --fix" after the update completes.',
      ],
      records,
    });
  });

  it("does not install channel-selected external plugins during an opted-in package update doctor pass", async () => {
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "discord",
        pluginId: "discord",
        meta: { label: "Discord" },
        install: {
          npmSpec: "@openclaw/discord",
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        channels: {
          discord: { enabled: true, token: "secret" },
        },
      },
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
      },
    });

    expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], warnings: [], records: {} });
  });

  it("installs channel-selected external plugins during a legacy package update doctor pass", async () => {
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "discord",
        npmSpec: "@openclaw/discord",
        version: "2026.5.17",
        resolution: {
          resolvedAt: "2026-05-17T00:00:00.000Z",
        },
      }),
    );
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "discord",
        pluginId: "discord",
        meta: { label: "Discord" },
        install: {
          npmSpec: "@openclaw/discord",
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        channels: {
          discord: { enabled: true, token: "secret" },
        },
      },
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
      },
    });

    expect(mocks.installPluginFromNpmSpec).toHaveBeenCalledTimes(1);
    expect(result.changes).toEqual([
      `Installed missing configured plugin "discord" from ${expectedNpmInstallSpec("@openclaw/discord")}.`,
    ]);
    expectRecordFields(result.records.discord, {
      source: "npm",
      installPath: "/tmp/openclaw-plugins/discord",
    });
  });

  it("prefers npm over ClawHub during a legacy package update doctor pass", async () => {
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "whatsapp",
        npmSpec: "@openclaw/whatsapp",
        version: "2026.5.17",
        resolution: {
          resolvedAt: "2026-05-17T00:00:00.000Z",
        },
      }),
    );
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "whatsapp",
        pluginId: "whatsapp",
        meta: { label: "WhatsApp" },
        install: {
          clawhubSpec: "clawhub:@openclaw/whatsapp",
          npmSpec: "@openclaw/whatsapp",
          defaultChoice: "clawhub",
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        channels: {
          whatsapp: { enabled: true, allowFrom: ["+15555550123"] },
        },
      },
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
      },
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: expectedNpmInstallSpec("@openclaw/whatsapp"),
      expectedPluginId: "whatsapp",
    });
    expect(result.changes).toEqual([
      `Installed missing configured plugin "whatsapp" from ${expectedNpmInstallSpec("@openclaw/whatsapp")}.`,
    ]);
    expectRecordFields(result.records.whatsapp, {
      source: "npm",
      installPath: "/tmp/openclaw-plugins/whatsapp",
    });
  });

  it("keeps ClawHub-only candidates available during a legacy package update doctor pass", async () => {
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: {
          clawhubSpec: "clawhub:@openclaw/plugin-matrix@stable",
          defaultChoice: "clawhub",
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        channels: {
          matrix: { enabled: true, homeserver: "https://matrix.example.org" },
        },
      },
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
      },
    });

    expectRecordFields(mockCallArg(mocks.installPluginFromClawHub), {
      spec: "clawhub:@openclaw/plugin-matrix@stable",
      expectedPluginId: "matrix",
    });
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(result.changes).toEqual([
      'Installed missing configured plugin "matrix" from clawhub:@openclaw/plugin-matrix@stable.',
    ]);
  });

  it("does not install configured plugins when plugins are globally disabled", async () => {
    const records = {
      brave: {
        source: "npm" as const,
        spec: "@openclaw/brave-plugin",
        installPath: "/tmp/openclaw-plugins/brave",
      },
      discord: {
        source: "npm" as const,
        spec: "@openclaw/discord",
        installPath: "/tmp/openclaw-plugins/discord",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [],
      diagnostics: [
        ...brokenPluginSnapshot("brave").diagnostics,
        ...brokenPluginSnapshot("discord").diagnostics,
      ],
    });
    mocks.updateNpmInstalledPlugins.mockResolvedValue({
      changed: false,
      config: { plugins: { installs: records } },
      outcomes: [
        { pluginId: "brave", status: "skipped", message: "disabled" },
        { pluginId: "discord", status: "skipped", message: "disabled" },
      ],
    });
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: {
          npmSpec: "@openclaw/plugin-matrix@1.2.3",
        },
      },
    ]);
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        id: "codex",
        label: "Codex",
        install: {
          npmSpec: "@openclaw/codex",
          defaultChoice: "npm",
        },
      },
      {
        id: "diagnostics-otel",
        label: "Diagnostics OpenTelemetry",
        install: {
          npmSpec: "@openclaw/diagnostics-otel",
          defaultChoice: "npm",
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          enabled: false,
          entries: {
            "diagnostics-otel": { enabled: true },
          },
        },
        channels: {
          matrix: { homeserver: "https://matrix.example.org" },
        },
        agents: {
          defaults: {
            agentRuntime: { id: "codex" },
          },
        },
      },
      env: {},
    });

    expect(mocks.updateNpmInstalledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginIds: ["brave", "discord"],
        skipDisabledPlugins: true,
      }),
    );
    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], warnings: [], records });
  });

  it("does not install plugins merely listed in plugins.allow", async () => {
    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          allow: ["codex"],
        },
      },
      env: {},
    });

    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], warnings: [], records: {} });
  });

  it("installs a missing third-party downloadable plugin from npm only", async () => {
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "wecom",
        npmSpec: "@wecom/wecom-openclaw-plugin",
        version: "2026.4.23",
        resolution: {
          integrity: "sha512-third-party",
        },
      }),
    );
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "wecom",
        pluginId: "wecom",
        meta: { label: "WeCom" },
        install: {
          npmSpec: "@wecom/wecom-openclaw-plugin@2026.4.23",
        },
      },
    ]);

    const { repairMissingPluginInstallsForIds } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingPluginInstallsForIds({
      cfg: {},
      pluginIds: [],
      channelIds: ["wecom"],
      env: {},
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    const installArg = mockCallArg(mocks.installPluginFromNpmSpec);
    expectRecordFields(installArg, {
      spec: "@wecom/wecom-openclaw-plugin@2026.4.23",
      expectedPluginId: "wecom",
    });
    expect(installArg).not.toHaveProperty("trustedSourceLinkedOfficialInstall", true);
    expect(result.changes).toEqual([
      'Installed missing configured plugin "wecom" from @wecom/wecom-openclaw-plugin@2026.4.23.',
    ]);
  });

  it("upgrades v2026.7.1-beta.3 Codex Supervisor config and installs Codex", async () => {
    // This is the bundled plugin id and config surface shipped by v2026.7.1-beta.3.
    const migration = applyLegacyDoctorMigrations({
      plugins: {
        allow: ["codex-supervisor"],
        entries: {
          "codex-supervisor": {
            enabled: true,
            config: {
              endpoints: [
                {
                  id: "local",
                  label: "Local Codex",
                  transport: "stdio-proxy",
                  command: "codex",
                  args: ["app-server", "--listen", "stdio://"],
                  cwd: "/tmp/openclaw",
                },
              ],
              allowRawTranscripts: true,
              allowWriteControls: false,
            },
          },
        },
      },
    });

    expect(migration.next).not.toBeNull();
    const cfg = migration.next as OpenClawConfig;
    expect(cfg.plugins?.allow).toEqual(["codex"]);
    expect(cfg.plugins?.entries?.codex).toEqual({
      enabled: true,
      config: {
        supervision: {
          enabled: true,
          endpoints: [
            {
              id: "local",
              label: "Local Codex",
              transport: "stdio-proxy",
              command: "codex",
              args: ["app-server", "--listen", "stdio://"],
              cwd: "/tmp/openclaw",
            },
          ],
          allowRawTranscripts: true,
          allowWriteControls: false,
        },
      },
    });
    expect(cfg.plugins?.entries).not.toHaveProperty("codex-supervisor");
    expect(migration.changes).toEqual(
      expect.arrayContaining([
        "Moved plugins.entries.codex-supervisor to plugins.entries.codex.config.supervision.",
        "Rewrote plugins.allow codex-supervisor references to codex.",
      ]),
    );

    const targetDir = tempDirs.make("openclaw-doctor-current-runtime-");
    fs.writeFileSync(
      path.join(targetDir, "package.json"),
      JSON.stringify({ name: "@openclaw/codex", version: VERSION }),
    );
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "codex",
        npmSpec: "@openclaw/codex",
        version: VERSION,
        targetDir,
        resolution: {
          integrity: "sha512-codex-supervisor-upgrade",
          resolvedAt: "2026-07-10T00:00:00.000Z",
        },
      }),
    );
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        id: "codex",
        label: "Codex",
        install: {
          npmSpec: "@openclaw/codex",
          defaultChoice: "npm",
        },
      },
    ]);

    const { repairMissingPluginInstallsForIds } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingPluginInstallsForIds({
      cfg,
      pluginIds: ["codex"],
      env: {},
      baselineRecords: {},
    });

    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: expectedCodexInstallSpec(),
      expectedPluginId: "codex",
      trustedSourceLinkedOfficialInstall: true,
    });
    const records = mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords);
    expectRecordFields((records as Record<string, unknown>).codex, {
      source: "npm",
      spec: "@openclaw/codex",
      installPath: targetDir,
      version: VERSION,
      resolvedName: "@openclaw/codex",
      resolvedSpec: `@openclaw/codex@${VERSION}`,
      integrity: "sha512-codex-supervisor-upgrade",
    });
    expect(mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords, 0, 1)).toEqual({
      config: cfg,
      env: {},
    });
    expect(result.changes).toEqual([
      `Installed missing configured plugin "codex" from ${expectedCodexInstallSpec()}.`,
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.repairedPluginIds).toEqual(["codex"]);
    expect(result.records).toEqual(records);
  });

  it.each([
    {
      name: "a stale staged payload",
      npmResolutionVersion: VERSION,
      payloadVersion: "2026.5.2",
    },
    {
      name: "stale npm metadata",
      npmResolutionVersion: "2026.5.2",
      payloadVersion: VERSION,
    },
  ])(
    "rolls back a rejected direct version-bound npm artifact with $name",
    async ({ npmResolutionVersion, payloadVersion }) => {
      const targetDir = tempDirs.make("openclaw-doctor-rejected-runtime-");
      fs.writeFileSync(
        path.join(targetDir, "package.json"),
        JSON.stringify({ name: "@openclaw/codex", version: payloadVersion }),
      );
      const installResult = successfulInstall({
        pluginId: "codex",
        npmSpec: "@openclaw/codex",
        version: payloadVersion,
        targetDir,
        resolution: {
          version: npmResolutionVersion,
          resolvedSpec: `@openclaw/codex@${npmResolutionVersion}`,
        },
      });
      let committed = false;
      mocks.installPluginFromNpmSpec.mockImplementationOnce(
        async (callbacks: MockNpmInstallCallbacks) => {
          await invokeMockNpmInstallPrecommit({
            callbacks,
            artifact: {
              pluginId: "codex",
              stagedArtifactDir: targetDir,
              mode: "install",
            },
            npmResolution: installResult.npmResolution,
          });
          committed = true;
          return installResult;
        },
      );
      mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
        {
          id: "codex",
          label: "Codex",
          install: {
            npmSpec: "@openclaw/codex",
            defaultChoice: "npm",
          },
        },
      ]);

      const { repairMissingPluginInstallsForIds } =
        await import("./missing-configured-plugin-install.js");
      const result = await repairMissingPluginInstallsForIds({
        cfg: {
          agents: {
            defaults: {
              model: "openai/gpt-5.4",
              agentRuntime: { id: "codex" },
            },
          },
        },
        pluginIds: ["codex"],
        env: {},
      });

      expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
        spec: expectedCodexInstallSpec(),
        expectedPluginId: "codex",
        trustedSourceLinkedOfficialInstall: true,
      });
      expect(committed).toBe(false);
      expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
      expect(result.changes).toEqual([]);
      expect(result.repairedPluginIds).toBeUndefined();
      expect(result.pluginInventoryChanged).toBeUndefined();
      expect(result.failedPluginIds).toEqual(["codex"]);
      expect(result.records).toEqual({});
      expect(result.warnings).toEqual([expect.stringContaining("release cohort")]);
    },
  );

  it("preserves an exact selector while refreshing a stale managed Codex runtime", async () => {
    const installDir = tempDirs.make("openclaw-plugin-stub-repair-");
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "@openclaw/codex", version: "2026.5.6" }),
    );
    const records = {
      codex: {
        source: "npm",
        spec: "@openclaw/codex@2026.5.6",
        resolvedName: "@openclaw/codex",
        resolvedSpec: "@openclaw/codex@2026.5.6",
        resolvedVersion: "2026.5.6",
        version: "2026.5.6",
        integrity: "sha512-old-codex",
        installPath: installDir,
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    const pluginMetadata = {
      id: "codex",
      packageName: "@openclaw/codex",
      packageVersion: "2026.5.6",
      providers: ["codex"],
      channels: [],
      origin: "global" as const,
      rootDir: installDir,
    };
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [pluginMetadata],
      diagnostics: [],
      byPluginId: new Map([["codex", pluginMetadata]]),
    });
    const targetDir = tempDirs.make("openclaw-doctor-current-runtime-");
    fs.writeFileSync(
      path.join(targetDir, "package.json"),
      JSON.stringify({ name: "@openclaw/codex", version: VERSION }),
    );
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "codex",
        npmSpec: "@openclaw/codex",
        version: VERSION,
        targetDir,
        resolution: {
          integrity: "sha512-new-codex",
        },
      }),
    );
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        id: "codex",
        label: "Codex",
        install: {
          npmSpec: "@openclaw/codex",
          defaultChoice: "npm",
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
          },
        },
      },
      env: {},
    });

    expect(mocks.resolveDirectBundledProviderPolicySurface).toHaveBeenCalledWith("openai");
    expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: expectedCodexInstallSpec(),
      expectedPluginId: "codex",
      trustedSourceLinkedOfficialInstall: true,
      mode: "update",
    });
    expect(result.changes).toEqual([
      `Refreshed stale configured plugin "codex" from ${expectedCodexInstallSpec()}.`,
    ]);
    expectRecordFields(result.records.codex, {
      source: "npm",
      spec: expectedCodexInstallSpec(),
      installPath: targetDir,
      version: VERSION,
      resolvedName: "@openclaw/codex",
      resolvedVersion: VERSION,
      resolvedSpec: `@openclaw/codex@${VERSION}`,
    });
  });

  it.each([
    {
      name: "upgrade fallback",
      recordVersion: VERSION,
      payloadVersion: VERSION,
      compatibilityHostVersion: "9999.1.1",
      shouldRepair: true,
    },
    {
      name: "downgrade target",
      recordVersion: "2026.5.2",
      payloadVersion: "2026.5.2",
      compatibilityHostVersion: "2026.5.2",
      shouldRepair: false,
    },
    {
      name: "stale payload behind current record",
      recordVersion: VERSION,
      payloadVersion: "2026.5.2",
      compatibilityHostVersion: VERSION,
      shouldRepair: true,
    },
    {
      name: "newer payload ahead of stale record",
      recordVersion: "2026.5.2",
      payloadVersion: "9999.1.1",
      compatibilityHostVersion: VERSION,
      shouldRepair: false,
    },
  ])(
    "uses the compatibility host version when classifying a managed runtime ($name)",
    async ({ recordVersion, payloadVersion, compatibilityHostVersion, shouldRepair }) => {
      const installDir = tempDirs.make("openclaw-plugin-stub-repair-");
      fs.writeFileSync(
        path.join(installDir, "package.json"),
        JSON.stringify({ name: "@openclaw/codex", version: payloadVersion }),
      );
      const records = {
        codex: {
          source: "npm" as const,
          spec: "@openclaw/codex",
          resolvedName: "@openclaw/codex",
          resolvedSpec: `@openclaw/codex@${recordVersion}`,
          resolvedVersion: recordVersion,
          version: recordVersion,
          integrity: "sha512-old-codex",
          installPath: installDir,
        },
      };
      const pluginMetadata = {
        id: "codex",
        packageName: "@openclaw/codex",
        packageVersion: payloadVersion,
        providers: ["codex"],
        channels: [],
        origin: "global" as const,
        rootDir: installDir,
      };
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mocks.loadPluginMetadataSnapshot.mockReturnValue({
        plugins: [pluginMetadata],
        diagnostics: [],
        byPluginId: new Map([["codex", pluginMetadata]]),
      });
      const targetDir = tempDirs.make("openclaw-doctor-compat-runtime-");
      fs.writeFileSync(
        path.join(targetDir, "package.json"),
        JSON.stringify({ name: "@openclaw/codex", version: compatibilityHostVersion }),
      );
      if (shouldRepair) {
        mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
          successfulInstall({
            pluginId: "codex",
            npmSpec: "@openclaw/codex",
            version: compatibilityHostVersion,
            targetDir,
          }),
        );
      }
      mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
        {
          id: "codex",
          label: "Codex",
          install: {
            npmSpec: "@openclaw/codex",
            defaultChoice: "npm",
          },
        },
      ]);

      const { repairMissingConfiguredPluginInstalls } =
        await import("./missing-configured-plugin-install.js");
      const result = await repairMissingConfiguredPluginInstalls({
        cfg: {
          agents: {
            defaults: {
              model: "openai/gpt-5.5",
            },
          },
        },
        env: { OPENCLAW_COMPATIBILITY_HOST_VERSION: compatibilityHostVersion },
      });

      if (!shouldRepair) {
        expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
        expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
        expect(result).toEqual({ changes: [], warnings: [], records });
        return;
      }
      expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
        spec: `@openclaw/codex@${compatibilityHostVersion}`,
        expectedPluginId: "codex",
        trustedSourceLinkedOfficialInstall: true,
        mode: "update",
      });
      expect(result.changes).toEqual([
        `Refreshed stale configured plugin "codex" from @openclaw/codex@${compatibilityHostVersion}.`,
      ]);
      expectRecordFields(result.records.codex, {
        source: "npm",
        spec: "@openclaw/codex",
        installPath: targetDir,
        version: compatibilityHostVersion,
        resolvedVersion: compatibilityHostVersion,
        resolvedSpec: `@openclaw/codex@${compatibilityHostVersion}`,
      });
    },
  );

  it("does not classify or replace a stale third-party runtime from old official resolution fields", async () => {
    const installDir = tempDirs.make("openclaw-plugin-stub-repair-");
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "@example/codex", version: "2026.5.6" }),
    );
    const records = {
      codex: {
        source: "npm" as const,
        spec: "@example/codex",
        resolvedName: "@openclaw/codex",
        resolvedSpec: "@openclaw/codex@2026.5.6",
        resolvedVersion: "2026.5.6",
        version: "2026.5.6",
        integrity: "sha512-old-example-codex",
        installPath: installDir,
      },
    };
    const pluginMetadata = {
      id: "codex",
      packageName: "@example/codex",
      packageVersion: "2026.5.6",
      providers: ["codex"],
      channels: [],
      origin: "global" as const,
      rootDir: installDir,
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [pluginMetadata],
      diagnostics: [],
      byPluginId: new Map([["codex", pluginMetadata]]),
    });
    const { detectConfiguredPluginInstallHealthIssues, repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
    };
    const issues = await detectConfiguredPluginInstallHealthIssues({ cfg, env: {} });
    const result = await repairMissingConfiguredPluginInstalls({ cfg, env: {} });

    expect.soft(issues).toEqual([]);
    expect.soft(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect.soft(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], warnings: [], records });
  });

  it.each([
    {
      name: "stale pinned selector",
      installedVersion: "2026.5.6",
      recordSpec: "@openclaw/codex@2026.5.6",
      resolvedName: "@openclaw/codex",
      resolvedSpec: "@openclaw/codex@2026.5.6",
      expectedChange: 'Refreshed stale configured plugin "codex".',
    },
    {
      name: "current floating selector",
      installedVersion: VERSION,
      recordSpec: "@openclaw/codex",
      resolvedName: "@openclaw/codex",
      resolvedSpec: `@openclaw/codex@${VERSION}`,
      expectedChange: 'Repaired broken installed plugin "codex".',
    },
    {
      name: "current selector with missing resolved identities",
      installedVersion: VERSION,
      recordSpec: "@openclaw/codex",
      resolvedName: undefined,
      resolvedSpec: undefined,
      expectedChange: 'Repaired broken installed plugin "codex".',
    },
  ])(
    "keeps a hollow Codex runtime on the current release cohort ($name)",
    async ({ installedVersion, recordSpec, resolvedName, resolvedSpec, expectedChange }) => {
      const installDir = path.join(
        tempDirs.make("openclaw-plugin-stub-repair-"),
        "node_modules",
        "codex",
      );
      fs.mkdirSync(installDir, { recursive: true });
      const stagedArtifactDir = tempDirs.make("openclaw-plugin-staged-repair-");
      const targetDir = tempDirs.make("openclaw-plugin-repaired-target-");
      createColdPluginFixture({
        rootDir: installDir,
        pluginId: "codex",
        packageName: "@openclaw/codex",
        packageVersion: installedVersion,
      });
      for (const rootDir of [stagedArtifactDir, targetDir]) {
        createColdPluginFixture({
          rootDir,
          pluginId: "codex",
          packageName: "@openclaw/codex",
          packageVersion: VERSION,
        });
      }
      const records = {
        codex: {
          source: "npm" as const,
          spec: recordSpec,
          ...(resolvedName ? { resolvedName } : {}),
          ...(resolvedSpec ? { resolvedSpec } : {}),
          resolvedVersion: installedVersion,
          version: installedVersion,
          integrity: "sha512-old-codex",
          installPath: installDir,
        },
      };
      const pluginMetadata = {
        id: "codex",
        packageName: "@openclaw/codex",
        packageVersion: installedVersion,
        providers: ["codex"],
        channels: [],
        origin: "global" as const,
        rootDir: installDir,
        packageDependencies: { "@example/required-runtime": "^1.0.0" },
      };
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mocks.loadPluginMetadataSnapshot.mockReturnValue({
        plugins: [pluginMetadata],
        diagnostics: [],
        byPluginId: new Map([["codex", pluginMetadata]]),
      });
      mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
        {
          id: "codex",
          label: "Codex",
          install: {
            npmSpec: "@openclaw/codex",
            defaultChoice: "npm",
          },
        },
      ]);
      const { updateNpmInstalledPlugins: updateNpmInstalledPluginsActual } = await vi.importActual<
        typeof import("../../../plugins/update.js")
      >("../../../plugins/update.js");
      mocks.updateNpmInstalledPlugins.mockImplementationOnce(updateNpmInstalledPluginsActual);
      mocks.installPluginFromNpmSpec.mockImplementationOnce(async (params) => {
        await params.onBeforePluginArtifactCommit({
          pluginId: "codex",
          stagedArtifactDir,
          mode: "update",
        });
        return successfulInstall({
          pluginId: "codex",
          npmSpec: "@openclaw/codex",
          version: VERSION,
          targetDir,
          resolution: { integrity: "sha512-new-codex" },
        });
      });

      const { repairMissingConfiguredPluginInstalls } =
        await import("./missing-configured-plugin-install.js");
      const result = await repairMissingConfiguredPluginInstalls({
        cfg: {
          agents: {
            defaults: {
              model: "openai/gpt-5.5",
            },
          },
        },
        env: {},
      });

      const updateArg = expectRecordFields(mockCallArg(mocks.updateNpmInstalledPlugins), {
        pluginIds: ["codex"],
        skipDisabledPlugins: true,
      });
      expect.soft(updateArg.specOverrides).toEqual({ codex: "@openclaw/codex" });
      expect.soft(updateArg.versionBoundToCorePluginIds).toEqual(new Set(["codex"]));
      expect.soft(mockCallArg(mocks.installPluginFromNpmSpec)).toMatchObject({
        spec: expectedCodexInstallSpec(),
        expectedPluginId: "codex",
        mode: "update",
      });
      expect(hasRetainedManagedNpmInstallMarker(installDir)).toBe(true);
      expect(result.changes).toEqual([expectedChange]);
      expectRecordFields(result.records.codex, {
        source: "npm",
        spec:
          recordSpec === "@openclaw/codex@2026.5.6"
            ? expectedCodexInstallSpec()
            : "@openclaw/codex",
        installPath: targetDir,
        version: VERSION,
        resolvedName: "@openclaw/codex",
        resolvedVersion: VERSION,
        resolvedSpec: `@openclaw/codex@${VERSION}`,
      });
    },
  );

  it.each([
    {
      name: "a stale staged payload",
      npmResolutionVersion: VERSION,
      payloadVersion: "2026.5.2",
    },
    {
      name: "stale npm metadata",
      npmResolutionVersion: "2026.5.2",
      payloadVersion: VERSION,
    },
  ])(
    "rolls back a rejected retained version-bound npm artifact with $name",
    async ({ npmResolutionVersion, payloadVersion }) => {
      const installDir = path.join(
        tempDirs.make("openclaw-plugin-stub-repair-"),
        "node_modules",
        "codex",
      );
      fs.mkdirSync(installDir, { recursive: true });
      createColdPluginFixture({
        rootDir: installDir,
        pluginId: "codex",
        packageName: "@openclaw/codex",
        packageVersion: VERSION,
      });
      const stagedArtifactDir = tempDirs.make("openclaw-plugin-rejected-stage-");
      createColdPluginFixture({
        rootDir: stagedArtifactDir,
        pluginId: "codex",
        packageName: "@openclaw/codex",
        packageVersion: payloadVersion,
      });
      const records = {
        codex: {
          source: "npm" as const,
          spec: "@openclaw/codex",
          resolvedName: "@openclaw/codex",
          resolvedSpec: `@openclaw/codex@${VERSION}`,
          resolvedVersion: VERSION,
          version: VERSION,
          integrity: "sha512-old-codex",
          installPath: installDir,
        },
      };
      const pluginMetadata = {
        id: "codex",
        packageName: "@openclaw/codex",
        packageVersion: VERSION,
        providers: ["codex"],
        channels: [],
        origin: "global" as const,
        rootDir: installDir,
        packageDependencies: { "@example/required-runtime": "^1.0.0" },
      };
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mocks.loadPluginMetadataSnapshot.mockReturnValue({
        plugins: [pluginMetadata],
        diagnostics: [],
        byPluginId: new Map([["codex", pluginMetadata]]),
      });
      mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
        {
          id: "codex",
          label: "Codex",
          install: {
            npmSpec: "@openclaw/codex",
            defaultChoice: "npm",
          },
        },
      ]);
      const { updateNpmInstalledPlugins: updateNpmInstalledPluginsActual } = await vi.importActual<
        typeof import("../../../plugins/update.js")
      >("../../../plugins/update.js");
      mocks.updateNpmInstalledPlugins.mockImplementationOnce(updateNpmInstalledPluginsActual);
      const installResult = successfulInstall({
        pluginId: "codex",
        npmSpec: "@openclaw/codex",
        version: payloadVersion,
        targetDir: stagedArtifactDir,
        resolution: {
          version: npmResolutionVersion,
          resolvedSpec: `@openclaw/codex@${npmResolutionVersion}`,
          integrity: "sha512-rejected-codex",
        },
      });
      let committed = false;
      mocks.installPluginFromNpmSpec.mockImplementationOnce(
        async (callbacks: MockNpmInstallCallbacks) => {
          await invokeMockNpmInstallPrecommit({
            callbacks,
            artifact: {
              pluginId: "codex",
              stagedArtifactDir,
              mode: "update",
            },
            npmResolution: installResult.npmResolution,
          });
          committed = true;
          return installResult;
        },
      );

      const { repairMissingConfiguredPluginInstalls } =
        await import("./missing-configured-plugin-install.js");
      const result = await repairMissingConfiguredPluginInstalls({
        cfg: {
          agents: {
            defaults: {
              model: "openai/gpt-5.5",
            },
          },
        },
        env: {},
      });

      expectRecordFields(mockCallArg(mocks.updateNpmInstalledPlugins), {
        pluginIds: ["codex"],
        skipDisabledPlugins: true,
      });
      expect(committed).toBe(false);
      expect(hasRetainedManagedNpmInstallMarker(installDir)).toBe(false);
      expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
      expect(result.changes).toEqual([]);
      expect(result.repairedPluginIds).toBeUndefined();
      expect(result.pluginInventoryChanged).toBeUndefined();
      expect(result.failedPluginIds).toEqual(["codex"]);
      expect(result.records).toBe(records);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("release cohort")]),
      );
    },
  );

  it.each([
    {
      name: "a stale payload",
      status: "updated" as const,
      targetVersion: "2026.5.2",
      reuseActiveRoot: false,
      expectedWarning: "release cohort",
    },
    {
      name: "an unchanged active root",
      status: "unchanged" as const,
      targetVersion: VERSION,
      reuseActiveRoot: true,
      expectedWarning: "fresh managed generation",
    },
  ])(
    "rejects a retained version-bound updater result with $name",
    async ({ status, targetVersion, reuseActiveRoot, expectedWarning }) => {
      const installDir = path.join(
        tempDirs.make("openclaw-plugin-stub-repair-"),
        "node_modules",
        "codex",
      );
      fs.mkdirSync(installDir, { recursive: true });
      createColdPluginFixture({
        rootDir: installDir,
        pluginId: "codex",
        packageName: "@openclaw/codex",
        packageVersion: VERSION,
      });
      const rejectedTargetDir = reuseActiveRoot
        ? installDir
        : tempDirs.make("openclaw-doctor-rejected-runtime-");
      if (!reuseActiveRoot) {
        fs.writeFileSync(
          path.join(rejectedTargetDir, "package.json"),
          JSON.stringify({ name: "@openclaw/codex", version: targetVersion }),
        );
      }
      const records = {
        codex: {
          source: "npm" as const,
          spec: "@openclaw/codex",
          resolvedName: "@openclaw/codex",
          resolvedSpec: `@openclaw/codex@${VERSION}`,
          resolvedVersion: VERSION,
          version: VERSION,
          integrity: "sha512-old-codex",
          installPath: installDir,
        },
      };
      const pluginMetadata = {
        id: "codex",
        packageName: "@openclaw/codex",
        packageVersion: VERSION,
        providers: ["codex"],
        channels: [],
        origin: "global" as const,
        rootDir: installDir,
        packageDependencies: { "@example/required-runtime": "^1.0.0" },
      };
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mocks.loadPluginMetadataSnapshot.mockReturnValue({
        plugins: [pluginMetadata],
        diagnostics: [],
        byPluginId: new Map([["codex", pluginMetadata]]),
      });
      mocks.updateNpmInstalledPlugins.mockResolvedValueOnce({
        changed: status === "updated",
        config: {
          plugins: {
            installs: {
              codex: {
                source: "npm",
                spec: "@openclaw/codex",
                resolvedName: "@openclaw/codex",
                resolvedSpec: `@openclaw/codex@${targetVersion}`,
                resolvedVersion: targetVersion,
                version: targetVersion,
                installPath: rejectedTargetDir,
              },
            },
          },
        },
        outcomes: [{ pluginId: "codex", status, message: `${status} codex.` }],
      });

      const { repairMissingConfiguredPluginInstalls } =
        await import("./missing-configured-plugin-install.js");
      const result = await repairMissingConfiguredPluginInstalls({
        cfg: {
          agents: {
            defaults: {
              model: "openai/gpt-5.5",
            },
          },
        },
        env: {},
      });

      expectRecordFields(mockCallArg(mocks.updateNpmInstalledPlugins), {
        pluginIds: ["codex"],
        skipDisabledPlugins: true,
      });
      expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
      expect(hasRetainedManagedNpmInstallMarker(installDir)).toBe(false);
      expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
      expect(result.changes).toEqual([]);
      expect(result.repairedPluginIds).toBeUndefined();
      expect(result.pluginInventoryChanged).toBeUndefined();
      expect(result.failedPluginIds).toEqual(["codex"]);
      expect(result.records).toBe(records);
      expect(result.warnings).toEqual([expect.stringContaining(expectedWarning)]);
    },
  );

  it.each([
    {
      name: "all record identities are non-official",
      recordSpec: "@example/codex",
      resolvedName: "@example/codex",
      resolvedSpec: `@example/codex@${VERSION}`,
      activePackageName: "@example/codex",
      expectedPackageName: "@example/codex",
    },
    {
      name: "stale resolved identities are official",
      recordSpec: "@example/codex",
      resolvedName: "@openclaw/codex",
      resolvedSpec: `@openclaw/codex@${VERSION}`,
      activePackageName: "@example/codex",
      expectedPackageName: "@example/codex",
    },
    {
      name: "resolved identities are missing",
      recordSpec: "@example/codex",
      resolvedName: undefined,
      resolvedSpec: undefined,
      activePackageName: "@example/codex",
      expectedPackageName: "@example/codex",
    },
    {
      name: "one stale official resolved identity accompanies malformed metadata",
      recordSpec: "@example/codex",
      resolvedName: "@openclaw/codex",
      resolvedSpec: "not-an-npm-spec",
      activePackageName: "@example/codex",
      expectedPackageName: "@example/codex",
    },
    {
      name: "an official selector conflicts with third-party resolved identities",
      recordSpec: "@openclaw/codex",
      resolvedName: "@example/codex",
      resolvedSpec: `@example/codex@${VERSION}`,
      activePackageName: "@example/codex",
      expectedPackageName: "@openclaw/codex",
    },
    {
      name: "a third-party selector replaces a still-active official package",
      recordSpec: "@example/codex",
      resolvedName: "@openclaw/codex",
      resolvedSpec: `@openclaw/codex@${VERSION}`,
      activePackageName: "@openclaw/codex",
      expectedPackageName: "@example/codex",
    },
  ])(
    "does not grant the official release cohort without both official active-package and selector identity ($name)",
    async ({ recordSpec, resolvedName, resolvedSpec, activePackageName, expectedPackageName }) => {
      const installDir = path.join(
        tempDirs.make("openclaw-plugin-stub-repair-"),
        "node_modules",
        "codex",
      );
      fs.mkdirSync(installDir, { recursive: true });
      const stagedArtifactDir = tempDirs.make("openclaw-plugin-staged-repair-");
      const targetDir = tempDirs.make("openclaw-plugin-repaired-target-");
      for (const rootDir of [installDir, stagedArtifactDir, targetDir]) {
        createColdPluginFixture({
          rootDir,
          pluginId: "codex",
          packageName: activePackageName,
          packageVersion: VERSION,
        });
      }
      const records = {
        codex: {
          source: "npm" as const,
          spec: recordSpec,
          ...(resolvedName ? { resolvedName } : {}),
          ...(resolvedSpec ? { resolvedSpec } : {}),
          resolvedVersion: VERSION,
          version: VERSION,
          integrity: "sha512-old-example-codex",
          installPath: installDir,
        },
      };
      const pluginMetadata = {
        id: "codex",
        packageName: activePackageName,
        packageVersion: VERSION,
        providers: ["codex"],
        channels: [],
        origin: "global" as const,
        rootDir: installDir,
        packageDependencies: { "@example/required-runtime": "^1.0.0" },
      };
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mocks.loadPluginMetadataSnapshot.mockReturnValue({
        plugins: [pluginMetadata],
        diagnostics: [],
        byPluginId: new Map([["codex", pluginMetadata]]),
      });
      const { updateNpmInstalledPlugins: updateNpmInstalledPluginsActual } = await vi.importActual<
        typeof import("../../../plugins/update.js")
      >("../../../plugins/update.js");
      mocks.updateNpmInstalledPlugins.mockImplementationOnce(updateNpmInstalledPluginsActual);
      mocks.installPluginFromNpmSpec.mockImplementationOnce(async (params) => {
        await params.onBeforePluginArtifactCommit({
          pluginId: "codex",
          stagedArtifactDir,
          mode: "update",
        });
        return successfulInstall({
          pluginId: "codex",
          npmSpec: expectedPackageName,
          version: VERSION,
          targetDir,
          resolution: { integrity: "sha512-new-example-codex" },
        });
      });

      const { repairMissingConfiguredPluginInstalls } =
        await import("./missing-configured-plugin-install.js");
      const result = await repairMissingConfiguredPluginInstalls({
        cfg: {
          agents: {
            defaults: {
              model: "openai/gpt-5.5",
            },
          },
        },
        env: {},
      });

      const updateArg = expectRecordFields(mockCallArg(mocks.updateNpmInstalledPlugins), {
        pluginIds: ["codex"],
        skipDisabledPlugins: true,
      });
      expect.soft(updateArg.specOverrides).toEqual({});
      expect.soft(updateArg.versionBoundToCorePluginIds).toEqual(new Set());
      expect.soft(mockCallArg(mocks.installPluginFromNpmSpec)).toMatchObject({
        spec: expectedNpmInstallSpec(recordSpec),
        expectedPluginId: "codex",
        mode: "update",
      });
      expect(hasRetainedManagedNpmInstallMarker(installDir)).toBe(true);
      expect(result.changes).toEqual(['Repaired broken installed plugin "codex".']);
      expectRecordFields(result.records.codex, {
        source: "npm",
        spec: recordSpec,
        installPath: targetDir,
        version: VERSION,
        resolvedName: expectedPackageName,
        resolvedVersion: VERSION,
        resolvedSpec: `${expectedPackageName}@${VERSION}`,
      });
    },
  );

  it("does not refresh a converged beta Codex runtime plugin on the second doctor pass", async () => {
    const codexBetaVersion = `${currentOpenClawReleaseBase()}-beta.4`;
    const installDir = tempDirs.make("openclaw-plugin-stub-repair-");
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "@openclaw/codex", version: "2026.5.6" }),
    );
    const records = {
      codex: {
        source: "npm",
        spec: "@openclaw/codex",
        resolvedName: "@openclaw/codex",
        resolvedSpec: "@openclaw/codex@2026.5.6",
        resolvedVersion: "2026.5.6",
        version: "2026.5.6",
        integrity: "sha512-old-codex",
        installPath: installDir,
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    const pluginMetadata = {
      id: "codex",
      packageName: "@openclaw/codex",
      packageVersion: "2026.5.6",
      providers: ["codex"],
      channels: [],
      origin: "global" as const,
      rootDir: installDir,
    };
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [pluginMetadata],
      diagnostics: [],
      byPluginId: new Map([["codex", pluginMetadata]]),
    });
    mocks.installPluginFromNpmSpec.mockImplementationOnce(async () => {
      fs.writeFileSync(
        path.join(installDir, "package.json"),
        JSON.stringify({ name: "@openclaw/codex", version: codexBetaVersion }),
      );
      return successfulInstall({
        pluginId: "codex",
        npmSpec: "@openclaw/codex",
        targetDir: installDir,
        version: codexBetaVersion,
        resolution: {
          integrity: "sha512-new-codex-beta",
        },
      });
    });
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        id: "codex",
        label: "Codex",
        install: {
          npmSpec: "@openclaw/codex",
          defaultChoice: "npm",
        },
      },
    ]);

    const cfg = {
      update: { channel: "beta" as const },
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
        },
      },
    };
    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const firstPass = await repairMissingConfiguredPluginInstalls({
      cfg,
      env: {},
    });

    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: "@openclaw/codex@beta",
      expectedPluginId: "codex",
      trustedSourceLinkedOfficialInstall: true,
      mode: "update",
    });
    expect(firstPass.changes).toEqual([
      'Refreshed stale configured plugin "codex" from @openclaw/codex@beta.',
    ]);
    expectRecordFields(firstPass.records.codex, {
      source: "npm",
      spec: "@openclaw/codex",
      installPath: installDir,
      version: codexBetaVersion,
      resolvedName: "@openclaw/codex",
      resolvedVersion: codexBetaVersion,
      resolvedSpec: `@openclaw/codex@${codexBetaVersion}`,
    });

    mocks.installPluginFromNpmSpec.mockClear();
    mocks.writePersistedInstalledPluginIndexInstallRecords.mockClear();
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(firstPass.records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "codex",
          packageVersion: codexBetaVersion,
          providers: ["codex"],
        },
      ],
      diagnostics: [],
      byPluginId: new Map([
        [
          "codex",
          {
            id: "codex",
            packageVersion: codexBetaVersion,
            providers: ["codex"],
          },
        ],
      ]),
    });

    const secondPass = await repairMissingConfiguredPluginInstalls({
      cfg,
      env: {},
    });

    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(secondPass).toEqual({ changes: [], warnings: [], records: firstPass.records });
  });

  it("does not downgrade a newer managed Codex runtime plugin", async () => {
    const installDir = tempDirs.make("openclaw-plugin-stub-repair-");
    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify({ name: "@openclaw/codex", version: "9999.1.1" }),
    );
    const records = {
      codex: {
        source: "npm",
        spec: "@openclaw/codex",
        resolvedName: "@openclaw/codex",
        resolvedSpec: "@openclaw/codex@9999.1.1",
        resolvedVersion: "9999.1.1",
        version: "9999.1.1",
        integrity: "sha512-newer-codex",
        installPath: installDir,
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "codex",
          packageVersion: "9999.1.1",
          providers: ["codex", "openai-codex", "openai"],
        },
      ],
      diagnostics: [],
      byPluginId: new Map([
        [
          "codex",
          {
            id: "codex",
            packageVersion: "9999.1.1",
            providers: ["codex", "openai-codex", "openai"],
          },
        ],
      ]),
    });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
          },
        },
      },
      env: {},
    });

    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], warnings: [], records });
  });

  it.each([
    [
      "default OpenAI model route",
      {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
          },
        },
      },
      {},
    ],
    [
      "provider runtime policy",
      {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "codex" },
              models: [],
            },
          },
        },
      },
      {},
    ],
    [
      "default model runtime policy",
      {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
            },
          },
        },
      },
      {},
    ],
    [
      "default selectable OpenAI agent model",
      {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
            models: {
              "openai/gpt-5.5": {},
            },
          },
        },
      },
      {},
    ],
    [
      "agent model runtime policy",
      {
        agents: {
          list: [
            {
              id: "main",
              model: "anthropic/claude-opus-4-7",
              models: {
                "anthropic/claude-opus-4-7": { agentRuntime: { id: "codex" } },
              },
            },
          ],
        },
      },
      {},
    ],
  ])("repairs a missing Codex plugin selected by %s", async (_label, cfg, env) => {
    const targetDir = tempDirs.make("openclaw-doctor-current-runtime-");
    fs.writeFileSync(
      path.join(targetDir, "package.json"),
      JSON.stringify({ name: "@openclaw/codex", version: VERSION }),
    );
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "codex",
        npmSpec: "@openclaw/codex",
        version: VERSION,
        targetDir,
      }),
    );
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        id: "codex",
        label: "Codex",
        install: {
          npmSpec: "@openclaw/codex",
          defaultChoice: "npm",
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg,
      env,
    });

    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: expectedCodexInstallSpec(),
      expectedPluginId: "codex",
      trustedSourceLinkedOfficialInstall: true,
    });
    const records = mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords);
    expectRecordFields((records as Record<string, unknown>).codex, {
      source: "npm",
      spec: "@openclaw/codex",
      installPath: targetDir,
      version: VERSION,
    });
    expect(mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords, 0, 1)).toEqual({
      config: cfg,
      env,
    });
    expect(result.changes).toEqual([
      `Installed missing configured plugin "codex" from ${expectedCodexInstallSpec()}.`,
    ]);
    expect(result.warnings).toEqual([]);
    expect(Object.keys(result.records)).toEqual(["codex"]);
    expectRecordFields(result.records.codex, {
      source: "npm",
      spec: "@openclaw/codex",
      installPath: targetDir,
      version: VERSION,
      resolvedName: "@openclaw/codex",
      resolvedSpec: `@openclaw/codex@${VERSION}`,
      integrity: "sha512-codex",
      resolvedAt: "2026-05-01T00:00:00.000Z",
    });
    expect(typeof result.records.codex?.installedAt).toBe("string");
  });

  it.each([
    [
      "default agent runtime",
      {
        agents: {
          defaults: {
            agentRuntime: { id: "codex" },
          },
        },
      },
      {},
    ],
    [
      "agent runtime override",
      {
        agents: {
          list: [{ id: "main", agentRuntime: { id: "codex" } }],
        },
      },
      {},
    ],
    ["environment runtime override", {}, { OPENCLAW_AGENT_RUNTIME: "codex" }],
  ])("ignores legacy whole-agent Codex runtime selected by %s", async (_label, cfg, env) => {
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        id: "codex",
        label: "Codex",
        install: {
          npmSpec: "@openclaw/codex",
          defaultChoice: "npm",
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg,
      env,
    });

    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], warnings: [], records: {} });
  });

  it("does not install a blocked downloadable plugin from explicit channel ids", async () => {
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: {
          npmSpec: "@openclaw/plugin-matrix@1.2.3",
        },
      },
    ]);

    const { repairMissingPluginInstallsForIds } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingPluginInstallsForIds({
      cfg: {},
      pluginIds: [],
      channelIds: ["matrix"],
      blockedPluginIds: ["matrix"],
      env: {},
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], warnings: [], records: {} });
  });

  it.each<{ name: string; plugins: PluginsConfig; installs: boolean }>([
    {
      name: "does not install a channel catalog plugin when a configured plugin already owns that channel",
      plugins: { entries: { "openclaw-lark": { enabled: true } } },
      installs: false,
    },
    {
      name: "still installs a channel catalog plugin when the configured owner is blocked by the allowlist",
      plugins: {
        allow: ["some-other-plugin"],
        entries: { "openclaw-lark": { enabled: true } },
      },
      installs: true,
    },
    {
      name: "still installs a channel catalog plugin when that plugin is explicitly configured",
      plugins: {
        entries: {
          feishu: { enabled: true },
          "openclaw-lark": { enabled: true },
        },
      },
      installs: true,
    },
  ])("$name", async ({ plugins, installs }) => {
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "openclaw-lark",
          origin: "config",
          channels: ["feishu"],
          channelConfigs: {
            feishu: {
              schema: {
                type: "object",
              },
            },
          },
        },
      ],
      diagnostics: [],
    });
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "feishu",
        pluginId: "feishu",
        meta: { label: "Feishu" },
        install: {
          npmSpec: "@openclaw/feishu",
        },
        trustedSourceLinkedOfficialInstall: true,
      },
    ]);
    if (installs) {
      mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
        successfulInstall({
          pluginId: "feishu",
          npmSpec: "@openclaw/feishu",
          version: "2026.5.2",
        }),
      );
    }

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins,
        channels: {
          feishu: { footer: { model: false } },
        },
      },
      env: {},
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    if (!installs) {
      expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
      expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
      expect(result).toEqual({ changes: [], warnings: [], records: {} });
      return;
    }
    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: expectedNpmInstallSpec("@openclaw/feishu"),
      expectedPluginId: "feishu",
      trustedSourceLinkedOfficialInstall: true,
    });
    expect(result.changes).toEqual([
      `Installed missing configured plugin "feishu" from ${expectedNpmInstallSpec("@openclaw/feishu")}.`,
    ]);
  });

  it("reinstalls a missing configured plugin from its persisted install record", async () => {
    const records = {
      demo: {
        source: "npm",
        spec: "@openclaw/plugin-demo@1.0.0",
        installPath: "/missing/demo",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.updateNpmInstalledPlugins.mockResolvedValue({
      changed: true,
      config: {
        plugins: {
          installs: {
            demo: {
              source: "npm",
              spec: "@openclaw/plugin-demo@1.0.0",
              installPath: "/tmp/openclaw-plugins/demo",
            },
          },
        },
      },
      outcomes: [
        {
          pluginId: "demo",
          status: "updated",
          message: "Updated demo.",
        },
      ],
    });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: {
            demo: { enabled: true },
          },
        },
      },
      env: {},
    });

    const updateArg = expectRecordFields(mockCallArg(mocks.updateNpmInstalledPlugins), {
      pluginIds: ["demo"],
    });
    const updateConfig = updateArg.config as Record<string, unknown>;
    expectRecordFields(updateConfig.plugins, { installs: records });
    const persistedRecords = mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords);
    expectRecordFields((persistedRecords as Record<string, unknown>).demo, {
      installPath: "/tmp/openclaw-plugins/demo",
    });
    expect(mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords, 0, 1)).toEqual({
      config: expect.any(Object),
      env: {},
    });
    expect(result.changes).toEqual(['Repaired missing configured plugin "demo".']);
  });

  it("forwards capability consent to persisted-record repair", async () => {
    const records = {
      demo: {
        source: "clawhub",
        spec: "clawhub:@openclaw/plugin-demo@1.0.0",
        clawhubPackage: "@openclaw/plugin-demo",
        installPath: "/missing/demo",
      },
    };
    const onCapabilityConsent: PluginCapabilityConsentHandler = async (review) => ({
      reviewToken: review.reviewToken,
    });
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.updateNpmInstalledPlugins.mockResolvedValue({
      changed: true,
      config: {
        plugins: {
          installs: {
            demo: {
              source: "clawhub",
              spec: "clawhub:@openclaw/plugin-demo@1.0.0",
              installPath: "/tmp/openclaw-plugins/demo",
            },
          },
        },
      },
      outcomes: [
        {
          pluginId: "demo",
          status: "updated",
          message: "Updated demo.",
        },
      ],
    });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: {
            demo: { enabled: true },
          },
        },
      },
      env: {},
      onCapabilityConsent,
    });

    const updateArg = expectRecordFields(mockCallArg(mocks.updateNpmInstalledPlugins), {
      pluginIds: ["demo"],
      onCapabilityConsent,
    });
    expect(updateArg.logger).toEqual(expect.objectContaining({ terminalLinks: false }));
    const updateConfig = updateArg.config as Record<string, unknown>;
    expectRecordFields(updateConfig.plugins, { installs: records });
  });

  it("keeps non-ClawHub updater warnings as persisted-record repair warnings", async () => {
    const records = {
      demo: {
        source: "npm",
        spec: "@openclaw/plugin-demo@1.0.0",
        installPath: "/missing/demo",
      },
    };
    const repairWarning =
      'Could not repair openclaw peer link for "demo" at /tmp/openclaw-plugins/demo: permission denied';
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.updateNpmInstalledPlugins.mockImplementationOnce(
      async (params: {
        logger?: { warn?: (message: string) => void };
        config: Record<string, unknown>;
      }) => {
        params.logger?.warn?.(repairWarning);
        return {
          changed: true,
          config: {
            plugins: {
              installs: {
                demo: {
                  source: "npm",
                  spec: "@openclaw/plugin-demo@1.0.0",
                  installPath: "/tmp/openclaw-plugins/demo",
                },
              },
            },
          },
          outcomes: [
            {
              pluginId: "demo",
              status: "updated",
              message: "Updated demo.",
            },
          ],
        };
      },
    );

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: {
            demo: { enabled: true },
          },
        },
      },
      env: {},
    });

    expect(result.warnings).toContain(repairWarning);
    expect(result.notices ?? []).not.toContain(repairWarning);
  });

  it("keeps ClawHub review notices non-fatal during persisted-record repair", async () => {
    const records = {
      demo: {
        source: "clawhub",
        spec: "clawhub:@openclaw/plugin-demo@1.0.0",
        clawhubPackage: "@openclaw/plugin-demo",
        installPath: "/missing/demo",
      },
    };
    const reviewNotice =
      "╭─ ClawHub Security Audit ────────────────────────────────╮\n" +
      "│ Outcome: Review                                        │\n" +
      "╰───────────────────────────────────────────────────────────────────────╯";
    const coloredReviewNotice = `\u001b[33m${reviewNotice}\u001b[39m`;
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.updateNpmInstalledPlugins.mockImplementationOnce(
      async (params: {
        logger?: { warn?: (message: string) => void };
        config: Record<string, unknown>;
      }) => {
        params.logger?.warn?.(coloredReviewNotice);
        return {
          changed: true,
          config: {
            plugins: {
              installs: {
                demo: {
                  source: "clawhub",
                  spec: "clawhub:@openclaw/plugin-demo@1.0.0",
                  installPath: "/tmp/openclaw-plugins/demo",
                },
              },
            },
          },
          outcomes: [
            {
              pluginId: "demo",
              status: "updated",
              message: "Updated demo.",
            },
          ],
        };
      },
    );

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: {
            demo: { enabled: true },
          },
        },
      },
      env: {},
    });

    expect(result.notices).toContain(reviewNotice);
    expect(result.notices?.[0]).not.toContain("\u001b");
    expect(result.warnings).toStrictEqual([]);
  });

  it("repairs a broken managed package entry from its attributed registry diagnostic", async () => {
    const records = {
      demo: {
        source: "npm",
        spec: "@openclaw/plugin-demo@1.0.0",
        resolvedName: "@openclaw/plugin-demo",
        resolvedSpec: "@openclaw/plugin-demo@1.0.0",
        resolvedVersion: "1.0.0",
        integrity: "sha512-demo",
        installPath: "/tmp/openclaw-plugins/demo",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [],
      diagnostics: [
        {
          level: "error",
          pluginId: "demo",
          message: "extension entry escapes package directory: ./index.ts",
        },
      ],
    });
    mocks.updateNpmInstalledPlugins.mockResolvedValue({
      changed: true,
      config: {
        plugins: {
          installs: {
            demo: {
              source: "npm",
              spec: "@openclaw/plugin-demo@1.0.0",
              installPath: "/tmp/openclaw-plugins/demo",
            },
          },
        },
      },
      outcomes: [
        {
          pluginId: "demo",
          status: "updated",
          message: "Updated demo.",
        },
      ],
    });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {},
      env: {},
    });

    const updateArg = expectRecordFields(mockCallArg(mocks.updateNpmInstalledPlugins), {
      pluginIds: ["demo"],
    });
    const updateConfig = updateArg.config as { plugins?: { installs?: Record<string, unknown> } };
    const updateRecord = expectRecordFields(updateConfig.plugins?.installs?.demo, {
      source: "npm",
      spec: "@openclaw/plugin-demo@1.0.0",
      integrity: "sha512-demo",
      installPath: "/tmp/openclaw-plugins/demo",
    });
    expect(updateRecord.resolvedSpec).toBeUndefined();
    expect(updateRecord.resolvedVersion).toBeUndefined();
    expect(result.changes).toEqual(['Repaired broken installed plugin "demo".']);
  });

  it("detects an installed plugin whose required dependencies are missing on disk", async () => {
    const pluginDir = path.join(tempDirs.make("openclaw-plugin-dep-"), "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "@openclaw/plugin-demo", version: "1.0.0" }),
      "utf8",
    );
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      demo: {
        source: "npm",
        spec: "@openclaw/plugin-demo@1.0.0",
        installPath: pluginDir,
      },
    });
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "demo",
          channels: [],
          rootDir: pluginDir,
          packageDependencies: { "@example/required-runtime": "^1.0.0" },
        },
      ],
      diagnostics: [],
    });

    const {
      configuredPluginInstallIssueToHealthFinding,
      configuredPluginInstallIssueToRepairEffect,
      detectConfiguredPluginInstallHealthIssues,
    } = await import("./missing-configured-plugin-install.js");
    const issues = await detectConfiguredPluginInstallHealthIssues({ cfg: {}, env: {} });

    expect(issues).toEqual([
      {
        kind: "repairable-installed-plugin",
        pluginId: "demo",
        installPath: pluginDir,
        installSpec: "@openclaw/plugin-demo@1.0.0",
        missingDependencies: ["@example/required-runtime"],
      },
    ]);
    const issue = issues[0];
    if (!issue) {
      throw new Error("expected a repairable-installed-plugin issue");
    }
    expect(configuredPluginInstallIssueToHealthFinding(issue).message).toContain(
      "@example/required-runtime",
    );
    expect(configuredPluginInstallIssueToRepairEffect(issue)).toEqual({
      kind: "package",
      action: "would-repair-configured-plugin-install",
      target: "demo",
      dryRunSafe: false,
    });
  });

  it("detects missing dependencies when the active npm record differs from the official catalog", async () => {
    const pluginDir = path.join(tempDirs.make("openclaw-plugin-dep-"), "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "@example/plugin-demo", version: "1.0.0" }),
      "utf8",
    );
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      demo: {
        source: "npm",
        spec: "@example/plugin-demo@1.0.0",
        installPath: pluginDir,
      },
    });
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "demo",
          channels: [],
          rootDir: pluginDir,
          packageDependencies: { "@example/required-runtime": "^1.0.0" },
        },
      ],
      diagnostics: [],
    });
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        id: "demo",
        label: "Demo",
        install: {
          npmSpec: "@openclaw/plugin-demo",
          defaultChoice: "npm",
        },
      },
    ]);

    const { detectConfiguredPluginInstallHealthIssues } =
      await import("./missing-configured-plugin-install.js");
    const issues = await detectConfiguredPluginInstallHealthIssues({
      cfg: { plugins: { entries: { demo: { enabled: true } } } },
      env: {},
    });

    expect(issues).toEqual([
      {
        kind: "repairable-installed-plugin",
        pluginId: "demo",
        installPath: pluginDir,
        installSpec: "@example/plugin-demo@1.0.0",
        missingDependencies: ["@example/required-runtime"],
      },
    ]);
  });

  it("detects required dependencies whose package directories are empty", async () => {
    const pluginDir = path.join(tempDirs.make("openclaw-plugin-dep-"), "demo");
    const dependencyDir = path.join(pluginDir, "node_modules", "@example", "required-runtime");
    fs.mkdirSync(dependencyDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "@openclaw/plugin-demo", version: "1.0.0" }),
      "utf8",
    );
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      demo: {
        source: "npm",
        spec: "@openclaw/plugin-demo@1.0.0",
        installPath: pluginDir,
      },
    });
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "demo",
          channels: [],
          rootDir: pluginDir,
          packageDependencies: { "@example/required-runtime": "^1.0.0" },
        },
      ],
      diagnostics: [],
    });

    const { detectConfiguredPluginInstallHealthIssues } =
      await import("./missing-configured-plugin-install.js");
    const issues = await detectConfiguredPluginInstallHealthIssues({ cfg: {}, env: {} });

    expect(issues).toEqual([
      {
        kind: "repairable-installed-plugin",
        pluginId: "demo",
        installPath: pluginDir,
        installSpec: "@openclaw/plugin-demo@1.0.0",
        missingDependencies: ["@example/required-runtime"],
      },
    ]);
  });

  it("does not flag installed plugins whose declared dependencies resolve", async () => {
    const pluginDir = path.join(tempDirs.make("openclaw-plugin-dep-"), "demo");
    const depDir = path.join(pluginDir, "node_modules", "@example", "required-runtime");
    fs.mkdirSync(depDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "@openclaw/plugin-demo", version: "1.0.0" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(depDir, "package.json"),
      JSON.stringify({ name: "@example/required-runtime", version: "1.0.0" }),
      "utf8",
    );
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      demo: {
        source: "npm",
        spec: "@openclaw/plugin-demo@1.0.0",
        installPath: pluginDir,
      },
    });
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "demo",
          channels: [],
          rootDir: pluginDir,
          packageDependencies: { "@example/required-runtime": "^1.0.0" },
        },
      ],
      diagnostics: [],
    });

    const { detectConfiguredPluginInstallHealthIssues } =
      await import("./missing-configured-plugin-install.js");
    const issues = await detectConfiguredPluginInstallHealthIssues({ cfg: {}, env: {} });

    expect(issues).toEqual([]);
  });

  it("does not advertise dependency repair for non-updateable install sources", async () => {
    const pluginDir = path.join(tempDirs.make("openclaw-plugin-dep-"), "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "@openclaw/plugin-demo", version: "1.0.0" }),
      "utf8",
    );
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      demo: {
        source: "archive",
        spec: "/tmp/plugin-demo.tgz",
        installPath: pluginDir,
      },
    });
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "demo",
          channels: [],
          rootDir: pluginDir,
          packageDependencies: { "@example/required-runtime": "^1.0.0" },
        },
      ],
      diagnostics: [],
    });

    const { detectConfiguredPluginInstallHealthIssues } =
      await import("./missing-configured-plugin-install.js");
    const issues = await detectConfiguredPluginInstallHealthIssues({ cfg: {}, env: {} });

    expect(issues).toEqual([]);
  });

  it("does not attribute a same-id config plugin's missing dependencies to an installed record", async () => {
    const tempRoot = tempDirs.make("openclaw-plugin-dep-");
    const installedPluginDir = path.join(tempRoot, "installed-demo");
    const configuredPluginDir = path.join(tempRoot, "configured-demo");
    const installedDependencyDir = path.join(
      installedPluginDir,
      "node_modules",
      "@example",
      "required-runtime",
    );
    fs.mkdirSync(installedDependencyDir, { recursive: true });
    fs.mkdirSync(configuredPluginDir, { recursive: true });
    for (const pluginDir of [installedPluginDir, configuredPluginDir]) {
      fs.writeFileSync(
        path.join(pluginDir, "package.json"),
        JSON.stringify({ name: "@openclaw/plugin-demo", version: "1.0.0" }),
        "utf8",
      );
    }
    fs.writeFileSync(
      path.join(installedDependencyDir, "package.json"),
      JSON.stringify({ name: "@example/required-runtime", version: "1.0.0" }),
      "utf8",
    );
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      demo: {
        source: "npm",
        spec: "@openclaw/plugin-demo@1.0.0",
        installPath: installedPluginDir,
      },
    });
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "demo",
          channels: [],
          origin: "config",
          rootDir: configuredPluginDir,
          packageDependencies: { "@example/required-runtime": "^1.0.0" },
        },
      ],
      diagnostics: [],
    });

    const { detectConfiguredPluginInstallHealthIssues } =
      await import("./missing-configured-plugin-install.js");
    const issues = await detectConfiguredPluginInstallHealthIssues({ cfg: {}, env: {} });

    expect(issues).toEqual([]);
  });

  it.each([
    ["globally disabled", { enabled: false }],
    ["entry-disabled", { entries: { demo: { enabled: false } } }],
  ] as const)(
    "ignores %s installed plugins whose required dependencies are missing",
    async (_label, plugins) => {
      const pluginDir = path.join(tempDirs.make("openclaw-plugin-dep-"), "node_modules", "demo");
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "package.json"),
        JSON.stringify({ name: "@openclaw/plugin-demo", version: "1.0.0" }),
        "utf8",
      );
      const cfg = { plugins } as OpenClawConfig;
      const records = {
        demo: {
          source: "npm" as const,
          spec: "@openclaw/plugin-demo@1.0.0",
          installPath: pluginDir,
        },
      };
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mocks.loadPluginMetadataSnapshot.mockReturnValue({
        plugins: [
          {
            id: "demo",
            channels: [],
            origin: "global",
            rootDir: pluginDir,
            packageDependencies: { "@example/required-runtime": "^1.0.0" },
          },
        ],
        diagnostics: [],
      });
      mocks.updateNpmInstalledPlugins.mockResolvedValue({
        changed: false,
        config: { plugins: { ...plugins, installs: records } },
        outcomes: [
          {
            pluginId: "demo",
            status: "skipped",
            message: 'Skipping "demo" (disabled by plugin config).',
          },
        ],
      });

      const { detectConfiguredPluginInstallHealthIssues, repairMissingConfiguredPluginInstalls } =
        await import("./missing-configured-plugin-install.js");
      const issues = await detectConfiguredPluginInstallHealthIssues({ cfg, env: {} });
      const result = await repairMissingConfiguredPluginInstalls({ cfg, env: {} });

      expect.soft(issues).toEqual([]);
      expect.soft(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
      expect.soft(hasRetainedManagedNpmInstallMarker(pluginDir)).toBe(false);
      expect.soft(result).toEqual({ changes: [], warnings: [], records });
    },
  );

  it("repairs an installed plugin whose required dependencies are missing on disk", async () => {
    const pluginDir = path.join(tempDirs.make("openclaw-plugin-dep-"), "node_modules", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "@openclaw/plugin-demo", version: "1.0.0" }),
      "utf8",
    );
    const records = {
      demo: {
        source: "npm",
        spec: "@openclaw/plugin-demo@1.0.0",
        resolvedName: "@openclaw/plugin-demo",
        resolvedSpec: "@openclaw/plugin-demo@1.0.0",
        resolvedVersion: "1.0.0",
        installPath: pluginDir,
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "demo",
          channels: [],
          rootDir: pluginDir,
          packageDependencies: { "@example/required-runtime": "^1.0.0" },
        },
      ],
      diagnostics: [],
    });
    const repairedPluginDir = tempDirs.make("openclaw-plugin-repaired-generation-");
    fs.writeFileSync(
      path.join(repairedPluginDir, "package.json"),
      JSON.stringify({ name: "@openclaw/plugin-demo", version: "1.0.0" }),
      "utf8",
    );
    mocks.updateNpmInstalledPlugins.mockResolvedValue({
      changed: true,
      config: {
        plugins: {
          installs: {
            demo: {
              source: "npm",
              spec: "@openclaw/plugin-demo@1.0.0",
              installPath: repairedPluginDir,
            },
          },
        },
      },
      outcomes: [
        {
          pluginId: "demo",
          status: "updated",
          message: "Updated demo.",
        },
      ],
    });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {},
      env: {},
    });

    const updateArg = expectRecordFields(mockCallArg(mocks.updateNpmInstalledPlugins), {
      pluginIds: ["demo"],
    });
    const updateConfig = updateArg.config as { plugins?: { installs?: Record<string, unknown> } };
    const updateRecord = expectRecordFields(updateConfig.plugins?.installs?.demo, {
      source: "npm",
      spec: "@openclaw/plugin-demo@1.0.0",
      installPath: pluginDir,
    });
    expect(updateRecord.resolvedSpec).toBeUndefined();
    expect(updateRecord.resolvedVersion).toBeUndefined();
    expect(hasRetainedManagedNpmInstallMarker(pluginDir)).toBe(true);
    expect(result.changes).toEqual(['Repaired broken installed plugin "demo".']);
  });

  it("reports skipped dependency repairs while completing other plugins", async () => {
    const skippedPluginDir = path.join(
      tempDirs.make("openclaw-plugin-dep-"),
      "node_modules",
      "skipped",
    );
    const repairedPluginDir = path.join(
      tempDirs.make("openclaw-plugin-dep-"),
      "node_modules",
      "repaired",
    );
    for (const [pluginDir, packageName] of [
      [skippedPluginDir, "@openclaw/plugin-skipped"],
      [repairedPluginDir, "@openclaw/plugin-repaired"],
    ] as const) {
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "package.json"),
        JSON.stringify({ name: packageName, version: "1.0.0" }),
        "utf8",
      );
    }
    const records = {
      skipped: {
        source: "npm",
        installPath: skippedPluginDir,
      },
      repaired: {
        source: "npm",
        spec: "@openclaw/plugin-repaired@1.0.0",
        installPath: repairedPluginDir,
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "skipped",
          channels: [],
          rootDir: skippedPluginDir,
          packageDependencies: { "@example/skipped-runtime": "^1.0.0" },
        },
        {
          id: "repaired",
          channels: [],
          rootDir: repairedPluginDir,
          packageDependencies: { "@example/repaired-runtime": "^1.0.0" },
        },
      ],
      diagnostics: [],
    });
    const skippedMessage = 'Skipping "skipped" (missing npm spec).';
    const repairedTargetDir = tempDirs.make("openclaw-plugin-repaired-generation-");
    mocks.updateNpmInstalledPlugins.mockResolvedValue({
      changed: true,
      config: {
        plugins: {
          installs: {
            ...records,
            repaired: { ...records.repaired, installPath: repairedTargetDir },
          },
        },
      },
      outcomes: [
        {
          pluginId: "skipped",
          status: "skipped",
          message: skippedMessage,
        },
        {
          pluginId: "repaired",
          status: "updated",
          message: "Updated repaired.",
        },
      ],
    });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({ cfg: {}, env: {} });

    expectRecordFields(mockCallArg(mocks.updateNpmInstalledPlugins), {
      pluginIds: ["skipped", "repaired"],
    });
    expect(hasRetainedManagedNpmInstallMarker(skippedPluginDir)).toBe(false);
    expect(hasRetainedManagedNpmInstallMarker(repairedPluginDir)).toBe(true);
    expect(result.changes).toEqual(['Repaired broken installed plugin "repaired".']);
    expect(result.warnings).toEqual([skippedMessage]);
    expect(result.repairedPluginIds).toEqual(["repaired"]);
    expect(result.failedPluginIds).toEqual(["skipped"]);
  });

  it("routes official missing-dependency repairs through retained npm update", async () => {
    const pluginDir = path.join(tempDirs.make("openclaw-plugin-dep-"), "node_modules", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "@openclaw/plugin-demo", version: "1.0.0" }),
      "utf8",
    );
    const records = {
      demo: {
        source: "npm",
        spec: "@openclaw/plugin-demo@1.0.0",
        resolvedName: "@openclaw/plugin-demo",
        resolvedSpec: "@openclaw/plugin-demo@1.0.0",
        resolvedVersion: "1.0.0",
        installPath: pluginDir,
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "demo",
          channels: [],
          rootDir: pluginDir,
          packageDependencies: { "@example/required-runtime": "^1.0.0" },
        },
      ],
      diagnostics: [],
    });
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      {
        id: "demo",
        label: "Demo",
        install: { npmSpec: "@openclaw/plugin-demo@1.0.0" },
      },
    ]);
    mocks.installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: pluginDir,
      version: "1.0.0",
      npmResolution: {
        name: "@openclaw/plugin-demo",
        version: "1.0.0",
        resolvedSpec: "@openclaw/plugin-demo@1.0.0",
        integrity: "sha512-demo",
        resolvedAt: "2026-07-10T00:00:00.000Z",
      },
    });
    const repairedPluginDir = tempDirs.make("openclaw-plugin-repaired-generation-");
    fs.writeFileSync(
      path.join(repairedPluginDir, "package.json"),
      JSON.stringify({ name: "@openclaw/plugin-demo", version: "1.0.0" }),
      "utf8",
    );
    mocks.updateNpmInstalledPlugins.mockResolvedValue({
      changed: true,
      config: {
        plugins: {
          installs: {
            demo: {
              source: "npm",
              spec: "@openclaw/plugin-demo@1.0.0",
              installPath: repairedPluginDir,
            },
          },
        },
      },
      outcomes: [{ pluginId: "demo", status: "updated", message: "Updated demo." }],
    });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    await repairMissingConfiguredPluginInstalls({
      cfg: { plugins: { entries: { demo: {} } } },
      env: {},
    });

    expect(mocks.updateNpmInstalledPlugins).toHaveBeenCalledOnce();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(hasRetainedManagedNpmInstallMarker(pluginDir)).toBe(true);
  });

  it("skips dependency repair when retention marker setup fails", async () => {
    const projectRoot = tempDirs.make("openclaw-plugin-dep-");
    const pluginDir = path.join(projectRoot, "node_modules", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "@openclaw/plugin-demo", version: "1.0.0" }),
      "utf8",
    );
    fs.writeFileSync(path.join(projectRoot, ".openclaw-retained-npm-installs"), "blocked");
    const records = {
      demo: {
        source: "npm",
        spec: "@openclaw/plugin-demo@1.0.0",
        installPath: pluginDir,
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "demo",
          channels: [],
          rootDir: pluginDir,
          packageDependencies: { "@example/required-runtime": "^1.0.0" },
        },
      ],
      diagnostics: [],
    });
    mocks.updateNpmInstalledPlugins.mockResolvedValue({
      changed: false,
      config: { plugins: { installs: records } },
      outcomes: [],
    });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({ cfg: {}, env: {} });

    expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(result.changes).toEqual([]);
    expect(
      result.warnings.some((warning) =>
        warning.includes('Failed to prepare a fresh dependency-repair generation for "demo"'),
      ),
    ).toBe(true);
  });

  it("clears dependency-repair retention when the npm update fails", async () => {
    const pluginDir = path.join(tempDirs.make("openclaw-plugin-dep-"), "node_modules", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "@openclaw/plugin-demo", version: "1.0.0" }),
      "utf8",
    );
    const records = {
      demo: {
        source: "npm",
        spec: "@openclaw/plugin-demo@1.0.0",
        installPath: pluginDir,
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "demo",
          channels: [],
          rootDir: pluginDir,
          packageDependencies: { "@example/required-runtime": "^1.0.0" },
        },
      ],
      diagnostics: [],
    });
    mocks.updateNpmInstalledPlugins.mockResolvedValue({
      changed: false,
      config: { plugins: { installs: records } },
      outcomes: [
        {
          pluginId: "demo",
          status: "error",
          message: "update failed",
        },
      ],
    });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({ cfg: {}, env: {} });

    expect(hasRetainedManagedNpmInstallMarker(pluginDir)).toBe(false);
    expect(result.warnings).toContain("update failed");
  });

  it("reports capability consent as a warning for a hollow retained install", async () => {
    const pluginDir = path.join(tempDirs.make("openclaw-plugin-dep-"), "node_modules", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "@openclaw/plugin-demo", version: "1.0.0" }),
      "utf8",
    );
    const records = {
      demo: {
        source: "npm",
        spec: "@openclaw/plugin-demo@1.0.0",
        installPath: pluginDir,
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "demo",
          channels: [],
          rootDir: pluginDir,
          packageDependencies: { "@example/required-runtime": "^1.0.0" },
        },
      ],
      diagnostics: [],
    });
    mocks.updateNpmInstalledPlugins.mockResolvedValue({
      changed: false,
      config: { plugins: { installs: records } },
      outcomes: [
        {
          pluginId: "demo",
          status: "error",
          code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
          message: "Review replacement capabilities.",
        },
      ],
    });

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: { plugins: { entries: { demo: { enabled: true } } } },
      env: {},
    });

    expect(hasRetainedManagedNpmInstallMarker(pluginDir)).toBe(false);
    expect(result.warnings).toEqual(["Review replacement capabilities."]);
    expect(result.notices).toBeUndefined();
    expect(result.failedPluginIds).toEqual(["demo"]);
  });

  it("clears dependency-repair retention when the npm updater throws", async () => {
    const pluginDir = path.join(tempDirs.make("openclaw-plugin-dep-"), "node_modules", "demo");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ name: "@openclaw/plugin-demo", version: "1.0.0" }),
      "utf8",
    );
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({
      demo: {
        source: "npm",
        spec: "@openclaw/plugin-demo@1.0.0",
        installPath: pluginDir,
      },
    });
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "demo",
          channels: [],
          rootDir: pluginDir,
          packageDependencies: { "@example/required-runtime": "^1.0.0" },
        },
      ],
      diagnostics: [],
    });
    mocks.updateNpmInstalledPlugins.mockRejectedValue(new Error("updater exploded"));

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    await expect(repairMissingConfiguredPluginInstalls({ cfg: {}, env: {} })).rejects.toThrow(
      "updater exploded",
    );

    expect(hasRetainedManagedNpmInstallMarker(pluginDir)).toBe(false);
  });

  it("reinstalls a known configured plugin from the catalog when its recorded install path is missing", async () => {
    const records = installedRecords("discord", {
      spec: "@openclaw/discord",
      installPath: "/tmp/openclaw-missing-discord-install-record",
    });
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "discord",
          channels: ["discord"],
        },
      ],
      diagnostics: [],
    });
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      channelPluginEntry({
        id: "discord",
        npmSpec: "@openclaw/discord",
        label: "Discord",
        trustedSourceLinkedOfficialInstall: true,
      }),
    ]);
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "discord",
        npmSpec: "@openclaw/discord",
        version: "1.2.3",
      }),
    );
    mocks.updateNpmInstalledPlugins.mockResolvedValue({
      changed: false,
      config: {
        plugins: {
          installs: records,
        },
      },
      outcomes: [
        {
          pluginId: "discord",
          status: "skipped",
          message: "No update applied.",
        },
      ],
    });

    const result = await repairConfiguredPlugins({
      plugins: {
        entries: {
          discord: { enabled: true },
        },
      },
      channels: {
        discord: { enabled: true },
      },
    });

    const updateArg = expectRecordFields(mockCallArg(mocks.updateNpmInstalledPlugins), {
      pluginIds: ["discord"],
    });
    const updateConfig = updateArg.config as Record<string, unknown>;
    expectRecordFields(updateConfig.plugins, { installs: records });
    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: expectedNpmInstallSpec("@openclaw/discord"),
      expectedPluginId: "discord",
      trustedSourceLinkedOfficialInstall: true,
    });
    const persistedRecords = mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords);
    expectRecordFields((persistedRecords as Record<string, unknown>).discord, {
      spec: "@openclaw/discord",
      installPath: "/tmp/openclaw-plugins/discord",
    });
    expect(mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords, 0, 1)).toEqual({
      config: expect.any(Object),
      env: {},
    });
    expect(result.changes).toEqual([
      `Installed missing configured plugin "discord" from ${expectedNpmInstallSpec("@openclaw/discord")}.`,
    ]);
  });

  it("updates a known configured plugin when its installed manifest path still exists", async () => {
    const records = installedRecords("discord", {
      spec: "@openclaw/discord",
      installPath: process.cwd(),
    });
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "discord",
          channels: ["discord"],
        },
      ],
      diagnostics: [
        {
          pluginId: "discord",
          message: "manifest without channelConfigs metadata",
        },
      ],
    });
    mocks.updateNpmInstalledPlugins.mockResolvedValue(
      successfulUpdate(
        "discord",
        installedRecords("discord", {
          spec: "@openclaw/discord",
          installPath: process.cwd(),
        }),
      ),
    );

    const result = await repairConfiguredPlugins({
      plugins: {
        entries: {
          discord: { enabled: true },
        },
      },
      channels: {
        discord: { enabled: true },
      },
    });

    const updateArg = expectRecordFields(mockCallArg(mocks.updateNpmInstalledPlugins), {
      pluginIds: ["discord"],
    });
    const updateConfig = updateArg.config as Record<string, unknown>;
    expectRecordFields(updateConfig.plugins, { installs: records });
    const persistedRecords = mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords);
    expectRecordFields((persistedRecords as Record<string, unknown>).discord, {
      installPath: process.cwd(),
    });
    expect(mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords, 0, 1)).toEqual({
      config: expect.any(Object),
      env: {},
    });
    expect(result.changes).toEqual(['Repaired missing configured plugin "discord".']);
  });

  it("updates a configured plugin when its installed manifest lacks channel config descriptors", async () => {
    const records = installedRecords("discord", {
      spec: "@openclaw/discord",
      installPath: "/tmp/openclaw-plugins/discord",
    });
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      channelPluginEntry({
        id: "discord",
        npmSpec: "@openclaw/discord",
        label: "Discord",
      }),
    ]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "discord",
          channels: ["discord"],
        },
      ],
      diagnostics: [
        {
          level: "warn",
          pluginId: "discord",
          message:
            "channel plugin manifest declares discord without channelConfigs metadata; add openclaw.plugin.json#channelConfigs so config schema and setup surfaces work before runtime loads",
        },
      ],
    });
    mocks.updateNpmInstalledPlugins.mockResolvedValue(
      successfulUpdate(
        "discord",
        installedRecords("discord", {
          spec: "@openclaw/discord",
          installPath: process.cwd(),
        }),
      ),
    );

    const result = await repairConfiguredPlugins({
      update: { channel: "beta" },
      plugins: {
        entries: {
          discord: { enabled: true },
        },
      },
      channels: {
        discord: { enabled: true },
      },
    });

    const updateArg = expectRecordFields(mockCallArg(mocks.updateNpmInstalledPlugins), {
      pluginIds: ["discord"],
      updateChannel: "beta",
    });
    const updateConfig = updateArg.config as Record<string, unknown>;
    expectRecordFields(updateConfig.plugins, { installs: records });
    const persistedRecords = mockCallArg(
      mocks.writePersistedInstalledPluginIndexInstallRecords,
    ) as Record<string, unknown>;
    expectRecordFields(persistedRecords.discord, { installPath: process.cwd() });
    expect(mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords, 0, 1)).toEqual({
      config: expect.any(Object),
      env: {},
    });
    expect(result).toEqual({
      changes: ['Repaired missing configured plugin "discord".'],
      warnings: [],
      repairedPluginIds: ["discord"],
      pluginInventoryChanged: true,
      records: installedRecords("discord", {
        spec: "@openclaw/discord",
        installPath: process.cwd(),
      }),
    });
  });

  it("reinstalls a recorded external web search plugin from provider-only config", async () => {
    const records = installedRecords("brave", {
      spec: "@openclaw/brave-plugin@beta",
      installPath: "/missing/brave",
    });
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      officialWebSearchPluginEntry({
        id: "brave",
        npmSpec: "@openclaw/brave-plugin",
        envVar: "BRAVE_API_KEY",
        label: "Brave",
        providerLabel: "Brave Search",
      }),
    ]);
    mocks.updateNpmInstalledPlugins.mockResolvedValue(
      successfulUpdate(
        "brave",
        installedRecords("brave", {
          spec: "@openclaw/brave-plugin@beta",
          installPath: process.cwd(),
        }),
      ),
    );

    const result = await repairConfiguredPlugins({
      tools: {
        web: {
          search: {
            provider: "brave",
          },
        },
      },
    });

    const updateArg = expectRecordFields(mockCallArg(mocks.updateNpmInstalledPlugins), {
      pluginIds: ["brave"],
    });
    const updateConfig = updateArg.config as Record<string, unknown>;
    expectRecordFields(updateConfig.plugins, { installs: records });
    const persistedRecords = mockCallArg(
      mocks.writePersistedInstalledPluginIndexInstallRecords,
    ) as Record<string, unknown>;
    expectRecordFields(persistedRecords.brave, { installPath: process.cwd() });
    expect(mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords, 0, 1)).toEqual({
      config: expect.any(Object),
      env: {},
    });
    expect(result.changes).toEqual(['Repaired missing configured plugin "brave".']);
  });

  it.each([
    {
      name: "replaces a configured official web search plugin when its installed package is source-only",
      pluginId: "brave",
      npmSpec: "@openclaw/brave-plugin",
      priorSpec: "clawhub:@openclaw/brave-plugin@2026.5.1-beta.1",
      targetDir: "/tmp/openclaw-plugins/brave",
      cfg: { tools: { web: { search: { provider: "brave" } } } } satisfies OpenClawConfig,
      catalogKind: "provider" as const,
    },
    {
      name: "replaces a configured official channel plugin when only its channel is configured",
      pluginId: "slack",
      npmSpec: "@openclaw/slack",
      priorSpec: "clawhub:@openclaw/slack@2026.5.12-beta.1",
      targetDir: "/tmp/openclaw-npm/node_modules/@openclaw/slack",
      cfg: { channels: { slack: { enabled: true, botToken: "xoxb-test" } } },
      catalogKind: "channel" as const,
    },
  ])("$name", async ({ pluginId, npmSpec, priorSpec, targetDir, cfg, catalogKind }) => {
    const extensionsDir = path.join(tempDirs.make("openclaw-plugin-stub-repair-"), "extensions");
    const installDir = path.join(extensionsDir, pluginId);
    mocks.resolveDefaultPluginExtensionsDir.mockReturnValue(extensionsDir);
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: pluginId }));
    const records = installedRecords(pluginId, {
      source: "clawhub",
      spec: priorSpec,
      installPath: installDir,
      clawhubPackage: npmSpec,
      clawhubChannel: "official",
      clawhubUrl: "https://clawhub.ai",
    });
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue(brokenPluginSnapshot(pluginId));
    if (catalogKind === "provider") {
      mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
        officialWebSearchPluginEntry({
          id: pluginId,
          npmSpec,
          envVar: "BRAVE_API_KEY",
          label: "Brave",
          providerLabel: "Brave Search",
        }),
      ]);
    } else {
      mocks.listChannelPluginCatalogEntries.mockReturnValue([
        channelPluginEntry({
          id: pluginId,
          npmSpec,
          label: "Slack",
          trustedSourceLinkedOfficialInstall: true,
        }),
      ]);
    }
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({ pluginId, npmSpec, version: "2026.5.12", targetDir }),
    );

    const result = await repairConfiguredPlugins(cfg);

    expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(fs.existsSync(installDir)).toBe(false);
    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: expectedNpmInstallSpec(npmSpec),
      expectedPluginId: pluginId,
      trustedSourceLinkedOfficialInstall: true,
      mode: "update",
    });
    const persistedRecords = mockCallArg(
      mocks.writePersistedInstalledPluginIndexInstallRecords,
    ) as Record<string, unknown>;
    expectRecordFields(persistedRecords[pluginId], {
      source: "npm",
      spec: npmSpec,
      installPath: targetDir,
      version: "2026.5.12",
    });
    expect(result).toEqual({
      changes: [
        `Installed missing configured plugin "${pluginId}" from ${expectedNpmInstallSpec(npmSpec)}.`,
      ],
      warnings: [],
      repairedPluginIds: [pluginId],
      pluginInventoryChanged: true,
      records: persistedRecords,
    });
  });

  it("does not delete an arbitrary recorded path when replacing a broken official plugin", async () => {
    const installDir = tempDirs.make("openclaw-plugin-stub-repair-");
    fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "brave" }));
    mockBrokenBraveInstall(installDir, {
      source: "clawhub",
      spec: "clawhub:@openclaw/brave-plugin@2026.5.1-beta.1",
      clawhubPackage: "@openclaw/brave-plugin",
      clawhubChannel: "official",
      clawhubUrl: "https://clawhub.ai",
    });
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "brave",
        npmSpec: "@openclaw/brave-plugin",
        version: "2026.5.12",
      }),
    );

    await repairConfiguredPlugins({
      tools: {
        web: {
          search: {
            provider: "brave",
          },
        },
      },
    });

    expect(fs.existsSync(installDir)).toBe(true);
    expect(mocks.installPluginFromNpmSpec).toHaveBeenCalled();
  });

  it("keeps a broken official install record when replacement install fails", async () => {
    const extensionsDir = path.join(tempDirs.make("openclaw-plugin-stub-repair-"), "extensions");
    const installDir = path.join(extensionsDir, "brave");
    mocks.resolveDefaultPluginExtensionsDir.mockReturnValue(extensionsDir);
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "brave" }));
    const records = mockBrokenBraveInstall(installDir, {
      source: "clawhub",
      spec: "clawhub:@openclaw/brave-plugin@2026.5.1-beta.1",
      clawhubPackage: "@openclaw/brave-plugin",
      clawhubChannel: "official",
      clawhubUrl: "https://clawhub.ai",
    });
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce({
      ok: false,
      error: "network unavailable",
    });

    const result = await repairConfiguredPlugins({
      tools: {
        web: {
          search: {
            provider: "brave",
          },
        },
      },
    });

    expect(fs.existsSync(installDir)).toBe(true);
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(result).toEqual({
      changes: [],
      warnings: [
        `Failed to install missing configured plugin "brave" from ${expectedNpmInstallSpec("@openclaw/brave-plugin")}: network unavailable`,
      ],
      failedPluginIds: ["brave"],
      records,
    });
  });

  it("does not replace a non-official install that collides with an official plugin id", async () => {
    const extensionsDir = path.join(tempDirs.make("openclaw-plugin-stub-repair-"), "extensions");
    const installDir = path.join(extensionsDir, "brave");
    mocks.resolveDefaultPluginExtensionsDir.mockReturnValue(extensionsDir);
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "brave" }));
    const records = mockBrokenBraveInstall(installDir, {
      source: "path",
      sourcePath: installDir,
    });

    const result = await repairConfiguredPlugins({
      tools: {
        web: {
          search: {
            provider: "brave",
          },
        },
      },
    });

    expect(fs.existsSync(installDir)).toBe(true);
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(result).toEqual({
      changes: [],
      warnings: [],
      records,
    });
  });

  it("installs configured external speech and web-fetch plugins from selected providers", async () => {
    const packages = [
      ["firecrawl", "@openclaw/firecrawl-plugin"],
      ["gradium", "@openclaw/gradium-speech"],
      ["inworld", "@openclaw/inworld-speech"],
    ] as const;
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue(
      packages.map(([id, npmSpec]) =>
        officialPluginEntry({
          id,
          npmSpec,
        }),
      ),
    );
    mocks.resolveOfficialExternalProviderContractPluginIds.mockImplementation(
      ({ contract }: { contract: string }) => {
        if (contract === "webFetchProviders") {
          return ["firecrawl"];
        }
        if (contract === "speechProviders") {
          return ["gradium", "inworld"];
        }
        return [];
      },
    );
    for (const [pluginId, npmSpec] of packages) {
      mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
        successfulInstall({ pluginId, npmSpec }),
      );
    }

    const result = await repairConfiguredPlugins({
      tts: {
        provider: "gradium",
        providers: {
          inworld: {},
        },
      },
      tools: {
        web: {
          fetch: {
            provider: "firecrawl",
          },
        },
      },
    });

    expect(
      mocks.installPluginFromNpmSpec.mock.calls.map(
        ([params]) => (params as { expectedPluginId?: string }).expectedPluginId,
      ),
    ).toEqual(["firecrawl", "gradium", "inworld"]);
    expect(result.changes).toEqual(
      packages.map(
        ([pluginId, npmSpec]) =>
          `Installed missing configured plugin "${pluginId}" from ${expectedNpmInstallSpec(npmSpec)}.`,
      ),
    );
  });

  it.each([
    {
      name: "installs missing configured non-channel plugins from the official external catalog",
      pluginId: "diagnostics-otel",
      npmSpec: "@openclaw/diagnostics-otel",
      version: "2026.5.2",
      entry: {
        id: "diagnostics-otel",
        label: "Diagnostics OpenTelemetry",
        install: {
          clawhubSpec: "clawhub:@openclaw/diagnostics-otel",
          npmSpec: "@openclaw/diagnostics-otel",
          defaultChoice: "npm" as const,
        },
      },
      cfg: { plugins: { entries: { "diagnostics-otel": { enabled: true } } } },
      useManifestResolvers: false,
    },
    {
      name: "installs the official llama.cpp plugin for configured local memory embeddings",
      pluginId: "llama-cpp",
      npmSpec: "@openclaw/llama-cpp-provider",
      version: "2026.6.2",
      entry: {
        id: "llama-cpp",
        label: "llama.cpp Provider",
        openclaw: {
          plugin: { id: "llama-cpp", label: "llama.cpp Provider" },
          contracts: { embeddingProviders: ["local"] },
          install: {
            npmSpec: "@openclaw/llama-cpp-provider",
            defaultChoice: "npm" as const,
          },
        },
        install: {
          npmSpec: "@openclaw/llama-cpp-provider",
          defaultChoice: "npm" as const,
        },
      },
      cfg: { memory: { search: { provider: "local" } }, agents: { defaults: {} } },
      useManifestResolvers: false,
    },
    {
      name: "does not let runtime fallback metadata override official catalog install specs",
      pluginId: "acpx",
      npmSpec: "@openclaw/acpx",
      version: "2026.5.2-beta.2",
      entry: {
        id: "acpx",
        label: "ACPX Runtime",
        install: { npmSpec: "@openclaw/acpx", defaultChoice: "npm" as const },
      },
      cfg: { acp: { backend: "acpx" } },
      useManifestResolvers: false,
    },
    {
      name: "installs a configured external web search plugin from provider-only config",
      pluginId: "brave",
      npmSpec: "@openclaw/brave-plugin",
      version: "2026.5.2",
      entry: officialWebSearchPluginEntry({
        id: "brave",
        npmSpec: "@openclaw/brave-plugin",
        envVar: "BRAVE_API_KEY",
        label: "Brave",
        providerLabel: "Brave Search",
        credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
        includeManifestInstall: true,
      }),
      cfg: { tools: { web: { search: { provider: "brave" } } } },
      useManifestResolvers: true,
    },
    {
      name: "installs a configured external model provider without an auth choice",
      pluginId: "groq",
      npmSpec: "@openclaw/groq-provider",
      entry: officialPluginEntry({
        id: "groq",
        npmSpec: "@openclaw/groq-provider",
        label: "Groq",
        manifest: { providers: [{ id: "groq" }] },
      }),
      cfg: {
        agents: { defaults: { model: "groq/llama-3.3-70b-versatile" } },
      } satisfies OpenClawConfig,
      useManifestResolvers: false,
    },
    {
      name: "installs an external media-understanding provider selected only by media config",
      pluginId: "groq",
      npmSpec: "@openclaw/groq-provider",
      entry: officialPluginEntry({
        id: "groq",
        npmSpec: "@openclaw/groq-provider",
        label: "Groq",
        manifest: { contracts: { mediaUnderstandingProviders: ["groq"] } },
      }),
      cfg: {
        tools: {
          media: {
            models: [
              {
                provider: "groq",
                model: "whisper-large-v3-turbo",
                capabilities: ["audio"],
              },
            ],
          },
        },
      } satisfies OpenClawConfig,
      useManifestResolvers: false,
    },
    {
      name: "installs an external speech provider selected only by voiceModel",
      pluginId: "gradium",
      npmSpec: "@openclaw/gradium-speech",
      entry: officialPluginEntry({
        id: "gradium",
        npmSpec: "@openclaw/gradium-speech",
        label: "Gradium",
        manifest: { contracts: { speechProviders: ["gradium"] } },
      }),
      cfg: {
        agents: { defaults: { voiceModel: { primary: "gradium/tts-default" } } },
      } satisfies OpenClawConfig,
      useManifestResolvers: false,
    },
  ])("$name", async ({ pluginId, npmSpec, version, entry, cfg, useManifestResolvers }) => {
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([entry]);
    if (useManifestResolvers) {
      useManifestCatalogResolvers();
    }
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({ pluginId, npmSpec, version }),
    );

    const result = await repairConfiguredPlugins(cfg);

    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: expectedNpmInstallSpec(npmSpec),
      expectedPluginId: pluginId,
      trustedSourceLinkedOfficialInstall: true,
    });
    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(result.changes).toEqual([
      `Installed missing configured plugin "${pluginId}" from ${expectedNpmInstallSpec(npmSpec)}.`,
    ]);
  });

  it("installs env-only web provider plugins before auto-detection", async () => {
    const packages = [
      ["exa", "@openclaw/exa-plugin", "EXA_API_KEY"],
      ["firecrawl", "@openclaw/firecrawl-plugin", "FIRECRAWL_API_KEY"],
    ] as const;
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue(
      packages.map(([id, npmSpec, envVar]) =>
        officialWebSearchPluginEntry({
          id,
          npmSpec,
          envVar,
          providerLabel: `${id} search`,
        }),
      ),
    );
    for (const [pluginId, npmSpec] of packages) {
      mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
        successfulInstall({ pluginId, npmSpec }),
      );
    }

    const result = await repairConfiguredPlugins(
      {},
      {
        EXA_API_KEY: "exa-key",
        FIRECRAWL_API_KEY: "firecrawl-key",
      },
    );

    expect(
      mocks.installPluginFromNpmSpec.mock.calls.map(
        ([params]) => (params as { expectedPluginId?: string }).expectedPluginId,
      ),
    ).toEqual(["exa", "firecrawl"]);
    expect(result.changes).toEqual(
      packages.map(
        ([pluginId, npmSpec]) =>
          `Installed missing configured plugin "${pluginId}" from ${expectedNpmInstallSpec(npmSpec)}.`,
      ),
    );
  });

  it("installs env-only provider plugins before model discovery", async () => {
    mocks.resolveOfficialExternalProviderPluginIdsForEnv.mockReturnValue(["groq"]);
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      officialPluginEntry({
        id: "groq",
        npmSpec: "@openclaw/groq-provider",
        label: "Groq",
        manifest: {},
      }),
    ]);
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "groq",
        npmSpec: "@openclaw/groq-provider",
      }),
    );

    const env = { GROQ_API_KEY: "groq-key" };
    const result = await repairConfiguredPlugins({}, env);

    expect(mocks.resolveOfficialExternalProviderPluginIdsForEnv).toHaveBeenCalledWith(env);
    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: expectedNpmInstallSpec("@openclaw/groq-provider"),
      expectedPluginId: "groq",
      trustedSourceLinkedOfficialInstall: true,
    });
    expect(result.changes).toEqual([
      `Installed missing configured plugin "groq" from ${expectedNpmInstallSpec("@openclaw/groq-provider")}.`,
    ]);
  });

  it("installs configured external web search plugins from beta on the beta channel", async () => {
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      officialWebSearchPluginEntry({
        id: "brave",
        npmSpec: "@openclaw/brave-plugin",
        envVar: "BRAVE_API_KEY",
        label: "Brave",
        providerLabel: "Brave Search",
        credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
        includeManifestInstall: true,
      }),
    ]);
    useManifestCatalogResolvers();
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "brave",
        npmSpec: "@openclaw/brave-plugin",
        version: "2026.5.4-beta.1",
      }),
    );

    const result = await repairConfiguredPlugins({
      update: { channel: "beta" },
      tools: {
        web: {
          search: {
            provider: "brave",
          },
        },
      },
    });

    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: "@openclaw/brave-plugin@beta",
      expectedPluginId: "brave",
      trustedSourceLinkedOfficialInstall: true,
    });
    const persistedRecords = mockCallArg(
      mocks.writePersistedInstalledPluginIndexInstallRecords,
    ) as Record<string, unknown>;
    expectRecordFields(persistedRecords.brave, {
      spec: "@openclaw/brave-plugin",
    });
    expect(mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords, 0, 1)).toEqual({
      config: expect.any(Object),
      env: {},
    });
    expect(result.changes).toEqual([
      'Installed missing configured plugin "brave" from @openclaw/brave-plugin@beta.',
    ]);
  });

  it("repairs a configured plugin from a legacy npm declaration stub", async () => {
    const root = tempDirs.make("openclaw-plugin-stub-repair-");
    const pluginDir = path.join(root, "extensions", "guardrail-bridge");
    writeLegacyNpmDeclarationStub({
      pluginDir,
      pluginId: "guardrail-bridge",
      npmSpec: "@guardrail-bridge/guardrail-bridge@1.0.0",
    });
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "guardrail-bridge",
        npmSpec: "@guardrail-bridge/guardrail-bridge",
        version: "1.0.0",
        resolution: {
          resolvedSpec: "@guardrail-bridge/guardrail-bridge@1.0.0",
          integrity: "sha512-guardrail",
        },
      }),
    );

    const result = await repairConfiguredPlugins({
      plugins: {
        load: {
          paths: [pluginDir],
        },
        entries: {
          "guardrail-bridge": { enabled: true },
        },
      },
    });

    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: "@guardrail-bridge/guardrail-bridge@1.0.0",
      expectedPluginId: "guardrail-bridge",
      extensionsDir: "/tmp/openclaw-plugins",
    });
    expect(mockCallArg(mocks.installPluginFromNpmSpec).trustedSourceLinkedOfficialInstall).toBe(
      undefined,
    );
    const records = mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords);
    expectRecordFields((records as Record<string, unknown>)["guardrail-bridge"], {
      source: "npm",
      spec: "@guardrail-bridge/guardrail-bridge@1.0.0",
      installPath: "/tmp/openclaw-plugins/guardrail-bridge",
      version: "1.0.0",
      resolvedName: "@guardrail-bridge/guardrail-bridge",
    });
    expect(result.changes).toEqual([
      'Installed missing configured plugin "guardrail-bridge" from @guardrail-bridge/guardrail-bridge@1.0.0.',
    ]);
    expect(result.warnings).toStrictEqual([]);
  });

  it("installs Firecrawl for env-only web fetch when search is disabled", async () => {
    mocks.resolveOfficialExternalWebProviderContractPluginIdsForEnv.mockReturnValue(["firecrawl"]);
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      officialPluginEntry({
        id: "firecrawl",
        npmSpec: "@openclaw/firecrawl-plugin",
        label: "Firecrawl",
        manifest: {},
      }),
    ]);
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "firecrawl",
        npmSpec: "@openclaw/firecrawl-plugin",
      }),
    );

    const env = { FIRECRAWL_API_KEY: "firecrawl-key" };
    const result = await repairConfiguredPlugins(
      {
        tools: {
          web: {
            search: {
              enabled: false,
            },
          },
        },
      },
      env,
    );

    expect(mocks.resolveOfficialExternalWebProviderContractPluginIdsForEnv).toHaveBeenCalledWith({
      contract: "webFetchProviders",
      env,
    });
    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: expectedNpmInstallSpec("@openclaw/firecrawl-plugin"),
      expectedPluginId: "firecrawl",
      trustedSourceLinkedOfficialInstall: true,
    });
    expect(result.changes).toEqual([
      `Installed missing configured plugin "firecrawl" from ${expectedNpmInstallSpec("@openclaw/firecrawl-plugin")}.`,
    ]);
  });

  it("does not install a configured external web search plugin when search is disabled", async () => {
    mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
      officialWebSearchPluginEntry({
        id: "brave",
        npmSpec: "@openclaw/brave-plugin",
        envVar: "BRAVE_API_KEY",
        label: "Brave",
        providerLabel: "Brave Search",
        credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
        includeManifestInstall: true,
      }),
    ]);
    useManifestCatalogResolvers();

    const result = await repairConfiguredPlugins(
      {
        tools: {
          web: {
            search: {
              enabled: false,
              provider: "brave",
            },
          },
        },
      },
      {
        BRAVE_API_KEY: "brave-key",
      },
    );

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], warnings: [], records: {} });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
