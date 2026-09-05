import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveConfigWriteFollowUp, type ConfigReplaceResult } from "../config/config.js";
import { createConfigFileSnapshot } from "../config/io.snapshot-shared.js";
import {
  installPackageDir,
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { PluginCapabilityConsentHandler } from "./capability-consent.js";
import {
  attachPluginInstallTransaction,
  resolvePluginInstallTransactionRequest,
} from "./install-transaction.js";
import type { PluginInstallArtifactConsentHandler } from "./install-types.js";
import { writePersistedInstalledPluginIndexInstallRecordsWithLease } from "./installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import { configSnapshot } from "./management-service.test-helpers.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import { invokePluginArtifactInstallMock } from "./test-helpers/install-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  commit: vi.fn<typeof import("./install-record-commit.js").commitPluginInstallRecordsWithConfig>(),
  officialCatalog: vi.fn(),
  readConfig: vi.fn(),
}));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshotForWrite: () => mocks.readConfig(),
}));
vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: () => mocks.officialCatalog(),
}));
vi.mock("./clawhub.js", () => ({
  installPluginFromClawHub: (...args: unknown[]) => mocks.install(...args),
}));
vi.mock("./git-install.js", () => ({
  installPluginFromGitSpec: (...args: unknown[]) => mocks.install(...args),
}));
vi.mock("./install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install.js")>()),
  installPluginFromNpmSpec: (...args: unknown[]) => mocks.install(...args),
  installPluginFromNpmPackArchive: (...args: unknown[]) => mocks.install(...args),
  installPluginFromPath: (...args: unknown[]) => mocks.install(...args),
}));
vi.mock("./marketplace.js", () => ({
  installPluginFromMarketplace: (...args: unknown[]) => mocks.install(...args),
}));
vi.mock("./install-record-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install-record-commit.js")>()),
  commitPluginInstallRecordsWithConfig: mocks.commit,
}));
vi.mock("./registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: async () => undefined,
}));
const { clearManagedPluginOfficialCatalogCache } = await import("./management-catalog.js");
const { installManagedPlugin } = await import("./management-mutations.js");
const config = { plugins: { entries: { demo: { enabled: false } } } };
const acceptCapabilities: PluginCapabilityConsentHandler = async (review) => ({
  reviewToken: review.reviewToken,
});
const requests = [
  { source: "local", path: "/incoming", mode: "update" },
  { source: "npm", spec: "demo@2.0.0", mode: "update" },
  { source: "npm-pack", archivePath: "/incoming.tgz", mode: "update" },
  { source: "git", spec: "git:example/demo", mode: "update" },
  { source: "clawhub", packageName: "community/demo", mode: "update" },
  {
    source: "marketplace",
    marketplace: "local/repo",
    plugin: "demo",
    mode: "update",
  },
] as const satisfies readonly Parameters<typeof installManagedPlugin>[0]["request"][];

async function persistCommittedInstallRecords(
  params: Parameters<typeof mocks.commit>[0],
): Promise<ConfigReplaceResult> {
  await withPluginLifecycleLease({}, async (lease) => {
    await writePersistedInstalledPluginIndexInstallRecordsWithLease(params.nextInstallRecords, {
      filePath: lease.databasePath,
      config: params.nextConfig,
      lease,
    });
  });
  const snapshot = createConfigFileSnapshot({
    ...configSnapshot(config).snapshot,
    exists: true,
    raw: JSON.stringify(config),
    runtimeConfig: config,
    issues: [],
    warnings: [],
    legacyIssues: [],
  });
  const afterWrite = params.writeOptions?.afterWrite ?? { mode: "auto" as const };
  return {
    path: snapshot.path,
    previousHash: snapshot.hash ?? null,
    snapshot,
    nextConfig: params.nextConfig,
    persistedHash: "committed-hash",
    persistedSourceConfig: params.nextConfig,
    afterWrite,
    followUp: resolveConfigWriteFollowUp(afterWrite),
  };
}

describe("managed plugin install transactions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    clearManagedPluginOfficialCatalogCache();
    mocks.readConfig.mockResolvedValue(configSnapshot(config));
    mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [] });
  });

  afterEach(() => closeOpenClawStateDatabaseForTest());

  it("rechecks the initiating owner after awaited capability consent", async () => {
    const expired = new Error("approval owner expired during review");
    let current = true;
    const targetDir = tempDirs.make("openclaw-managed-consent-");
    createColdPluginFixture({ rootDir: targetDir, pluginId: "demo" });
    mocks.install.mockImplementation(
      (params: Parameters<typeof invokePluginArtifactInstallMock>[1]) =>
        invokePluginArtifactInstallMock(
          async () => ({ ok: true, pluginId: "demo", targetDir }),
          params,
        ),
    );
    await expect(
      installManagedPlugin({
        request: { source: "local", path: "/incoming.tgz", mode: "update" },
        env: { HOME: targetDir, OPENCLAW_STATE_DIR: path.join(targetDir, "state") },
        onCapabilityConsent: async (review) => {
          await Promise.resolve();
          current = false;
          return { reviewToken: review.reviewToken };
        },
        beforePersistentEffect: () => {
          if (!current) {
            throw expired;
          }
        },
      }),
    ).rejects.toBe(expired);
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it.each([
    ...requests.flatMap((request) =>
      (
        ["before-publication", "before-config", "before-commit", "after-commit", "none"] as const
      ).map((failure) => ({ request, source: request.source, failure, authority: "caller" })),
    ),
    {
      request: requests[1],
      source: "npm",
      failure: "before-publication",
      authority: "config",
    },
  ])(
    "settles $source payloads at $failure with $authority authority",
    async ({ request, failure, authority }) => {
      let authorityOpen = true;
      const home = await fs.realpath(tempDirs.make("openclaw-managed-upgrade-"));
      const env = { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "state") };
      const sourceDir = path.join(home, "incoming");
      const targetDir = path.join(home, "extensions", "demo");
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.mkdir(targetDir, { recursive: true });
      createColdPluginFixture({
        rootDir: sourceDir,
        pluginId: "demo",
        packageVersion: "2.0.0",
        manifest: { contracts: { tools: ["demo.write"] } },
      });
      createColdPluginFixture({ rootDir: targetDir, pluginId: "demo", packageVersion: "1.0.0" });
      await fs.writeFile(path.join(sourceDir, "version"), "2.0.0");
      await fs.writeFile(path.join(targetDir, "version"), "1.0.0");
      const conflict = new Error(failure);
      const beforePersistentApply = () => {
        if (!authorityOpen) {
          throw conflict;
        }
      };
      if (authority === "config") {
        const prepared = configSnapshot(config);
        mocks.readConfig.mockResolvedValue({
          ...prepared,
          writeOptions: {
            ...prepared.writeOptions,
            assertConfigPathForWrite: beforePersistentApply,
          },
        });
      }
      mocks.commit.mockImplementation(async (params) => {
        params.writeOptions?.assertConfigPathForWrite?.();
        expect(params.nextInstallRecords.demo?.acceptedSurface?.tools).toEqual(["demo.write"]);
        if (request.source === "marketplace") {
          expect(params.nextInstallRecords.demo).toMatchObject({
            source: "marketplace",
            marketplaceSource: request.marketplace,
            marketplacePlugin: request.plugin,
          });
        }
        if (failure === "before-commit") {
          throw conflict;
        }
        return await persistCommittedInstallRecords(params);
      });
      mocks.install.mockImplementation(
        async (params: {
          onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
          beforePersistentApply?: () => void;
        }) => {
          const copy = {
            sourceDir,
            targetDir,
            beforePersistentApply: params.beforePersistentApply,
            mode: "update" as const,
            timeoutMs: 1000,
            copyErrorPrefix: "copy failed",
            hasDeps: false,
            depsLogMessage: "",
            afterInstall: async (stagedArtifactDir: string) => {
              await params.onBeforePluginArtifactCommit?.({
                pluginId: "demo",
                stagedArtifactDir,
                currentArtifactDir: targetDir,
                mode: "update",
              });
              return { ok: true as const };
            },
          };
          const transactionRequest = resolvePluginInstallTransactionRequest(params);
          const copied = await installPackageDir(
            transactionRequest
              ? requestDeferredPackageDirInstall(copy, transactionRequest.assertOwned)
              : copy,
          );
          if (!copied.ok) {
            throw new Error(copied.error);
          }
          const result = {
            ok: true,
            pluginId: "demo",
            targetDir,
            version: "2.0.0",
            extensions: [],
            marketplaceName: "Local",
            marketplaceSource: "local/repo",
            marketplacePlugin: "demo",
            git: { url: "https://example.test/demo.git" },
            packageName: "community/demo",
            clawhub: {
              source: "clawhub",
              clawhubUrl: "https://clawhub.ai",
              clawhubPackage: "community/demo",
              clawhubFamily: "code-plugin",
            },
          };
          if (failure === "before-config") {
            authorityOpen = false;
          }
          const transaction = resolvePackageDirInstallTransaction(copied);
          return transaction ? attachPluginInstallTransaction(result, transaction) : result;
        },
      );
      const onCapabilityConsent = vi.fn<PluginCapabilityConsentHandler>(async (review) => {
        expect(await fs.readFile(path.join(targetDir, "version"), "utf8")).toBe("1.0.0");
        const acknowledgment = await acceptCapabilities(review);
        if (failure === "before-publication") {
          authorityOpen = false;
        }
        return acknowledgment;
      });
      const installed = installManagedPlugin({
        request,
        env,
        onCapabilityConsent,
        beforePersistentApply: authority === "caller" ? beforePersistentApply : undefined,
        applyRuntime: async ({ pluginIds }) => {
          expect(mocks.commit).toHaveBeenCalled();
          if (failure === "after-commit") {
            throw conflict;
          }
          return { operationId: "install", generation: 1, pluginIds: [...pluginIds] };
        },
      });
      if (failure === "none") {
        await expect(installed).resolves.toMatchObject({ plugin: { id: "demo", installed: true } });
      } else if (failure === "before-publication") {
        await expect(installed).rejects.toThrow(conflict.message);
        expect(mocks.commit).not.toHaveBeenCalled();
      } else {
        await expect(installed).rejects.toBe(conflict);
      }
      expect(onCapabilityConsent).toHaveBeenCalledOnce();
      const installedIndex = readPersistedInstalledPluginIndexSync({ env });
      if (failure === "after-commit" || failure === "none") {
        expect(installedIndex).toMatchObject({
          installRecords: {
            demo: { installPath: targetDir, acceptedSurface: { tools: ["demo.write"] } },
          },
          plugins: expect.arrayContaining([
            expect.objectContaining({ pluginId: "demo", installOwner: "demo", rootDir: targetDir }),
          ]),
        });
      } else {
        expect(installedIndex).toBeNull();
      }
      expect(await fs.readFile(path.join(targetDir, "version"), "utf8"), failure).toBe(
        failure === "after-commit" || failure === "none" ? "2.0.0" : "1.0.0",
      );
      expect(await fs.readdir(path.join(home, "extensions", ".openclaw-install-backups"))).toEqual(
        [],
      );
    },
  );

  it("leaves linked operator source untouched when persistence fails", async () => {
    const sourcePath = tempDirs.make("openclaw-managed-link-");
    createColdPluginFixture({ rootDir: sourcePath, pluginId: "demo" });
    await fs.writeFile(path.join(sourcePath, "version"), "operator-owned");
    const conflict = new Error("config changed during plugin link");
    mocks.install.mockResolvedValue({ ok: true, pluginId: "demo", targetDir: sourcePath });
    mocks.commit.mockRejectedValue(conflict);
    await expect(
      installManagedPlugin({
        request: {
          source: "local",
          path: sourcePath,
          mode: "install",
          link: true,
        },
        env: { HOME: sourcePath, OPENCLAW_STATE_DIR: path.join(sourcePath, "state") },
        onCapabilityConsent: acceptCapabilities,
      }),
    ).rejects.toBe(conflict);
    expect(mocks.install).toHaveBeenCalledWith(
      expect.objectContaining({ path: sourcePath, dryRun: true }),
    );
    expect(await fs.readFile(path.join(sourcePath, "version"), "utf8")).toBe("operator-owned");
  });

  it.each(["rollback", "commit"] as const)(
    "reports %s failure without reversing committed state",
    async (settlement) => {
      const conflict = new Error("config write rejected");
      const settlementError = new Error(`${settlement} failed`);
      const transaction = { commit: vi.fn(), rollback: vi.fn() };
      transaction[settlement].mockRejectedValue(settlementError);
      const targetDir = tempDirs.make("openclaw-managed-settlement-");
      createColdPluginFixture({ rootDir: targetDir, pluginId: "demo" });
      mocks.install.mockImplementation(
        (params: Parameters<typeof invokePluginArtifactInstallMock>[1]) =>
          invokePluginArtifactInstallMock(
            async () =>
              attachPluginInstallTransaction(
                { ok: true, pluginId: "demo", targetDir },
                transaction,
              ),
            params,
          ),
      );
      mocks.commit.mockImplementation(async (params) => {
        if (settlement === "rollback") {
          throw conflict;
        }
        return await persistCommittedInstallRecords(params);
      });
      const installed = installManagedPlugin({
        request: { source: "local", path: "/incoming", mode: "update" },
        env: { HOME: targetDir, OPENCLAW_STATE_DIR: path.join(targetDir, "state") },
        onCapabilityConsent: acceptCapabilities,
      });
      if (settlement === "rollback") {
        await expect(installed).rejects.toMatchObject({
          cause: conflict,
          errors: [conflict, settlementError],
        });
        expect(transaction.commit).not.toHaveBeenCalled();
      } else {
        const warning = "Plugin install committed, but backup cleanup failed.";
        await expect(installed).resolves.toMatchObject({
          plugin: { id: "demo", installed: true },
          warnings: [warning],
        });
        expect(transaction.rollback).not.toHaveBeenCalled();
      }
    },
  );
});
