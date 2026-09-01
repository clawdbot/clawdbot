import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  installPackageDir,
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import type { PluginCapabilityConsentHandler } from "./capability-consent.js";
import {
  attachPluginInstallTransaction,
  resolvePluginInstallTransactionRequest,
} from "./install-transaction.js";
import type { PluginInstallArtifactConsentHandler } from "./install-types.js";
import type { ManagedPluginSourceInstallRequest } from "./management-service.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import { invokePluginArtifactInstallMock } from "./test-helpers/install-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mocks = vi.hoisted(() => ({ install: vi.fn(), persist: vi.fn() }));
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
vi.mock("./install-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install-persistence.js")>()),
  persistPluginInstall: (...args: unknown[]) => mocks.persist(...args),
}));
const { installManagedPluginSource } = await import("./management-service.js");
const snapshot = { config: {}, baseHash: "base-hash", writeOptions: {} };
const acceptCapabilities: PluginCapabilityConsentHandler = async (review) => ({
  reviewToken: review.reviewToken,
});
const requests = [
  { source: "local", path: "/incoming", recordSource: "path", mode: "update" },
  { source: "npm", spec: "demo@2.0.0", mode: "update" },
  { source: "npm-pack", archivePath: "/incoming.tgz", mode: "update" },
  { source: "git", spec: "git:example/demo", mode: "update" },
  { source: "clawhub", spec: "clawhub:community/demo", mode: "update" },
  {
    source: "marketplace",
    marketplace: "local/repo",
    plugin: "demo",
    mode: "update",
  },
] satisfies ManagedPluginSourceInstallRequest[];

describe("managed plugin install transactions", () => {
  beforeEach(() => vi.resetAllMocks());

  it("rechecks the initiating owner after awaited capability consent", async () => {
    const expired = new Error("approval owner expired during review");
    let current = true;
    mocks.install.mockImplementation(
      (params: Parameters<typeof invokePluginArtifactInstallMock>[1]) =>
        invokePluginArtifactInstallMock(
          async () => ({ ok: true, pluginId: "demo", targetDir: "/managed/demo" }),
          params,
        ),
    );
    await expect(
      installManagedPluginSource({
        request: {
          source: "local",
          path: "/incoming.tgz",
          recordSource: "archive",
          mode: "update",
        },
        snapshot,
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
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it.each(requests)("settles $source payloads at the config commit boundary", async (request) => {
    for (const failure of ["authority-closed", "before-commit", "after-commit", "none"] as const) {
      mocks.persist.mockClear();
      const home = await fs.realpath(tempDirs.make("openclaw-managed-upgrade-"));
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
      let active = true;
      mocks.persist.mockImplementation(
        async (
          params: Parameters<typeof import("./install-persistence.js").persistPluginInstall>[0],
        ) => {
          params.beforePersistentApply?.();
          expect(params.install.acceptedSurface?.tools).toEqual(["demo.write"]);
          if (request.source === "marketplace") {
            expect(params.install).toMatchObject({
              source: "marketplace",
              marketplaceSource: request.marketplace,
              marketplacePlugin: request.plugin,
            });
          }
          if (failure === "before-commit") {
            throw conflict;
          }
          params.onCommitted?.();
          if (failure === "after-commit") {
            throw conflict;
          }
          return {};
        },
      );
      mocks.install.mockImplementation(
        async (params: {
          onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
          beforePersistentApply?: () => void;
        }) => {
          const copy = {
            sourceDir,
            targetDir,
            mode: "update" as const,
            timeoutMs: 1000,
            copyErrorPrefix: "copy failed",
            hasDeps: false,
            depsLogMessage: "",
            beforePersistentApply: params.beforePersistentApply,
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
          const transaction = resolvePackageDirInstallTransaction(copied);
          return transaction ? attachPluginInstallTransaction(result, transaction) : result;
        },
      );
      const onCapabilityConsent = vi.fn<PluginCapabilityConsentHandler>(async (review) => {
        expect(await fs.readFile(path.join(targetDir, "version"), "utf8")).toBe("1.0.0");
        active = failure !== "authority-closed";
        return await acceptCapabilities(review);
      });
      const installed = installManagedPluginSource({
        request,
        snapshot,
        env: { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "state") },
        onCapabilityConsent,
        beforePersistentApply: () => {
          if (!active) {
            throw conflict;
          }
        },
      });
      if (failure === "none") {
        await expect(installed).resolves.toMatchObject({ ok: true });
      } else if (failure === "authority-closed") {
        await expect(installed).rejects.toThrow("authority-closed");
        expect(mocks.persist).not.toHaveBeenCalled();
      } else {
        await expect(installed).rejects.toBe(conflict);
      }
      expect(onCapabilityConsent).toHaveBeenCalledOnce();
      expect(await fs.readFile(path.join(targetDir, "version"), "utf8"), failure).toBe(
        failure === "before-commit" || failure === "authority-closed" ? "1.0.0" : "2.0.0",
      );
      expect(await fs.readdir(path.join(home, "extensions", ".openclaw-install-backups"))).toEqual(
        [],
      );
    }
  });

  it("leaves linked operator source untouched when persistence fails", async () => {
    const sourcePath = tempDirs.make("openclaw-managed-link-");
    createColdPluginFixture({ rootDir: sourcePath, pluginId: "demo" });
    await fs.writeFile(path.join(sourcePath, "version"), "operator-owned");
    const conflict = new Error("config changed during plugin link");
    mocks.install.mockResolvedValue({ ok: true, pluginId: "demo", targetDir: sourcePath });
    mocks.persist.mockRejectedValue(conflict);
    await expect(
      installManagedPluginSource({
        request: {
          source: "local",
          path: sourcePath,
          recordSource: "path",
          mode: "install",
          link: true,
        },
        snapshot,
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
      mocks.install.mockImplementation(
        (params: Parameters<typeof invokePluginArtifactInstallMock>[1]) =>
          invokePluginArtifactInstallMock(
            async () =>
              attachPluginInstallTransaction(
                { ok: true, pluginId: "demo", targetDir: "/managed/demo" },
                transaction,
              ),
            params,
          ),
      );
      mocks.persist.mockImplementation(async (params: { onCommitted?: () => void }) => {
        if (settlement === "rollback") {
          throw conflict;
        }
        params.onCommitted?.();
        return {};
      });
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const installed = installManagedPluginSource({
        request: { source: "local", path: "/incoming", recordSource: "path", mode: "update" },
        snapshot,
        runtime,
        onCapabilityConsent: acceptCapabilities,
      });
      if (settlement === "rollback") {
        await expect(installed).rejects.toMatchObject({
          cause: conflict,
          errors: [conflict, settlementError],
        });
        expect(transaction.commit).not.toHaveBeenCalled();
      } else {
        const warning = "Plugin install committed, but backup cleanup failed. Restart is required.";
        await expect(installed).resolves.toMatchObject({ ok: true, warnings: [warning] });
        expect(runtime.log).toHaveBeenCalledWith(warning);
        expect(transaction.rollback).not.toHaveBeenCalled();
      }
    },
  );
});
