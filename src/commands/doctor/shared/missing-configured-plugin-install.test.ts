// Missing configured plugin install tests cover doctor diagnostics for absent plugin installs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { withIsolatedTestHome } from "../../../../test/test-env.js";
import type { OpenClawConfig, PluginsConfig } from "../../../config/types.js";
import { resolveRegistryUpdateChannel } from "../../../infra/update-channels.js";
import { resolvePluginArtifactDeclaredSurface } from "../../../plugins/capability-artifact.js";
import type { PluginCapabilityConsentHandler } from "../../../plugins/capability-consent.js";
import { computeDeclaredSurfaceHash } from "../../../plugins/capability-summary.js";
import { resolveClawHubInstallSpecsForUpdateChannel } from "../../../plugins/install-channel-specs.js";
import type { PluginInstallArtifactConsentHandler } from "../../../plugins/install-types.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../../plugins/installed-plugin-index-policy.js";
import { isTrustedOfficialPluginInstallRecord } from "../../../plugins/official-external-install-records.js";
import type { BundledProviderPolicySurface } from "../../../plugins/provider-policy-surface.js";
import { createColdPluginFixture } from "../../../plugins/test-helpers/cold-plugin-fixtures.js";
import { closeOpenClawStateDatabaseByPath } from "../../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
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
  return resolveRegistryUpdateChannel({ currentVersion: VERSION }) === "beta"
    ? `${spec}@${VERSION}`
    : spec;
}

function expectedClawHubInstallSpec(spec: string): string {
  return resolveClawHubInstallSpecsForUpdateChannel({
    spec,
    updateChannel: resolveRegistryUpdateChannel({ currentVersion: VERSION }),
  }).installSpec;
}

function expectedCodexInstallSpec(): string {
  return `@openclaw/codex@${VERSION}`;
}

function mockNpmRegistryTags(tags: { beta?: string; latest: string }): void {
  mocks.resolveNpmSpecMetadata.mockImplementation(async ({ spec }: { spec: string }) => {
    const selectorIndex = spec.lastIndexOf("@");
    const name = spec.slice(0, selectorIndex);
    const tag = spec.slice(selectorIndex + 1);
    const version = tag === "beta" ? tags.beta : tags.latest;
    return version
      ? { ok: true, metadata: { name, version, resolvedSpec: `${name}@${version}` } }
      : { ok: false, error: `No ${tag} release for ${name}.` };
  });
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
  resolveNpmSpecMetadata: vi.fn(),
  updateNpmInstalledPlugins: vi.fn(),
  writePersistedInstalledPluginIndexInstallRecords: vi.fn(),
}));

const testHome = withIsolatedTestHome({ mode: "hermetic" });
const testEnv: NodeJS.ProcessEnv = {
  HOME: testHome.tempHome,
  OPENCLAW_HOME: testHome.tempHome,
  OPENCLAW_STATE_DIR: path.join(testHome.tempHome, ".openclaw"),
};
afterAll(() => {
  closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(testEnv));
  testHome.cleanup();
});
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
  return repairMissingConfiguredPluginInstalls({ cfg, env: { ...testEnv, ...env } });
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
  mocks.loadPluginMetadataSnapshot.mockReturnValue(brokenPluginSnapshot("brave", installDir));
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

vi.mock("../../../plugins/install.js", () => ({
  installPluginFromNpmSpec: mocks.installPluginFromNpmSpec,
}));

vi.mock("../../../infra/install-source-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/install-source-utils.js")>()),
  resolveNpmSpecMetadata: mocks.resolveNpmSpecMetadata,
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
              acceptedSurface: resolvePluginArtifactDeclaredSurface(installDir),
              acceptedSurfaceHash: computeDeclaredSurfaceHash(
                resolvePluginArtifactDeclaredSurface(installDir),
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
      mocks.loadPluginMetadataSnapshot.mockReturnValue({
        index: { plugins: [] },
        plugins: [{ id: "codex", packageVersion: "2026.5.6", channels: ["codex"] }],
        diagnostics:
          previousState === "damaged"
            ? brokenPluginSnapshot("codex", installDir).diagnostics
            : previousState === "stale-descriptor"
              ? [{ level: "error", pluginId: "codex", message: "without channelConfigs metadata" }]
              : [],
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
        env: testEnv,
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
        expect(result.outcomes).toBeUndefined();
      } else {
        expect(result.warnings).toEqual([expect.stringContaining("--accept-capabilities")]);
        expect(result.notices).toBeUndefined();
        expect(result.outcomes).toEqual([
          expect.objectContaining({
            pluginId: "codex",
            status: "error",
            code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
          }),
        ]);
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
      expect(result.outcomes).toEqual([
        {
          pluginId: "demo",
          status: "error",
          code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
          message: "Review replacement capabilities.",
        },
      ]);
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

  it("resolves an earlier consent refusal after repair without clearing another plugin's refusal", async () => {
    const actualConsent = await vi.importActual<
      typeof import("../../../plugins/capability-consent.js")
    >("../../../plugins/capability-consent.js");
    prepareManagedPluginArtifactConsentHandler.mockImplementation(
      actualConsent.prepareManagedPluginArtifactConsentHandler,
    );
    const { preparePluginUpdateCapabilityConsent } =
      await import("../../../plugins/update-capability-consent.js");
    const { ManagedPluginLifecycleError } =
      await import("../../../plugins/management-lifecycle-error.js");
    const root = fs.realpathSync(tempDirs.make("openclaw-doctor-consent-order-"));
    const npmRoot = path.join(root, "npm");
    const pluginIds = ["demo", "other"];
    const records = Object.fromEntries(
      pluginIds.map((pluginId) => [
        pluginId,
        {
          source: "npm" as const,
          spec: "@example/" + pluginId + "@1.0.0",
          installPath: path.join(root, "installed", pluginId),
          integrity: "sha512-" + pluginId,
        },
      ]),
    );
    for (const pluginId of pluginIds) {
      const artifactDir = path.join(root, "staged", pluginId);
      fs.mkdirSync(artifactDir, { recursive: true });
      createColdPluginFixture({
        rootDir: artifactDir,
        pluginId,
        packageName: "@example/" + pluginId,
        manifest: { contracts: { tools: [pluginId + ".write"] } },
      });
    }
    mocks.resolveDefaultPluginNpmDir.mockReturnValue(npmRoot);
    mocks.resolveDefaultPluginExtensionsDir.mockReturnValue(path.join(root, "extensions"));
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [],
      diagnostics: [],
      index: { plugins: [], diagnostics: [], installRecords: records },
    });
    mocks.listChannelPluginCatalogEntries.mockReturnValue(
      pluginIds.map((id) => channelPluginEntry({ id, npmSpec: "@example/" + id + "@1.0.0" })),
    );
    const reviewed: string[] = [];
    const onCapabilityConsent: PluginCapabilityConsentHandler = async (review) => {
      const accepted = review.pluginId === "demo" && reviewed.includes("demo");
      reviewed.push(review.pluginId);
      return accepted ? { reviewToken: review.reviewToken } : undefined;
    };
    // Keep the existing updater seam, but produce refusal through its real consent owner.
    const update: typeof import("../../../plugins/update.js").updateNpmInstalledPlugins = async (
      params,
    ) => {
      const outcomes: import("../../../plugins/update.js").PluginUpdateOutcome[] = [];
      for (const pluginId of params.pluginIds ?? []) {
        const record = expectDefined(
          params.config.plugins?.installs?.[pluginId],
          "missing install record",
        );
        const consent = preparePluginUpdateCapabilityConsent({
          config: params.config,
          pluginId,
          record,
          installPath: expectDefined(record.installPath, "recorded install path"),
          expectedIntegrity: record.integrity,
          onCapabilityConsent: params.onCapabilityConsent,
        });
        try {
          await consent.onBeforePluginArtifactCommit({
            pluginId,
            stagedArtifactDir: path.join(root, "staged", pluginId),
            mode: "update",
            sourceRecord: record,
          });
          throw new Error("The first repair attempt must require fresh consent.");
        } catch (error) {
          if (!(error instanceof ManagedPluginLifecycleError) || !error.capabilityConsent) {
            throw error;
          }
          outcomes.push({
            pluginId,
            status: "error",
            code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
            message: error.message,
          });
        }
      }
      return { config: params.config, changed: false, outcomes };
    };
    mocks.updateNpmInstalledPlugins.mockImplementation(update);
    const install: typeof import("../../../plugins/install.js").installPluginFromNpmSpec = async (
      params,
    ) => {
      const pluginId = expectDefined(params.expectedPluginId, "candidate plugin id");
      if (pluginId === "other") {
        return { ok: false, error: "Fixture installer failed for other." };
      }
      const artifactDir = path.join(root, "staged", pluginId);
      const record = expectDefined(records[pluginId], "fixture install record");
      await expectDefined(
        params.onBeforePluginArtifactCommit,
        "candidate consent hook",
      )({
        pluginId,
        stagedArtifactDir: artifactDir,
        mode: "install",
        sourceRecord: record,
      });
      const targetDir = record.installPath;
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.cpSync(artifactDir, targetDir, { recursive: true });
      return {
        ...successfulInstall({
          pluginId,
          npmSpec: "@example/" + pluginId,
          version: "1.0.0",
          targetDir,
        }),
        extensions: ["index.cjs"],
      };
    };
    mocks.installPluginFromNpmSpec.mockImplementation(install);
    const repairModule = await import("./missing-configured-plugin-install.js");
    const repairSpy = vi.spyOn(repairModule, "repairMissingConfiguredPluginInstalls");
    try {
      const { runPostCorePluginConvergence } = await import("./post-core-plugin-convergence.js");
      const convergence = await runPostCorePluginConvergence({
        cfg: { plugins: { entries: { demo: { enabled: true }, other: { enabled: true } } } },
        env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
        baselineInstallRecords: records,
        onCapabilityConsent,
      });
      expect(reviewed).toEqual(["demo", "other", "demo"]);
      const invocation = expectDefined(repairSpy.mock.results[0], "real repair invocation");
      if (invocation.type !== "return") {
        throw new Error("Expected the real repair owner to return its result.");
      }
      const repair = await invocation.value;
      const demoRecord = expectDefined(repair.records.demo, "repaired demo record");
      expect(demoRecord).toMatchObject({
        spec: "@example/demo@1.0.0",
        acceptedSurface: { tools: ["demo.write"] },
      });
      expect(
        fs.existsSync(
          path.join(expectDefined(demoRecord.installPath, "repaired install path"), "package.json"),
        ),
      ).toBe(true);
      expect(repair.records.other).toBe(records.other);
      expect(repair.warnings).toContain(
        'Failed to install missing configured plugin "other" from @example/other@1.0.0: Fixture installer failed for other.',
      );
      expect(repair.repairedPluginIds).toEqual(["demo"]);
      expect(repair.failedPluginIds).toEqual(["other"]);
      expect(repair.outcomes).toEqual([
        expect.objectContaining({
          pluginId: "other",
          status: "error",
          code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
        }),
      ]);
      const outcomes = convergence.outcomes ?? [];
      expect(outcomes.some((outcome) => outcome.pluginId === "demo")).toBe(false);
      expect(
        outcomes.filter((outcome) => outcome.code === PLUGIN_CAPABILITY_CONSENT_REQUIRED),
      ).toEqual([expect.objectContaining({ pluginId: "other" })]);
    } finally {
      repairSpy.mockRestore();
    }
  });

  it.each(
    (["npm", "npm-retry", "clawhub", "npm-existing"] as const).flatMap((source) =>
      [false, true].map((accepted) => ({ source, accepted })),
    ),
  )(
    "reviews doctor $source artifact capabilities through post-core convergence, accepted=$accepted",
    async ({ source, accepted }) => {
      const actual = await vi.importActual<typeof import("../../../plugins/capability-consent.js")>(
        "../../../plugins/capability-consent.js",
      );
      prepareManagedPluginArtifactConsentHandler.mockImplementation(
        actual.prepareManagedPluginArtifactConsentHandler,
      );
      const root = tempDirs.make("openclaw-doctor-consent-");
      const npmRoot = path.join(root, "npm");
      const packageName = "@example/matrix";
      const artifactDir =
        source === "npm-existing"
          ? path.join(npmRoot, "node_modules", ...packageName.split("/"))
          : path.join(root, "artifact");
      fs.mkdirSync(artifactDir, { recursive: true });
      const fixture = createColdPluginFixture({
        rootDir: artifactDir,
        pluginId: "matrix",
        packageName,
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
              ? { clawhubSpec: `clawhub:${packageName}@1.0.0` }
              : { npmSpec: `${packageName}@1.0.0`, defaultChoice: "npm" },
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
            npmSpec: packageName,
            version: "1.0.0",
            targetDir: artifactDir,
          }),
          clawhub: {
            source: "clawhub",
            clawhubPackage: packageName,
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
          ...testEnv,
          ...(source === "npm-existing" ? { OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" } : {}),
        },
        ...(accepted ? { onCapabilityConsent: consent } : {}),
      });

      expect(committed).toBe(accepted);
      expect(fs.existsSync(fixture.runtimeMarker)).toBe(false);
      if (accepted) {
        expect(consent).toHaveBeenCalledOnce();
        expect(result.outcomes).toBeUndefined();
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
        expect(result.outcomes).toEqual([
          expect.objectContaining({
            pluginId: "matrix",
            status: "error",
            code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
          }),
        ]);
        expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
      }

      const { runPostCorePluginConvergence } = await import("./post-core-plugin-convergence.js");
      const convergence = await runPostCorePluginConvergence({
        cfg,
        env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
        baselineInstallRecords: {},
        ...(accepted ? { onCapabilityConsent: consent } : {}),
      });
      expect(convergence.smokeFailures).toEqual([]);
      if (!accepted) {
        expect(convergence.installRecords).toEqual({});
      }
      expect(convergence.outcomes ?? []).toEqual(
        accepted
          ? []
          : [
              expect.objectContaining({
                pluginId: "matrix",
                status: "error",
                code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
              }),
            ],
      );
    },
  );

  beforeAll(async () => {
    // The doctor module owns a broad install/catalog graph. Its cold import is
    // suite setup; individual cases measure detection and repair behavior.
    await import("./missing-configured-plugin-install.js");
    await import("../../../cli/update-cli/update-command-plugin-preflight.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockNpmRegistryTags({ beta: VERSION, latest: VERSION });
    // Explicit empty env fixtures fall back to the OS home, outside Vitest's env copy.
    vi.spyOn(os, "homedir").mockReturnValue(tempDirs.make("openclaw-doctor-home-"));
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

  afterEach(() => vi.restoreAllMocks());

  it("maps a missing beta-channel plugin to a structured finding and dry-run effect offline", async () => {
    mocks.resolveNpmSpecMetadata.mockImplementation(() => {
      throw new Error("Health detection must not query the npm registry.");
    });
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "matrix",
        pluginId: "matrix",
        meta: { label: "Matrix" },
        install: {
          npmSpec: "@openclaw/plugin-matrix",
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
        update: { channel: "beta" },
        channels: {
          matrix: { enabled: true, homeserver: "https://matrix.example.org" },
        },
      },
      env: testEnv,
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.resolveNpmSpecMetadata).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(issue).toEqual({
      kind: "missing-install-record",
      pluginId: "matrix",
      installSpec: "@openclaw/plugin-matrix",
    });
    expect(
      configuredPluginInstallIssueToHealthFinding(expectDefined(issue, "issue test invariant")),
    ).toMatchObject({
      checkId: "core/doctor/configured-plugin-installs",
      severity: "warning",
      target: "matrix",
      fixHint: "Run `openclaw doctor --fix` to install @openclaw/plugin-matrix.",
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
        ...testEnv,
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
      env: testEnv,
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
      env: testEnv,
      baselineRecords,
    });

    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledOnce();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
      baselineRecords,
      {
        config: cfg,
        env: testEnv,
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
      env: testEnv,
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
      env: testEnv,
    });
    expect(result.changes).toEqual([
      'Installed missing configured plugin "matrix" from @openclaw/plugin-matrix@1.2.3.',
    ]);
    expect(result.warnings).toStrictEqual([]);
  });

  it("installs latest directly when no beta release is published", async () => {
    mockNpmRegistryTags({ latest: "1.2.3" });
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

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({ cfg, env: testEnv });

    expect(mocks.installPluginFromNpmSpec).toHaveBeenCalledOnce();
    expect(mockCallArg(mocks.installPluginFromNpmSpec)).toMatchObject({
      spec: "@openclaw/plugin-matrix@1.2.3",
    });
    expect(result.records.matrix).toMatchObject({
      spec: "@openclaw/plugin-matrix",
      version: "1.2.3",
    });
    expect(result.warnings).toEqual([]);
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
    const result = await repairMissingConfiguredPluginInstalls({ cfg, env: testEnv });

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

  it("preserves ClawHub-only install metadata and review notices", async () => {
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
        },
      },
    ]);

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg,
      env: testEnv,
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
      env: testEnv,
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
      env: { ...testEnv, MATRIX_HOMESERVER: "https://matrix.example.org" },
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
      env: { ...testEnv, MATRIX_HOMESERVER: "https://matrix.example.org" },
    });
    expect(result.changes).toEqual([
      'Installed missing configured plugin "matrix" from @openclaw/plugin-matrix@1.2.3.',
    ]);
    expect(result.warnings).toStrictEqual([]);
  });

  it("uses npm first even when ClawHub metadata is also declared", async () => {
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
      env: testEnv,
    });

    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: "@openclaw/plugin-matrix@1.2.3",
      expectedPluginId: "matrix",
      trustedSourceLinkedOfficialInstall: true,
    });
    expect(result.changes).toEqual([
      'Installed missing configured plugin "matrix" from @openclaw/plugin-matrix@1.2.3.',
    ]);
    expect(result.warnings).toStrictEqual([]);
    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
  });

  it("does not invent npm identity for a ClawHub-only plugin", async () => {
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
        },
      },
    ]);

    const { repairMissingPluginInstallsForIds } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingPluginInstallsForIds({
      cfg: {},
      pluginIds: [],
      channelIds: ["matrix"],
      env: testEnv,
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
      env: testEnv,
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
      env: testEnv,
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

  it.each([
    { source: "official", installed: false, expectedVersion: "2026.9.3" },
    { source: "external", installed: false, expectedVersion: "2026.9.4" },
    { source: "official", installed: true, expectedVersion: "2026.8.1" },
  ])(
    "preserves the selected release while repairing $source plugins (installed=$installed)",
    async ({ source, installed, expectedVersion }) => {
      const pluginId = "duckduckgo";
      const packageName = "@openclaw/duckduckgo-plugin";
      const coreVersion = "2026.9.3";
      const latestVersion = "2026.9.4";
      const config: OpenClawConfig = {
        update: { channel: "stable" },
        plugins: { entries: { [pluginId]: { enabled: true } } },
      };
      const env = { ...testEnv, OPENCLAW_COMPATIBILITY_HOST_VERSION: coreVersion };
      const installPath = tempDirs.make("openclaw-doctor-pinned-duckduckgo-");
      const records = installed
        ? installedRecords(pluginId, {
            spec: `${packageName}@2026.8.1`,
            resolvedVersion: "2026.8.1",
            installPath,
          })
        : {};
      if (installed) {
        createColdPluginFixture({
          rootDir: installPath,
          pluginId,
          packageName,
          packageVersion: "2026.8.1",
        });
        mocks.loadPluginMetadataSnapshot.mockReturnValue({
          plugins: [
            {
              id: pluginId,
              origin: "global",
              packageName,
              rootDir: installPath,
              source: path.join(installPath, "index.cjs"),
              channels: [],
            },
          ],
          diagnostics: [],
        });
      }
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
        officialPluginEntry({
          id: pluginId,
          npmSpec: packageName,
          overrides: { name: packageName, source },
        }),
      ]);
      const versionForSpec = (spec: string) =>
        spec === packageName ? latestVersion : spec.slice(packageName.length + 1);
      mocks.resolveNpmSpecMetadata.mockImplementation(async ({ spec }: { spec: string }) => ({
        ok: true,
        metadata: {
          name: packageName,
          version: versionForSpec(spec),
          resolvedSpec: `${packageName}@${versionForSpec(spec)}`,
        },
      }));
      mocks.installPluginFromNpmSpec.mockImplementation(async ({ spec }: { spec: string }) =>
        successfulInstall({ pluginId, npmSpec: packageName, version: versionForSpec(spec) }),
      );
      const { preflightConfiguredNpmPluginTargets } =
        await import("../../../cli/update-cli/update-command-plugin-preflight.js");
      await preflightConfiguredNpmPluginTargets({
        config,
        env,
        targetVersion: coreVersion,
        channel: "stable",
        timeoutMs: 1000,
      });
      const expectedSpec =
        source === "external" ? packageName : `${packageName}@${expectedVersion}`;
      expect(mocks.resolveNpmSpecMetadata).toHaveBeenCalledWith({
        spec: expectedSpec,
        timeoutMs: 1000,
      });
      expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
      expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();

      const result = await repairConfiguredPlugins(config, env);
      expect(result.warnings).toEqual([]);
      if (installed) {
        expect(result.records).toEqual(records);
        expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
        expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
      } else {
        expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
          spec: expectedSpec,
          expectedPluginId: pluginId,
        });
        expectRecordFields(result.records[pluginId], {
          spec: packageName,
          resolvedVersion: expectedVersion,
          resolvedSpec: `${packageName}@${expectedVersion}`,
        });
        expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
          result.records,
          { config, env },
        );
      }
    },
  );

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
      env: testEnv,
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
      env: testEnv,
    });

    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], warnings: [], records: {} });
  });

  it("does not download configured channel plugins that are still bundled", async () => {
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "bundleddemo",
        pluginId: "bundleddemo",
        origin: "bundled",
        meta: { label: "Matrix" },
        install: {
          npmSpec: "@openclaw/bundleddemo",
        },
      },
    ]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "bundleddemo",
          origin: "bundled",
          packageName: "@openclaw/bundleddemo",
          channels: ["bundleddemo"],
        },
      ],
      diagnostics: [],
    });
    mockCurrentBundledPlugin("bundleddemo", "@openclaw/bundleddemo");

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: {
            bundleddemo: { enabled: true },
          },
        },
        channels: {
          bundleddemo: { enabled: true, homeserver: "https://bundleddemo.example.org" },
        },
      },
      env: testEnv,
    });

    expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    expect(result).toEqual({ changes: [], warnings: [], records: {} });
  });

  it("removes stale managed install records when the configured plugin is bundled", async () => {
    const records = {
      bundleddemo: {
        source: "npm",
        spec: "@openclaw/bundleddemo",
        installPath: "/missing/bundleddemo",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "bundleddemo",
        pluginId: "bundleddemo",
        origin: "bundled",
        meta: { label: "Matrix" },
        install: {
          npmSpec: "@openclaw/bundleddemo",
        },
      },
    ]);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "bundleddemo",
          origin: "bundled",
          packageName: "@openclaw/bundleddemo",
          channels: ["bundleddemo"],
        },
      ],
      diagnostics: [
        {
          pluginId: "bundleddemo",
          message: "manifest without channelConfigs metadata",
        },
      ],
    });
    mockCurrentBundledPlugin("bundleddemo", "@openclaw/bundleddemo");

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {
        plugins: {
          entries: {
            bundleddemo: { enabled: true },
          },
        },
        channels: {
          bundleddemo: { enabled: true, homeserver: "https://bundleddemo.example.org" },
        },
      },
      env: testEnv,
    });

    expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
      {},
      {
        config: expect.any(Object),
        env: testEnv,
      },
    );
    expect(result).toEqual({
      changes: ['Removed stale managed install record for bundled plugin "bundleddemo".'],
      warnings: [],
      pluginInventoryChanged: true,
      records: {},
    });
  });

  it.each(["healthy", "absent", "empty"])(
    "preserves and repairs %s official external installs in source checkouts",
    async (payload) => {
      const root = tempDirs.make("openclaw-external-companion-");
      const installPath = path.join(root, "payload");
      const repairedPath = path.join(root, "repaired");
      fs.mkdirSync(repairedPath);
      fs.writeFileSync(path.join(repairedPath, "package.json"), '{"name":"@openclaw/google-meet"}');
      if (payload !== "absent") {
        fs.mkdirSync(installPath);
      }
      if (payload === "healthy") {
        fs.copyFileSync(
          path.join(repairedPath, "package.json"),
          path.join(installPath, "package.json"),
        );
      }
      const records = {
        "google-meet": {
          source: "npm",
          spec: "@openclaw/google-meet",
          resolvedName: "@openclaw/google-meet",
          installPath,
        },
      };
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      const repairedRecords = {
        "google-meet": { ...records["google-meet"], installPath: repairedPath },
      };
      mocks.updateNpmInstalledPlugins.mockResolvedValue(
        successfulUpdate("google-meet", repairedRecords),
      );
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
        env: testEnv,
      });

      expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
      expect(mocks.updateNpmInstalledPlugins).toHaveBeenCalledTimes(payload === "healthy" ? 0 : 1);
      expect(result.records).toEqual(payload === "healthy" ? records : repairedRecords);
      expect(result.changes).toEqual(
        payload === "healthy" ? [] : ['Repaired missing configured plugin "google-meet".'],
      );
      expect(result.warnings).toEqual([]);
      expect(result.outcomes).toBeUndefined();
    },
  );

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
      bundleddemo: {
        source: "npm",
        spec: "@openclaw/bundleddemo",
        resolvedName: "@openclaw/bundleddemo",
        installPath: "/missing/bundleddemo",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    mockCurrentBundledPlugin("bundleddemo", "@openclaw/bundleddemo");

    const { repairMissingConfiguredPluginInstalls } =
      await import("./missing-configured-plugin-install.js");
    const result = await repairMissingConfiguredPluginInstalls({
      cfg: {},
      env: testEnv,
    });

    expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
    expect(mocks.writePersistedInstalledPluginIndexInstallRecords).toHaveBeenCalledWith(
      {},
      {
        config: {},
        env: testEnv,
      },
    );
    expect(result).toEqual({
      changes: ['Removed stale managed install record for bundled plugin "bundleddemo".'],
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
        spec: "@openclaw/bundleddemo-fork",
        resolvedName: "@openclaw/bundleddemo-fork",
        resolvedSpec: "@openclaw/bundleddemo-fork@1.2.3",
        installPath: "/missing/bundleddemo-fork",
      },
    ],
    [
      "clawhub",
      {
        source: "clawhub",
        spec: "clawhub:@openclaw/bundleddemo-fork@stable",
        clawhubPackage: "@openclaw/bundleddemo-fork",
        installPath: "/missing/bundleddemo-fork",
      },
    ],
  ])(
    "keeps %s install records whose package names only share a bundled prefix",
    async (_, record) => {
      const records = { bundleddemo: record };
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mocks.listChannelPluginCatalogEntries.mockReturnValue([
        {
          id: "bundleddemo",
          pluginId: "bundleddemo",
          origin: "bundled",
          meta: { label: "Matrix" },
          install: {
            npmSpec: "@openclaw/bundleddemo",
          },
        },
      ]);
      mocks.loadPluginMetadataSnapshot.mockReturnValue({
        plugins: [
          {
            id: "bundleddemo",
            origin: "bundled",
            packageName: "@openclaw/bundleddemo",
            channels: ["bundleddemo"],
          },
        ],
        diagnostics: [
          {
            pluginId: "bundleddemo",
            message: "manifest without channelConfigs metadata",
          },
        ],
      });
      mockCurrentBundledPlugin("bundleddemo", "@openclaw/bundleddemo");

      const { repairMissingConfiguredPluginInstalls } =
        await import("./missing-configured-plugin-install.js");
      const result = await repairMissingConfiguredPluginInstalls({
        cfg: {
          plugins: {
            entries: {
              bundleddemo: { enabled: true },
            },
          },
          channels: {
            bundleddemo: { enabled: true, homeserver: "https://bundleddemo.example.org" },
          },
        },
        env: testEnv,
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
        ...testEnv,
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
      env: { ...testEnv, OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" },
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
      env: { ...testEnv, OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" },
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

  it.each([
    {
      layout: "legacy",
      channel: "stable",
      coreVersion: "2026.8.2",
      npmSpec: "@openclaw/codex",
      version: "2026.8.2",
    },
    {
      layout: "project",
      channel: "stable",
      coreVersion: "2026.8.2",
      npmSpec: "@openclaw/codex",
      version: "2026.8.2",
    },
    {
      layout: "project",
      channel: "beta",
      coreVersion: "2026.8.2-beta.2",
      npmSpec: "@openclaw/codex",
      version: "2026.8.2-beta.2",
    },
    {
      layout: "legacy",
      channel: "stable",
      coreVersion: "2026.8.2",
      npmSpec: "@openclaw/codex@2026.7.9",
      version: "2026.7.9",
    },
  ] as const)(
    "converges orphaned $layout npm payloads to the verified $channel target $version",
    async ({ layout, channel, coreVersion, npmSpec, version }) => {
      mockNpmRegistryTags({ beta: version, latest: "2026.7.9" });
      const actual = await vi.importActual<typeof import("../../../plugins/capability-consent.js")>(
        "../../../plugins/capability-consent.js",
      );
      prepareManagedPluginArtifactConsentHandler.mockImplementation(
        actual.prepareManagedPluginArtifactConsentHandler,
      );
      useManifestCatalogResolvers();
      const root = tempDirs.make("openclaw-orphaned-plugin-repair-");
      const npmRoot = path.join(root, "npm");
      const packageName = "@openclaw/codex";
      const packageDir =
        layout === "legacy"
          ? path.join(npmRoot, "node_modules", ...packageName.split("/"))
          : mocks.resolvePluginNpmPackageDir({ npmDir: npmRoot, packageName });
      const stageDir = path.join(root, "verified-artifact");
      const fixtures = (
        [
          [packageDir, "2026.7.1"],
          [stageDir, version],
        ] as const
      ).map(([rootDir, packageVersion]) => {
        fs.mkdirSync(rootDir, { recursive: true });
        return createColdPluginFixture({
          rootDir,
          pluginId: "codex",
          packageName,
          packageVersion,
          manifest: { contracts: { tools: ["fixture.read"] } },
        });
      });
      mocks.resolveDefaultPluginNpmDir.mockReturnValue(npmRoot);
      mocks.resolveDefaultPluginExtensionsDir.mockReturnValue(path.join(root, "extensions"));
      mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
        officialPluginEntry({ id: "codex", npmSpec }),
      ]);
      const integrity = "sha512-verified-codex";
      mocks.installPluginFromNpmSpec.mockImplementation(
        async (params: {
          spec: string;
          onBeforePluginArtifactCommit: PluginInstallArtifactConsentHandler;
        }) => {
          await params.onBeforePluginArtifactCommit({
            pluginId: "codex",
            stagedArtifactDir: stageDir,
            mode: "update",
            sourceRecord: {
              source: "npm",
              spec: params.spec,
              resolvedName: packageName,
              resolvedVersion: version,
              resolvedSpec: `${packageName}@${version}`,
              integrity,
            },
          });
          return successfulInstall({
            pluginId: "codex",
            npmSpec: packageName,
            targetDir: stageDir,
            version,
            resolution: { integrity },
          });
        },
      );
      const consent = vi.fn<PluginCapabilityConsentHandler>(async (review) => ({
        reviewToken: review.reviewToken,
      }));
      const { repairMissingConfiguredPluginInstalls } =
        await import("./missing-configured-plugin-install.js");
      const result = await repairMissingConfiguredPluginInstalls({
        cfg: { update: { channel }, plugins: { entries: { codex: { enabled: true } } } },
        env: {
          ...testEnv,
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
          OPENCLAW_COMPATIBILITY_HOST_VERSION: coreVersion,
        },
        onCapabilityConsent: consent,
      });

      expect(result.records.codex).toMatchObject({
        source: "npm",
        spec: npmSpec,
        installPath: stageDir,
        version,
        resolvedVersion: version,
        resolvedSpec: `${packageName}@${version}`,
        integrity,
      });
      expect(result.records.codex?.sourcePath).toBeUndefined();
      expect(result.records.codex?.acceptedSurface).toBeUndefined();
      expect(
        isTrustedOfficialPluginInstallRecord({
          pluginId: "codex",
          packageName,
          record: expectDefined(result.records.codex, "verified install record"),
        }),
      ).toBe(true);
      expect(mocks.installPluginFromNpmSpec).toHaveBeenCalledOnce();
      expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
        spec: `${packageName}@${version}`,
        mode: "update",
        trustedSourceLinkedOfficialInstall: true,
      });
      expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
      expect(consent).not.toHaveBeenCalled();
      expect(result.warnings).toEqual([]);
      expect(fixtures.every((fixture) => !fs.existsSync(fixture.runtimeMarker))).toBe(true);
    },
  );

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
        ...testEnv,
        OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.5.19",
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
    });

    expectRecordFields(mockCallArg(mocks.installPluginFromClawHub), {
      spec: expectedClawHubInstallSpec("clawhub:@openclaw/whatsapp"),
      env: {
        ...testEnv,
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
        ...testEnv,
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
        ...testEnv,
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
        ...testEnv,
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
      env: { ...testEnv, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
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
      env: { ...testEnv, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
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
      env: { ...testEnv, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
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
        ...brokenPluginSnapshot("brave", records.brave.installPath).diagnostics,
        ...brokenPluginSnapshot("discord", records.discord.installPath).diagnostics,
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
      env: testEnv,
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
      env: testEnv,
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
      env: testEnv,
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

    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "codex",
        npmSpec: "@openclaw/codex",
        version: "2026.7.2",
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
      env: testEnv,
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
      installPath: "/tmp/openclaw-plugins/codex",
      version: "2026.7.2",
      resolvedName: "@openclaw/codex",
      resolvedSpec: "@openclaw/codex@2026.7.2",
      integrity: "sha512-codex-supervisor-upgrade",
    });
    expect(mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords, 0, 1)).toEqual({
      config: cfg,
      env: testEnv,
    });
    expect(result.changes).toEqual([
      `Installed missing configured plugin "codex" from ${expectedCodexInstallSpec()}.`,
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.repairedPluginIds).toEqual(["codex"]);
    expect(result.records).toEqual(records);
  });

  it("installs a missing default Codex runtime plugin from the official external catalog", async () => {
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "codex",
        npmSpec: "@openclaw/codex",
        version: "2026.5.2",
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
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.4",
            agentRuntime: { id: "codex" },
          },
        },
      },
      pluginIds: ["codex"],
      env: testEnv,
    });

    expect(mocks.resolveProviderInstallCatalogEntries).toHaveBeenCalled();
    expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
      spec: expectedCodexInstallSpec(),
      expectedPluginId: "codex",
      trustedSourceLinkedOfficialInstall: true,
    });
    const records = mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords);
    expectRecordFields((records as Record<string, unknown>).codex, {
      source: "npm",
      spec: "@openclaw/codex",
      installPath: "/tmp/openclaw-plugins/codex",
      version: "2026.5.2",
    });
    expect(mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords, 0, 1)).toEqual({
      config: expect.any(Object),
      env: testEnv,
    });
    expect(result.changes).toEqual([
      `Installed missing configured plugin "codex" from ${expectedCodexInstallSpec()}.`,
    ]);
    expect(result.warnings).toStrictEqual([]);
  });

  it.each([
    {
      availability: "missing version",
      channel: "stable",
      error: "Package not found on npm: @openclaw/codex@2026.9.3.",
    },
    { availability: "registry outage", channel: "stable", error: "registry connection timed out" },
    { availability: "published version", channel: "stable" },
    { availability: "already-current floating package", channel: "stable" },
    { availability: "beta-only package", channel: "beta" },
    { availability: "unknown core version", channel: "stable" },
  ] as const)(
    "preflights Codex with $availability before any plugin mutation",
    async ({ availability, channel, ...outcome }) => {
      const alreadyCurrent = availability === "already-current floating package";
      const installedVersion = alreadyCurrent ? "2026.9.3" : "2026.9.1";
      if (alreadyCurrent) {
        useManifestCatalogResolvers();
      }
      const installDir = tempDirs.make("openclaw-plugin-availability-");
      createColdPluginFixture({
        rootDir: installDir,
        pluginId: "codex",
        packageName: "@openclaw/codex",
        packageVersion: installedVersion,
      });
      const packageFile = path.join(installDir, "package.json");
      const originalPackage = fs.readFileSync(packageFile, "utf8");
      const records = installedRecords("codex", {
        spec: alreadyCurrent ? "@openclaw/codex" : "@openclaw/codex@2026.9.1",
        resolvedVersion: installedVersion,
        installPath: installDir,
      });
      const config: OpenClawConfig = { plugins: { entries: { codex: { enabled: true } } } };
      const originalConfig = structuredClone(config);
      const originalRecords = structuredClone(records);
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mocks.loadPluginMetadataSnapshot.mockReturnValue({
        plugins: [{ id: "codex", packageVersion: installedVersion, channels: [] }],
        diagnostics: [],
      });
      mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
        officialPluginEntry({ id: "codex", npmSpec: "@openclaw/codex" }),
      ]);
      mocks.resolveNpmSpecMetadata.mockImplementation(async ({ spec }: { spec: string }) => {
        if (spec === "@openclaw/codex@2026.9.3" && "error" in outcome) {
          return { ok: false, error: outcome.error };
        }
        if (availability === "beta-only package" && spec === "@openclaw/codex@latest") {
          return { ok: false, error: "No latest release for @openclaw/codex." };
        }
        const version =
          spec === "@openclaw/codex"
            ? "2026.9.2"
            : spec.endsWith("@beta")
              ? "2026.9.3-beta.1"
              : spec.split("@").at(-1);
        return {
          ok: true,
          metadata: {
            name: "@openclaw/codex",
            version,
            resolvedSpec: `@openclaw/codex@${version}`,
          },
        };
      });
      const { preflightConfiguredNpmPluginTargets } =
        await import("../../../cli/update-cli/update-command-plugin-preflight.js");
      const result = preflightConfiguredNpmPluginTargets({
        config,
        env: testEnv,
        targetVersion: availability === "unknown core version" ? null : "2026.9.3",
        channel,
        timeoutMs: 1000,
      });
      if (availability === "unknown core version") {
        await expect(result).rejects.toMatchObject({
          reason: "plugin-target-unavailable",
          message: expect.stringContaining("target core version is unknown"),
        });
      } else if ("error" in outcome) {
        await expect(result).rejects.toMatchObject({
          reason: "plugin-target-unavailable",
          message: expect.stringContaining(
            `Plugin "codex" requires @openclaw/codex@2026.9.3 for core 2026.9.3: ${outcome.error}`,
          ),
        });
      } else {
        await expect(result).resolves.toBeUndefined();
      }
      expect(
        mocks.resolveNpmSpecMetadata.mock.calls
          .map(([params]) => params.spec)
          .toSorted((left, right) => left.localeCompare(right)),
      ).toEqual(
        availability === "unknown core version"
          ? []
          : channel === "beta"
            ? ["@openclaw/codex@beta", "@openclaw/codex@latest"]
            : ["@openclaw/codex@2026.9.3"],
      );
      expect(config).toEqual(originalConfig);
      expect(records).toEqual(originalRecords);
      expect(fs.readFileSync(packageFile, "utf8")).toBe(originalPackage);
      expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
      expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
      expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
      expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    },
  );

  it.each(["disabled", "path", "bundled", "local npm archive"] as const)(
    "does not query npm while preflighting a %s configured plugin",
    async (kind) => {
      const records = installedRecords("fixture", {
        source: kind === "path" ? "path" : "npm",
        spec: kind === "local npm archive" ? "file:/tmp/fixture.tgz" : "@example/fixture@1.0.0",
        installPath: process.cwd(),
      });
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mocks.loadPluginMetadataSnapshot.mockReturnValue({
        plugins: [{ id: "fixture", channels: [] }],
        diagnostics: [],
      });
      if (kind === "bundled") {
        mockCurrentBundledPlugin("fixture", "@example/fixture");
      }
      const { preflightConfiguredNpmPluginTargets } =
        await import("../../../cli/update-cli/update-command-plugin-preflight.js");
      await expect(
        preflightConfiguredNpmPluginTargets({
          config: { plugins: { entries: { fixture: { enabled: kind !== "disabled" } } } },
          env: testEnv,
          targetVersion: "2026.9.3",
          channel: "stable",
          timeoutMs: 1000,
        }),
      ).resolves.toBeUndefined();
      expect(mocks.resolveNpmSpecMetadata).not.toHaveBeenCalled();
      expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
      expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      intent: "floating",
      installedVersion: "2026.5.6",
      coreVersion: VERSION,
      priorSpec: "@openclaw/codex",
      expectedSpec: "@openclaw/codex",
      expectedIntegrity: undefined,
    },
    {
      intent: "exact",
      installedVersion: "2026.5.6",
      coreVersion: VERSION,
      priorSpec: "@openclaw/codex@2026.5.6",
      expectedSpec: `@openclaw/codex@${VERSION}`,
      expectedIntegrity: "sha512-new-codex",
    },
    {
      intent: "post-core floating",
      installedVersion: VERSION,
      coreVersion: `${Number(VERSION.split(".")[0]) + 1}.1.1`,
      priorSpec: "@openclaw/codex",
      expectedSpec: "@openclaw/codex",
      expectedIntegrity: undefined,
    },
  ])(
    "preserves $intent npm selector intent when refreshing a stale Codex runtime plugin",
    async ({ priorSpec, expectedSpec, expectedIntegrity, installedVersion, coreVersion }) => {
      const installDir = tempDirs.make("openclaw-plugin-stub-repair-");
      fs.writeFileSync(
        path.join(installDir, "package.json"),
        JSON.stringify({ name: "@openclaw/codex", version: installedVersion }),
      );
      const records = {
        codex: {
          source: "npm",
          spec: priorSpec,
          resolvedName: "@openclaw/codex",
          resolvedSpec: `@openclaw/codex@${installedVersion}`,
          resolvedVersion: installedVersion,
          version: installedVersion,
          integrity: "sha512-old-codex",
          installPath: installDir,
        },
      };
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mocks.loadPluginMetadataSnapshot.mockReturnValue({
        plugins: [
          {
            id: "codex",
            packageVersion: installedVersion,
            providers: ["codex"],
          },
        ],
        diagnostics: [],
        byPluginId: new Map([
          [
            "codex",
            {
              id: "codex",
              packageVersion: installedVersion,
              providers: ["codex"],
            },
          ],
        ]),
      });
      mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
        successfulInstall({
          pluginId: "codex",
          npmSpec: "@openclaw/codex",
          version: coreVersion,
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
            expectedIntegrity,
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
        env: { ...testEnv, OPENCLAW_COMPATIBILITY_HOST_VERSION: coreVersion },
      });

      expect(mocks.resolveDirectBundledProviderPolicySurface).toHaveBeenCalledWith("openai");
      expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
      expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
        spec: `@openclaw/codex@${coreVersion}`,
        expectedPluginId: "codex",
        trustedSourceLinkedOfficialInstall: true,
        mode: "update",
        expectedIntegrity,
      });
      expect(prepareManagedPluginArtifactConsentHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "npm",
          spec: `@openclaw/codex@${coreVersion}`,
          expectedIntegrity,
        }),
      );
      expect(mocks.installPluginFromClawHub).not.toHaveBeenCalled();
      expect(result.changes).toEqual([
        `Refreshed stale configured plugin "codex" from @openclaw/codex@${coreVersion}.`,
      ]);
      expectRecordFields(result.records.codex, {
        source: "npm",
        spec: expectedSpec,
        installPath: "/tmp/openclaw-plugins/codex",
        version: coreVersion,
        resolvedName: "@openclaw/codex",
        resolvedVersion: coreVersion,
        resolvedSpec: `@openclaw/codex@${coreVersion}`,
        integrity: "sha512-new-codex",
      });
    },
  );

  it.each(
    // prettier-ignore
    [
    ["stale beta follows newer latest", "2026.9.1-beta.1", "2026.9.1-beta.1", "2026.9.2", "2026.9.2", true, undefined, undefined],
    ["same-base beta follows newer latest", "2026.9.2-beta.1", "2026.9.2-beta.1", "2026.9.2", "2026.9.2", true, undefined, undefined],
    ["newer beta stays ahead of latest", "2026.9.1-beta.1", "2026.9.3-beta.1", "2026.9.2", "2026.9.3-beta.1", true, undefined, undefined],
    ["already-current beta older than the host is a no-op", "2026.9.1-beta.1", "2026.9.1-beta.1", "2026.8.31", "2026.9.1-beta.1", false, undefined, undefined],
    ["already-current same-base beta is a no-op", "2026.9.2-beta.4", "2026.9.2-beta.4", "2026.9.1", "2026.9.2-beta.4", false, undefined, undefined],
    ["registry tags behind the installed beta are a no-op", "2026.9.1-beta.2", "2026.9.1-beta.1", "2026.8.31", "2026.9.1-beta.1", false, undefined, undefined],
    ["registry outage retains a healthy installed beta", "2026.9.1-beta.1", "2026.9.1-beta.1", "2026.9.2", "2026.9.2", false, true, undefined],
    ["registry outage cannot hide broken package diagnostics", "2026.9.1-beta.1", "2026.9.1-beta.1", "2026.9.2", "2026.9.2", false, true, true],
  ] as const,
  )(
    "converges managed Codex startup: %s",
    async (
      _name,
      installedVersion,
      betaVersion,
      latestVersion,
      selectedVersion,
      refresh,
      registryUnavailable: boolean | undefined = false,
      brokenPayload: boolean | undefined = false,
    ) => {
      mockNpmRegistryTags({ beta: betaVersion, latest: latestVersion });
      if (registryUnavailable) {
        mocks.resolveNpmSpecMetadata.mockResolvedValue({
          ok: false,
          category: "metadata-env",
          error: "registry unavailable",
        });
      }
      const installDir = tempDirs.make("openclaw-beta-codex-convergence-");
      const packageFile = path.join(installDir, "package.json");
      const writePackageVersion = (version: string) =>
        fs.writeFileSync(packageFile, JSON.stringify({ name: "@openclaw/codex", version }));
      writePackageVersion(installedVersion);
      const records = {
        codex: {
          source: "npm",
          spec: "@openclaw/codex",
          resolvedName: "@openclaw/codex",
          resolvedSpec: `@openclaw/codex@${installedVersion}`,
          resolvedVersion: installedVersion,
          version: installedVersion,
          integrity: "sha512-old-codex",
          installPath: installDir,
        },
      };
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mocks.loadPluginMetadataSnapshot.mockImplementation(() => {
        const { version } = JSON.parse(fs.readFileSync(packageFile, "utf8")) as { version: string };
        const plugin = { id: "codex", packageVersion: version, providers: ["codex"] };
        return {
          plugins: [plugin],
          diagnostics: brokenPayload ? brokenPluginSnapshot("codex", installDir).diagnostics : [],
          byPluginId: new Map([["codex", plugin]]),
        };
      });
      mocks.installPluginFromNpmSpec.mockImplementation(async () => {
        writePackageVersion(selectedVersion);
        return successfulInstall({
          pluginId: "codex",
          npmSpec: "@openclaw/codex",
          targetDir: installDir,
          version: selectedVersion,
        });
      });
      mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue([
        officialPluginEntry({ id: "codex", npmSpec: "@openclaw/codex" }),
      ]);
      const params = {
        cfg: {
          update: { channel: "beta" as const },
          agents: { defaults: { model: "openai/gpt-5.5" } },
        },
        env: { ...testEnv, OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.9.2" },
      };
      const { repairMissingConfiguredPluginInstalls } =
        await import("./missing-configured-plugin-install.js");
      const firstPass = await repairMissingConfiguredPluginInstalls(params);

      if (refresh) {
        expect(mocks.installPluginFromNpmSpec).toHaveBeenCalledOnce();
        expectRecordFields(mockCallArg(mocks.installPluginFromNpmSpec), {
          spec: `@openclaw/codex@${selectedVersion}`,
          expectedPluginId: "codex",
          trustedSourceLinkedOfficialInstall: true,
          mode: "update",
        });
        expect(firstPass.changes).toEqual([
          `Refreshed stale configured plugin "codex" from @openclaw/codex@${selectedVersion}.`,
        ]);
        expect(firstPass.pluginInventoryChanged).toBe(true);
        expect(firstPass.notices).toContain(
          `Plugin "codex" refresh: newer-available (${installedVersion} -> ${selectedVersion}).`,
        );
        if (selectedVersion === latestVersion) {
          expect(firstPass.notices).toContain(
            `Plugin "codex" refresh: tag-behind-latest; beta follows latest ${selectedVersion}.`,
          );
        }
        expectRecordFields(firstPass.records.codex, {
          source: "npm",
          spec: "@openclaw/codex",
          installPath: installDir,
          version: selectedVersion,
          resolvedVersion: selectedVersion,
          resolvedSpec: `@openclaw/codex@${selectedVersion}`,
        });
      } else {
        expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
        expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
        expect(firstPass.records).toBe(records);
        expect(firstPass.changes).toEqual([]);
        expect(firstPass.pluginInventoryChanged).toBeUndefined();
        expect(firstPass.repairedPluginIds).toBeUndefined();
        if (registryUnavailable) {
          expect(firstPass.notices ?? []).toEqual(
            brokenPayload
              ? []
              : [expect.stringContaining('Kept installed plugin "codex"; replacement deferred.')],
          );
        } else {
          expect(firstPass.notices).toContain(
            `Plugin "codex" refresh: already-current (${installedVersion}).`,
          );
        }
      }
      expect(firstPass.warnings).toEqual(
        brokenPayload ? [expect.stringContaining("registry unavailable")] : [],
      );
      mocks.installPluginFromNpmSpec.mockClear();
      mocks.writePersistedInstalledPluginIndexInstallRecords.mockClear();
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(firstPass.records);

      const secondPass = await repairMissingConfiguredPluginInstalls(params);

      expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
      expect(mocks.writePersistedInstalledPluginIndexInstallRecords).not.toHaveBeenCalled();
      expect(secondPass.changes).toEqual([]);
      expect(secondPass.warnings).toEqual(firstPass.warnings);
      if (registryUnavailable) {
        expect(secondPass.notices).toEqual(firstPass.notices);
      }
      expect(secondPass.records).toBe(firstPass.records);
      expect(secondPass.pluginInventoryChanged).toBeUndefined();
      expect(secondPass.repairedPluginIds).toBeUndefined();
    },
  );

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
      env: testEnv,
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
    mocks.installPluginFromNpmSpec.mockResolvedValueOnce(
      successfulInstall({
        pluginId: "codex",
        npmSpec: "@openclaw/codex",
        version: "2026.5.2",
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
      env: { ...testEnv, ...env },
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
      installPath: "/tmp/openclaw-plugins/codex",
      version: "2026.5.2",
    });
    expect(mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords, 0, 1)).toEqual({
      config: cfg,
      env: { ...testEnv, ...env },
    });
    expect(result.changes).toEqual([
      `Installed missing configured plugin "codex" from ${expectedCodexInstallSpec()}.`,
    ]);
    expect(result.warnings).toEqual([]);
    expect(Object.keys(result.records)).toEqual(["codex"]);
    expectRecordFields(result.records.codex, {
      source: "npm",
      spec: "@openclaw/codex",
      installPath: "/tmp/openclaw-plugins/codex",
      version: "2026.5.2",
      resolvedName: "@openclaw/codex",
      resolvedSpec: "@openclaw/codex@2026.5.2",
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
      env: { ...testEnv, ...env },
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
      env: testEnv,
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
      env: testEnv,
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
      env: testEnv,
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
      env: testEnv,
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
      env: testEnv,
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
      env: testEnv,
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
      env: testEnv,
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
          source: records.demo.installPath,
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
      env: testEnv,
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

  it.each([
    { recordedSource: "npm", recordedConsentRequired: false, siblingConsentRequired: false },
    { recordedSource: "npm", recordedConsentRequired: true, siblingConsentRequired: false },
    { recordedSource: "npm", recordedConsentRequired: true, siblingConsentRequired: true },
    { recordedSource: "git", recordedConsentRequired: false, siblingConsentRequired: false },
  ])(
    "reinstalls a known configured plugin from the catalog when its recorded install path is missing (source=$recordedSource, recorded consent=$recordedConsentRequired, sibling consent=$siblingConsentRequired)",
    async ({ recordedSource, recordedConsentRequired, siblingConsentRequired }) => {
      const actual = await vi.importActual<typeof import("../../../plugins/capability-consent.js")>(
        "../../../plugins/capability-consent.js",
      );
      prepareManagedPluginArtifactConsentHandler.mockImplementation(
        actual.prepareManagedPluginArtifactConsentHandler,
      );
      const root = tempDirs.make("openclaw-doctor-catalog-recovery-");
      const artifactDir = path.join(root, "artifact");
      fs.mkdirSync(artifactDir);
      createColdPluginFixture({
        rootDir: artifactDir,
        pluginId: "discord",
        packageName: "@openclaw/discord",
        packageVersion: "1.2.3",
        manifest: { contracts: { tools: ["fixture.write"] } },
      });
      const records = installedRecords("discord", {
        source: recordedSource,
        spec:
          recordedSource === "git"
            ? "git+https://example.test/plugins/discord.git#v1.0.0"
            : "@openclaw/discord",
        installPath: path.join(root, "missing-discord"),
      });
      if (siblingConsentRequired) {
        records.sibling = {
          source: "npm",
          spec: "@example/sibling",
          installPath: path.join(root, "missing-sibling"),
        };
      }
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      mocks.loadPluginMetadataSnapshot.mockReturnValue({
        index: { plugins: [] },
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
      mocks.installPluginFromNpmSpec.mockImplementationOnce(
        async (params: { onBeforePluginArtifactCommit: PluginInstallArtifactConsentHandler }) => {
          await params.onBeforePluginArtifactCommit({
            pluginId: "discord",
            stagedArtifactDir: artifactDir,
            mode: "install",
          });
          return successfulInstall({
            pluginId: "discord",
            npmSpec: "@openclaw/discord",
            version: "1.2.3",
            targetDir: artifactDir,
          });
        },
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
            status: recordedSource === "git" || recordedConsentRequired ? "error" : "skipped",
            ...(recordedConsentRequired ? { code: PLUGIN_CAPABILITY_CONSENT_REQUIRED } : {}),
            message: recordedConsentRequired
              ? "Review recorded capabilities."
              : recordedSource === "git"
                ? "Git repository unavailable."
                : "No update applied.",
          },
          ...(siblingConsentRequired
            ? [
                {
                  pluginId: "sibling",
                  status: "error",
                  code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
                  message: "Review sibling capabilities.",
                },
              ]
            : []),
        ],
      });

      const onCapabilityConsent = vi.fn<PluginCapabilityConsentHandler>(async (review) => ({
        reviewToken: review.reviewToken,
      }));
      const { repairMissingConfiguredPluginInstalls } =
        await import("./missing-configured-plugin-install.js");
      const result = await repairMissingConfiguredPluginInstalls({
        cfg: {
          plugins: {
            entries: {
              discord: { enabled: true },
              ...(siblingConsentRequired ? { sibling: { enabled: true } } : {}),
            },
          },
          channels: {
            discord: { enabled: true },
          },
        },
        env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
        onCapabilityConsent,
      });

      const updateArg = expectRecordFields(mockCallArg(mocks.updateNpmInstalledPlugins), {
        pluginIds: siblingConsentRequired ? ["discord", "sibling"] : ["discord"],
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
        source: "npm",
        spec: "@openclaw/discord",
        installPath: artifactDir,
      });
      expect(mockCallArg(mocks.writePersistedInstalledPluginIndexInstallRecords, 0, 1)).toEqual({
        config: expect.any(Object),
        env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
      });
      expect(result.changes).toEqual([
        `Installed missing configured plugin "discord" from ${expectedNpmInstallSpec("@openclaw/discord")}.`,
      ]);
      expect(onCapabilityConsent).toHaveBeenCalledOnce();
      expect(result.records.discord?.acceptedSurface?.tools).toEqual(["fixture.write"]);
      expect(result.repairedPluginIds).toEqual(["discord"]);
      expect(result.outcomes).toEqual(
        siblingConsentRequired
          ? [
              expect.objectContaining({
                pluginId: "sibling",
                status: "error",
                code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
              }),
            ]
          : undefined,
      );
    },
  );

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
      env: testEnv,
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
      env: testEnv,
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
      env: testEnv,
    });
    expect(result.changes).toEqual(['Repaired missing configured plugin "brave".']);
  });

  it.each([
    {
      name: "replaces a configured official web search plugin when its installed package is source-only",
      pluginId: "brave",
      npmSpec: "@openclaw/brave-plugin",
      priorSpec: "@openclaw/brave-plugin@2026.5.1-beta.1",
      targetDir: "/tmp/openclaw-plugins/brave",
      cfg: { tools: { web: { search: { provider: "brave" } } } } satisfies OpenClawConfig,
      catalogKind: "provider" as const,
    },
    {
      name: "replaces a configured official channel plugin when only its channel is configured",
      pluginId: "slack",
      npmSpec: "@openclaw/slack",
      priorSpec: "@openclaw/slack@2026.5.12-beta.1",
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
      source: "npm",
      spec: priorSpec,
      installPath: installDir,
      clawhubPackage: npmSpec,
      clawhubChannel: "official",
      clawhubUrl: "https://clawhub.ai",
    });
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue(brokenPluginSnapshot(pluginId, installDir));
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
      spec: priorSpec,
      expectedPluginId: pluginId,
      trustedSourceLinkedOfficialInstall: true,
      mode: "update",
    });
    const persistedRecords = mockCallArg(
      mocks.writePersistedInstalledPluginIndexInstallRecords,
    ) as Record<string, unknown>;
    expectRecordFields(persistedRecords[pluginId], {
      source: "npm",
      spec: priorSpec,
      installPath: targetDir,
      version: "2026.5.12",
    });
    expect(result).toEqual({
      changes: [`Installed missing configured plugin "${pluginId}" from ${priorSpec}.`],
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
      source: "npm",
      spec: "@openclaw/brave-plugin@2026.5.1-beta.1",
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
      source: "npm",
      spec: "@openclaw/brave-plugin@2026.5.1-beta.1",
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
        `Failed to install missing configured plugin "brave" from @openclaw/brave-plugin@2026.5.1-beta.1: network unavailable`,
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

  it.each(
    // prettier-ignore
    [
    ["installs missing configured non-channel plugins from the official external catalog", "diagnostics-otel", "@openclaw/diagnostics-otel", "2026.5.2", {
        id: "diagnostics-otel",
        label: "Diagnostics OpenTelemetry",
        install: {
          clawhubSpec: "clawhub:@openclaw/diagnostics-otel",
          npmSpec: "@openclaw/diagnostics-otel",
          defaultChoice: "npm" as const,
        },
      }, { plugins: { entries: { "diagnostics-otel": { enabled: true } } } }, false],
    ["installs the official llama.cpp plugin for configured local memory embeddings", "llama-cpp", "@openclaw/llama-cpp-provider", "2026.6.2", {
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
      }, { memory: { search: { provider: "local" } }, agents: { defaults: {} } }, false],
    ["does not let runtime fallback metadata override official catalog install specs", "acpx", "@openclaw/acpx", "2026.5.2-beta.2", {
        id: "acpx",
        label: "ACPX Runtime",
        install: { npmSpec: "@openclaw/acpx", defaultChoice: "npm" as const },
      }, { acp: { backend: "acpx" } }, false],
    ["installs a configured external web search plugin from provider-only config", "brave", "@openclaw/brave-plugin", "2026.5.2", officialWebSearchPluginEntry({
        id: "brave",
        npmSpec: "@openclaw/brave-plugin",
        envVar: "BRAVE_API_KEY",
        label: "Brave",
        providerLabel: "Brave Search",
        credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
        includeManifestInstall: true,
      }), { tools: { web: { search: { provider: "brave" } } } }, true],
    ["installs a configured external model provider without an auth choice", "groq", "@openclaw/groq-provider", undefined, officialPluginEntry({
        id: "groq",
        npmSpec: "@openclaw/groq-provider",
        label: "Groq",
        manifest: { providers: [{ id: "groq" }] },
      }), {
        agents: { defaults: { model: "groq/llama-3.3-70b-versatile" } },
      } satisfies OpenClawConfig, false],
    ["installs an external media-understanding provider selected only by media config", "groq", "@openclaw/groq-provider", undefined, officialPluginEntry({
        id: "groq",
        npmSpec: "@openclaw/groq-provider",
        label: "Groq",
        manifest: { contracts: { mediaUnderstandingProviders: ["groq"] } },
      }), {
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
      } satisfies OpenClawConfig, false],
    ["installs an external speech provider selected only by voiceModel", "gradium", "@openclaw/gradium-speech", undefined, officialPluginEntry({
        id: "gradium",
        npmSpec: "@openclaw/gradium-speech",
        label: "Gradium",
        manifest: { contracts: { speechProviders: ["gradium"] } },
      }), {
        agents: { defaults: { voiceModel: { primary: "gradium/tts-default" } } },
      } satisfies OpenClawConfig, false],
  ] as const,
  )("%s", async (_name, pluginId, npmSpec, version, entry, cfg, useManifestResolvers) => {
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

    expect(mocks.resolveOfficialExternalProviderPluginIdsForEnv).toHaveBeenCalledWith({
      ...testEnv,
      ...env,
    });
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
    mockNpmRegistryTags({ beta: "2026.5.4-beta.1", latest: "2026.5.3" });
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
      spec: "@openclaw/brave-plugin@2026.5.4-beta.1",
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
      env: testEnv,
    });
    expect(result.changes).toEqual([
      'Installed missing configured plugin "brave" from @openclaw/brave-plugin@2026.5.4-beta.1.',
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
      env: { ...testEnv, ...env },
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
