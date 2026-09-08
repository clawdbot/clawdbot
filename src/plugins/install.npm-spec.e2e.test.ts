// Exercises npm-spec plugin install behavior through the CLI path.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginNpmProjectDir } from "./install-paths.js";
import { withPluginInstallRoots } from "./install-root-context.js";
import {
  requestDeferredPluginInstall,
  resolvePluginInstallTransaction,
} from "./install-transaction.js";
import {
  installPluginFromNpmPackArchive,
  installPluginFromNpmSpec,
  PLUGIN_INSTALL_ERROR_CODE,
} from "./install.js";
import {
  configWithInstalledPackageTreeBlockPolicy,
  createInstalledPackageTreePolicyExec,
  installProjectDependencies,
} from "./install.npm-spec.test-support.js";
import { runPluginPayloadSmokeCheck } from "./payload-verification.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import {
  packPlugins,
  registryPackages,
  startStaticRegistry,
  startMutableRegistry,
  type RegistryPackage,
} from "./test-helpers/npm-registry-fixtures.js";
import { syncPluginsForUpdateChannel } from "./update-channel.js";

const tempDirs = createTempDirTracker();
const servers: http.Server[] = [];
const envKeys = ["NPM_CONFIG_REGISTRY", "npm_config_registry"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const execFileAsync = promisify(execFile);

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  for (const key of envKeys) {
    const original = originalEnv[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  tempDirs.cleanup();
});

async function makeInstallFixture(label: string) {
  const rootDir = tempDirs.make(`openclaw-${label}-`);
  return { rootDir, npmRoot: path.join(rootDir, "managed-npm") };
}

function uniquePackageName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function pluginNpmProjectRoot(npmRoot: string, packageName: string): string {
  return resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
}

async function useStaticRegistry(packages: RegistryPackage[]): Promise<string> {
  const registry = await startStaticRegistry(packages, servers);
  useRegistry(registry);
  return registry;
}

function useRegistry(registry: string): void {
  process.env.NPM_CONFIG_REGISTRY = registry;
  process.env.npm_config_registry = registry;
}

async function installNpmPlugin(params: {
  config?: OpenClawConfig;
  expectedIntegrity?: string;
  npmRoot: string;
  spec: string;
}) {
  return await installPluginFromNpmSpec({
    ...(params.config ? { config: params.config } : {}),
    ...(params.expectedIntegrity ? { expectedIntegrity: params.expectedIntegrity } : {}),
    spec: params.spec,
    npmDir: params.npmRoot,
    logger: { info: () => {}, warn: () => {} },
    timeoutMs: 120_000,
  });
}

describe("installPluginFromNpmSpec e2e", () => {
  it.each(["npm", "npm-pack"] as const)(
    "preserves a real %s successor when an earlier lifecycle lease has closed",
    { timeout: 120_000 },
    async (source) => {
      const { rootDir, npmRoot } = await makeInstallFixture("npm-rollback-owner-e2e");
      const packageName = uniquePackageName("rollback-owner");
      const versions = await packPlugins(rootDir, [
        { packageName, version: "1.0.0" },
        { packageName, version: "2.0.0" },
      ]);
      await useStaticRegistry([{ packageName, latest: "2.0.0", versions }]);
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(rootDir, "state") };
      const install = (version: string, deferCommit = false, cancelBeforePublish = false) =>
        withPluginLifecycleLease({ env }, async (lease) => {
          let callerActive = true;
          const params = requestDeferredPluginInstall(
            {
              npmDir: npmRoot,
              mode: "update" as const,
              timeoutMs: 120_000,
              beforePersistentApply: () => {
                if (!callerActive) {
                  throw new Error("caller authority closed");
                }
              },
              onBeforePluginArtifactCommit: async () => {
                lease.assertOwned();
                callerActive = !cancelBeforePublish;
              },
            },
            undefined,
            () => lease.assertOwned(),
          );
          const result =
            source === "npm"
              ? await installPluginFromNpmSpec({ ...params, spec: `${packageName}@${version}` })
              : await installPluginFromNpmPackArchive({
                  ...params,
                  archivePath: path.join(rootDir, `${packageName}-${version}.tgz`),
                });
          if (!result.ok) {
            throw new Error(result.error);
          }
          const transaction = resolvePluginInstallTransaction(result);
          if (!transaction) {
            throw new Error("expected deferred npm install");
          }
          if (!deferCommit) {
            await transaction.commit();
          }
          return { result, transaction };
        });

      await install("1.0.0");
      const older = await install("2.0.0", true);
      const successor = await install("2.0.0");
      expect(successor.result.targetDir).toBe(older.result.targetDir);
      const projectRoot = path.dirname(path.dirname(successor.result.targetDir));
      const manifestPath = path.join(projectRoot, "package.json");
      const protectedFiles = [
        manifestPath,
        path.join(projectRoot, "package-lock.json"),
        path.join(successor.result.targetDir, "dist", "index.js"),
      ];
      if (source === "npm-pack") {
        const manifest = await readJson<{ dependencies: Record<string, string> }>(manifestPath);
        const dependencySpec = manifest.dependencies[packageName];
        if (!dependencySpec?.startsWith("file:")) {
          throw new Error("expected a managed npm-pack file dependency");
        }
        protectedFiles.push(path.resolve(projectRoot, dependencySpec.slice("file:".length)));
      }
      const before = await Promise.all(protectedFiles.map((file) => fs.readFile(file)));

      const rollbackError = await older.transaction.rollback().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect.soft(rollbackError).toHaveProperty("code", "OPENCLAW_STATE_LEASE_LOST");
      const after = await Promise.all(protectedFiles.map((file) => fs.readFile(file)));
      expect(after).toEqual(before);

      await expect(install("2.0.0", false, true)).rejects.toThrow("caller authority closed");
      expect(await Promise.all(protectedFiles.map((file) => fs.readFile(file)))).toEqual(before);
    },
  );

  it("relocates a bundled plugin through real npm only after artifact consent", async () => {
    const { rootDir, npmRoot } = await makeInstallFixture("relocation-e2e");
    const packageName = uniquePackageName("relocated-plugin");
    await useStaticRegistry(await registryPackages(rootDir, [{ packageName }]));
    const bundledPath = path.join(rootDir, "old", "extensions", packageName);
    const config: OpenClawConfig = {
      plugins: {
        entries: { [packageName]: { enabled: true } },
        load: { paths: [bundledPath] },
        installs: {
          [packageName]: { source: "path", sourcePath: bundledPath, installPath: bundledPath },
        },
      },
    };
    const roots = {
      npmDir: npmRoot,
      extensionsDir: path.join(rootDir, "extensions"),
      gitDir: path.join(rootDir, "git"),
      stateDir: path.join(rootDir, "state"),
    };
    const sync = (accept: boolean) =>
      withPluginInstallRoots(roots, () =>
        syncPluginsForUpdateChannel({
          config,
          channel: "stable",
          env: { ...process.env, OPENCLAW_STATE_DIR: roots.stateDir },
          externalizedBundledPluginBridges: [
            { bundledPluginId: packageName, npmSpec: packageName },
          ],
          ...(accept
            ? {
                onCapabilityConsent: async (details: { reviewToken: string }) => ({
                  reviewToken: details.reviewToken,
                }),
              }
            : {}),
        }),
      );
    const refused = await sync(false);
    expect(refused.config).toEqual(config);
    expect(refused.summary.errors).toEqual([
      expect.objectContaining({
        pluginId: packageName,
        code: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
      }),
    ]);
    expect(refused.summary.errors[0]?.message).toContain(
      "did not install the replacement plugin payload",
    );
    expect(refused.summary.errors[0]?.message).not.toContain("payload is missing");
    const projectDir = pluginNpmProjectRoot(npmRoot, packageName);
    await expect(fs.access(projectDir)).rejects.toHaveProperty("code", "ENOENT");
    const accepted = await sync(true);
    expect(accepted.summary.errors).toEqual([]);
    expect(accepted.config.plugins?.load?.paths).toEqual([]);
    expect(accepted.config.plugins?.installs?.[packageName]?.source).toBe("npm");
    expect(
      await runPluginPayloadSmokeCheck({
        records: accepted.config.plugins?.installs ?? {},
        env: process.env,
      }),
    ).toEqual({ checked: [packageName], failures: [] });
  }, 120_000);

  it.each(["plugin", "hook pack"] as const)(
    "does not persist an npm %s when delegated authority closes during download",
    { timeout: 180_000 },
    async (kind) => {
      const { rootDir } = await makeInstallFixture("npm-delegated-install-e2e");
      const packageName = uniquePackageName("delegated-install");
      const downloadBarrier = { requested: createDeferred(), released: createDeferred() };
      const registry = await startStaticRegistry(
        await registryPackages(rootDir, [
          {
            packageName,
            ...(kind === "hook pack" ? { hookName: "cancel-test-hook" } : {}),
          },
        ]),
        servers,
        downloadBarrier,
      );
      const stateDir = path.join(rootDir, "state");
      const configPath = path.join(stateDir, "openclaw.json");
      const reportPath = path.join(rootDir, "install-result.json");
      const npmConfigPath = path.join(rootDir, "empty.npmrc");
      const npmGlobalConfigPath = path.join(rootDir, "global.npmrc");
      await fs.writeFile(npmConfigPath, "");
      await fs.writeFile(npmGlobalConfigPath, "");
      // Import in a fresh process so the hook payload owner resolves this isolated state root.
      const script = `
        import { existsSync } from "node:fs";
        import fs from "node:fs/promises";
        import path from "node:path";
        import { randomUUID } from "node:crypto";
        import { runPluginInstallCommand } from ${JSON.stringify(new URL("../cli/plugins-install-command.ts", import.meta.url).href)};
        import { writeConfigFile } from ${JSON.stringify(new URL("../config/config.ts", import.meta.url).href)};
        import { readHookInstalls } from ${JSON.stringify(new URL("../hooks/installs.ts", import.meta.url).href)};
        import { readPersistedInstalledPluginIndexInstallRecords } from ${JSON.stringify(new URL("./installed-plugin-index-records.ts", import.meta.url).href)};
        import {
          claimAgentRunDelegatedAuthority,
          releaseAgentRunDelegatedAuthority,
          validateAgentRunDelegatedAuthority,
        } from ${JSON.stringify(new URL("../infra/agent-run-registry.ts", import.meta.url).href)};
        const [packageName, registry, reportPath] = JSON.parse(process.argv[1]);
        await writeConfigFile({});
        const configBefore = await fs.readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8");
        const observations = {};
        for (const stage of ["cancelled", "active"]) {
          const authority = claimAgentRunDelegatedAuthority(Object.freeze({
            instanceId: randomUUID(), runId: randomUUID(),
          }));
          const errors = [];
          let exitCode = 0;
          let authorityClosed = false;
          const cancellationAbort = new AbortController();
          const cancellation = stage === "cancelled"
            ? (async () => {
                await fetch(registry + "/-/test/authority-close", {
                  signal: cancellationAbort.signal,
                }).then((response) => response.text());
                authorityClosed = releaseAgentRunDelegatedAuthority(authority)
                  && !validateAgentRunDelegatedAuthority(authority);
                if (!authorityClosed) throw new Error("Failed to close delegated authority");
                await fetch(registry + "/-/test/authority-closed").then((response) => response.text());
              })().catch((error) => errors.push(String(error)))
            : Promise.resolve();
          try {
            await runPluginInstallCommand({
              raw: "npm:" + packageName + "@1.0.0",
              opts: { force: true, acceptCapabilities: true },
              allowInstallPolicyWarningPrompt: false,
              beforePersistentApply: () => {
                if (!validateAgentRunDelegatedAuthority(authority)) {
                  throw new Error("Delegated install authority closed");
                }
              },
              runtime: {
                log() {},
                error: (...args) => errors.push(args.join(" ")),
                exit: (code) => { exitCode = code; },
              },
            });
          } catch (error) {
            exitCode = 1;
            errors.push(String(error));
          }
          cancellationAbort.abort();
          await cancellation;
          const npmEntries = await fs.readdir(path.join(process.env.OPENCLAW_STATE_DIR, "npm"), {
            recursive: true,
          }).catch((error) => {
            if (error.code === "ENOENT") return [];
            throw error;
          });
          observations[stage] = {
            exitCode, authorityClosed, error: errors.join("\\n"),
            configUnchanged: configBefore === await fs.readFile(process.env.OPENCLAW_CONFIG_PATH, "utf8"),
            pluginInstalls: await readPersistedInstalledPluginIndexInstallRecords() ?? {},
            hookInstalls: readHookInstalls(),
            npmPayloads: npmEntries.filter((entry) => entry.endsWith(path.join("node_modules", packageName))),
            hookPayload: existsSync(path.join(process.env.OPENCLAW_STATE_DIR, "hooks", packageName)),
          };
          releaseAgentRunDelegatedAuthority(authority);
        }
        await fs.writeFile(reportPath, JSON.stringify(observations));
      `;
      try {
        const result = await runNodeScript(
          [
            "--import",
            "tsx",
            "--input-type=module",
            "--eval",
            script,
            JSON.stringify([packageName, registry, reportPath]),
          ],
          {
            ...process.env,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_HOME: rootDir,
            OPENCLAW_AGENT_DIR: undefined,
            NPM_CONFIG_REGISTRY: registry,
            npm_config_registry: registry,
            NPM_CONFIG_CACHE: path.join(rootDir, "npm-cache"),
            npm_config_cache: path.join(rootDir, "npm-cache"),
            NPM_CONFIG_USERCONFIG: npmConfigPath,
            npm_config_userconfig: npmConfigPath,
            NPM_CONFIG_GLOBALCONFIG: npmGlobalConfigPath,
            npm_config_globalconfig: npmGlobalConfigPath,
          },
          150_000,
          { maxBuffer: 64 * 1024, requireProcessTreeExit: true },
        );
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const observations = await readJson<
          Record<
            "cancelled" | "active",
            {
              exitCode: number;
              authorityClosed: boolean;
              error: string;
              configUnchanged: boolean;
              pluginInstalls: Record<string, unknown>;
              hookInstalls: Record<string, unknown>;
              npmPayloads: string[];
              hookPayload: boolean;
            }
          >
        >(reportPath);
        expect(observations.cancelled.error).toContain("Delegated install authority closed");
        expect(observations.cancelled).toMatchObject({
          exitCode: 1,
          authorityClosed: true,
          configUnchanged: true,
          npmPayloads: [],
          hookPayload: false,
        });
        expect(observations.cancelled.pluginInstalls).toEqual({});
        expect(observations.cancelled.hookInstalls).toEqual({});
        // The same artifact still installs under a fresh live claim; rejection is not a broken fixture.
        expect(observations.active.exitCode, observations.active.error).toBe(0);
        expect(observations.active.configUnchanged).toBe(false);
        if (kind === "plugin") {
          expect(Object.keys(observations.active.pluginInstalls)).toEqual([packageName]);
          expect(observations.active.npmPayloads).toHaveLength(1);
        } else {
          expect(Object.keys(observations.active.hookInstalls)).toEqual([packageName]);
          expect(observations.active.hookPayload).toBe(true);
        }
      } finally {
        downloadBarrier.requested.resolve();
        downloadBarrier.released.resolve();
      }
    },
  );

  it("installs the newest compatible stable package when npm latest requires a newer plugin API", async () => {
    const { rootDir, npmRoot } = await makeInstallFixture("npm-plugin-compatible-version-e2e");
    const packageName = uniquePackageName("compatible-plugin");
    const compatibleOpenClaw = {
      extensions: ["./dist/index.js"],
      install: { minHostVersion: ">=2026.4.25" },
      compat: { pluginApi: ">=2026.5.10-beta.1" },
    };
    const incompatibleOpenClaw = {
      extensions: ["./dist/index.js"],
      install: { minHostVersion: ">=2026.4.25" },
      compat: { pluginApi: ">=2026.5.27" },
    };
    const versions = await packPlugins(rootDir, [
      {
        packageName,
        version: "2026.5.26",
        openclaw: compatibleOpenClaw,
      },
      {
        packageName,
        version: "2026.5.27",
        openclaw: incompatibleOpenClaw,
      },
    ]);
    await useStaticRegistry([{ packageName, latest: "2026.5.27", versions }]);
    const previousHostVersion = process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = "2026.5.10-beta.1";
    const warnings: string[] = [];

    try {
      const result = await installPluginFromNpmSpec({
        spec: packageName,
        npmDir: npmRoot,
        logger: { warn: (message) => warnings.push(message) },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.npmResolution?.version).toBe("2026.5.26");
      expect(result.npmResolution?.resolvedSpec).toBe(`${packageName}@2026.5.26`);
      expect(warnings.join("\n")).toContain(`using newest compatible ${packageName}@2026.5.26`);
      const projectRoot = pluginNpmProjectRoot(npmRoot, packageName);
      const installedPackageJson = await readJson<{ version?: string }>(
        path.join(projectRoot, "node_modules", packageName, "package.json"),
      );
      expect(installedPackageJson.version).toBe("2026.5.26");
    } finally {
      if (previousHostVersion === undefined) {
        delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
      } else {
        process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = previousHostVersion;
      }
    }
  });

  it("scrubs root openclaw materialized by required npm peers", async () => {
    const { rootDir, npmRoot } = await makeInstallFixture("npm-plugin-required-peer-e2e");
    const packageName = uniquePackageName("required-peer-plugin");
    const registry = await useStaticRegistry(
      await registryPackages(rootDir, [
        {
          packageName,
          peerDependencies: { openclaw: ">=2026.0.0" },
          peerDependenciesMeta: {},
        },
        {
          packageName: "openclaw",
          pluginId: "registry-openclaw-copy",
          version: "2026.0.0",
        },
      ]),
    );

    const rawNpmRoot = path.join(rootDir, "raw-managed-npm");
    await fs.mkdir(rawNpmRoot, { recursive: true });
    await fs.writeFile(
      path.join(rawNpmRoot, "package.json"),
      `${JSON.stringify({ private: true, dependencies: { [packageName]: "1.0.0" } }, null, 2)}\n`,
      "utf8",
    );
    await execFileAsync(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
      {
        cwd: rawNpmRoot,
        env: {
          ...process.env,
          NPM_CONFIG_REGISTRY: registry,
          NPM_CONFIG_LEGACY_PEER_DEPS: "false",
          NPM_CONFIG_STRICT_PEER_DEPS: "false",
          npm_config_registry: registry,
          npm_config_legacy_peer_deps: "false",
          npm_config_strict_peer_deps: "false",
        },
        timeout: 120_000,
      },
    );
    const rawLock = await readJson<{
      packages?: Record<string, unknown>;
    }>(path.join(rawNpmRoot, "package-lock.json"));
    const rawOpenClawLockEntry = rawLock.packages?.["node_modules/openclaw"] as
      | { peer?: unknown; version?: unknown }
      | undefined;
    expect(rawOpenClawLockEntry?.peer).toBe(true);
    expect(rawOpenClawLockEntry?.version).toBe("2026.0.0");

    const result = await installNpmPlugin({
      spec: `${packageName}@1.0.0`,
      npmRoot,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }

    const projectRoot = pluginNpmProjectRoot(npmRoot, packageName);
    const lock = await readJson<{
      packages?: Record<string, unknown>;
    }>(path.join(projectRoot, "package-lock.json"));
    expect(lock.packages?.["node_modules/openclaw"]).toBeUndefined();
    await expect(
      fs.lstat(path.join(projectRoot, "node_modules", "openclaw")),
    ).rejects.toHaveProperty("code", "ENOENT");
    await expect(
      fs
        .lstat(path.join(result.targetDir, "node_modules", "openclaw"))
        .then((stat) => stat.isSymbolicLink()),
    ).resolves.toBe(true);
  });

  it("keeps third-party peer dependencies in the owning npm project across later installs", async () => {
    const { rootDir, npmRoot } = await makeInstallFixture("npm-plugin-third-party-peer-e2e");
    const pluginWithRuntimePeer = uniquePackageName("runtime-peer-plugin");
    const laterPlugin = uniquePackageName("later-plugin");
    const runtimePeer = uniquePackageName("runtime-peer");
    await useStaticRegistry(
      await registryPackages(rootDir, [
        {
          packageName: pluginWithRuntimePeer,
          peerDependencies: { [runtimePeer]: "^1.0.0" },
          peerDependenciesMeta: {},
        },
        { packageName: laterPlugin },
        { packageName: runtimePeer },
      ]),
    );

    const first = await installNpmPlugin({
      spec: `${pluginWithRuntimePeer}@1.0.0`,
      npmRoot,
    });
    if (!first.ok) {
      throw new Error(first.error);
    }
    const firstProjectRoot = pluginNpmProjectRoot(npmRoot, pluginWithRuntimePeer);
    await expect(
      fs.lstat(path.join(firstProjectRoot, "node_modules", runtimePeer, "package.json")),
    ).resolves.toBeTruthy();

    const second = await installNpmPlugin({
      spec: `${laterPlugin}@1.0.0`,
      npmRoot,
    });
    if (!second.ok) {
      throw new Error(second.error);
    }

    await expect(
      fs.lstat(path.join(firstProjectRoot, "node_modules", runtimePeer, "package.json")),
    ).resolves.toBeTruthy();
  });

  it("plans peers from installed optional dependencies", async () => {
    const { rootDir, npmRoot } = await makeInstallFixture("npm-plugin-optional-peer-e2e");
    const pluginWithOptionalDependency = uniquePackageName("optional-owner-plugin");
    const optionalDependency = uniquePackageName("optional-dep");
    const runtimePeer = uniquePackageName("optional-peer");
    await useStaticRegistry(
      await registryPackages(rootDir, [
        {
          packageName: pluginWithOptionalDependency,
          optionalDependencies: { [optionalDependency]: "1.0.0" },
        },
        {
          packageName: optionalDependency,
          peerDependencies: { [runtimePeer]: "^1.0.0" },
          peerDependenciesMeta: {},
        },
        { packageName: runtimePeer },
      ]),
    );

    const result = await installNpmPlugin({
      spec: `${pluginWithOptionalDependency}@1.0.0`,
      npmRoot,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }

    const projectRoot = pluginNpmProjectRoot(npmRoot, pluginWithOptionalDependency);
    await expect(
      fs.lstat(path.join(projectRoot, "node_modules", optionalDependency, "package.json")),
    ).resolves.toBeTruthy();
    await expect(
      fs.lstat(path.join(projectRoot, "node_modules", runtimePeer, "package.json")),
    ).resolves.toBeTruthy();
    const rootManifest = await readJson<{
      dependencies?: Record<string, string>;
      openclaw?: { managedPeerDependencies?: string[] };
    }>(path.join(projectRoot, "package.json"));
    expect(["1.0.0", "^1.0.0"]).toContain(rootManifest.dependencies?.[runtimePeer]);
    expect(rootManifest.openclaw?.managedPeerDependencies ?? []).toContain(runtimePeer);
  });

  it("leaves legacy flat-root peer dependencies alone during isolated later installs", async () => {
    const { rootDir, npmRoot } = await makeInstallFixture("npm-plugin-repaired-peer-scan-e2e");
    const pluginWithRuntimePeer = uniquePackageName("existing-peer-plugin");
    const laterPlugin = uniquePackageName("later-plugin");
    const runtimePeer = uniquePackageName("runtime-peer");
    await useStaticRegistry(
      await registryPackages(rootDir, [
        {
          packageName: pluginWithRuntimePeer,
          peerDependencies: { [runtimePeer]: "^1.0.0" },
          peerDependenciesMeta: {},
        },
        { packageName: laterPlugin },
        { indexJs: "eval('1');\n", packageName: runtimePeer },
      ]),
    );

    await installProjectDependencies(npmRoot, { [pluginWithRuntimePeer]: "1.0.0" });
    await expect(
      fs.lstat(path.join(npmRoot, "node_modules", runtimePeer, "package.json")),
    ).rejects.toHaveProperty("code", "ENOENT");

    const later = await installNpmPlugin({
      spec: `${laterPlugin}@1.0.0`,
      npmRoot,
    });
    if (!later.ok) {
      throw new Error(later.error);
    }

    const laterProjectRoot = pluginNpmProjectRoot(npmRoot, laterPlugin);
    await expect(
      fs.lstat(path.join(laterProjectRoot, "node_modules", laterPlugin, "package.json")),
    ).resolves.toBeTruthy();
    await expect(
      fs.lstat(path.join(npmRoot, "node_modules", runtimePeer, "package.json")),
    ).rejects.toHaveProperty("code", "ENOENT");
    const rootManifest = await readJson<{
      dependencies?: Record<string, string>;
      openclaw?: { managedPeerDependencies?: string[] };
    }>(path.join(npmRoot, "package.json"));
    expect(rootManifest.dependencies?.[laterPlugin]).toBeUndefined();
    expect(rootManifest.dependencies?.[runtimePeer]).toBeUndefined();
    expect(rootManifest.openclaw?.managedPeerDependencies ?? []).not.toContain(runtimePeer);
  });

  it("ignores legacy flat-root package cycles during isolated installs", async () => {
    const { rootDir, npmRoot } = await makeInstallFixture("npm-plugin-peer-cycle-e2e");
    const existingPlugin = uniquePackageName("existing-plugin");
    const laterPlugin = uniquePackageName("later-plugin");
    await useStaticRegistry(
      await registryPackages(rootDir, [
        { packageName: existingPlugin },
        { packageName: laterPlugin },
      ]),
    );

    await installProjectDependencies(npmRoot, { [existingPlugin]: "1.0.0" });
    const existingPluginDir = path.join(npmRoot, "node_modules", existingPlugin);
    await fs.mkdir(path.join(existingPluginDir, "node_modules"), { recursive: true });
    await fs.symlink(existingPluginDir, path.join(existingPluginDir, "node_modules", "self"));

    const later = await installNpmPlugin({
      spec: `${laterPlugin}@1.0.0`,
      npmRoot,
    });

    expect(later.ok).toBe(true);
    await expect(
      fs.lstat(
        path.join(
          pluginNpmProjectRoot(npmRoot, laterPlugin),
          "node_modules",
          laterPlugin,
          "package.json",
        ),
      ),
    ).resolves.toBeTruthy();
  });

  it("rolls back managed peer dependencies added before a failed installed package policy scan", async () => {
    const { rootDir, npmRoot } = await makeInstallFixture("npm-plugin-peer-rollback-e2e");
    const policyExec = await createInstalledPackageTreePolicyExec(rootDir);
    const blockedPlugin = uniquePackageName("blocked-plugin");
    const runtimePeer = uniquePackageName("runtime-peer");
    await useStaticRegistry(
      await registryPackages(rootDir, [
        {
          indexJs: "eval('1');\n",
          packageName: blockedPlugin,
          peerDependencies: { [runtimePeer]: "^1.0.0" },
          peerDependenciesMeta: {},
        },
        { packageName: runtimePeer },
      ]),
    );

    const result = await installNpmPlugin({
      config: configWithInstalledPackageTreeBlockPolicy(policyExec),
      spec: `${blockedPlugin}@1.0.0`,
      npmRoot,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED);
      expect(result.error).toContain("Install blocked by policy");
      expect(result.error).toContain("Reason: blocked installed package tree");
    }
    const projectRoot = pluginNpmProjectRoot(npmRoot, blockedPlugin);
    try {
      const rootManifest = await readJson<{
        dependencies?: Record<string, string>;
        openclaw?: { managedPeerDependencies?: string[] };
      }>(path.join(projectRoot, "package.json"));
      expect(rootManifest.dependencies?.[blockedPlugin]).toBeUndefined();
      expect(rootManifest.dependencies?.[runtimePeer]).toBeUndefined();
      expect(rootManifest.openclaw?.managedPeerDependencies ?? []).not.toContain(runtimePeer);
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
    await expect(
      fs.lstat(path.join(projectRoot, "node_modules", blockedPlugin, "package.json")),
    ).rejects.toHaveProperty("code", "ENOENT");
    await expect(
      fs.lstat(path.join(projectRoot, "node_modules", runtimePeer, "package.json")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });

  it("falls back to the legacy npm peer mode inside the plugin project when npm cannot plan third-party peers", async () => {
    const { rootDir, npmRoot } = await makeInstallFixture("npm-plugin-peer-plan-fallback-e2e");
    const blockedPlugin = uniquePackageName("missing-peer-plugin");
    const missingPeer = uniquePackageName("missing-peer");
    await useStaticRegistry(
      await registryPackages(rootDir, [
        {
          packageName: blockedPlugin,
          peerDependencies: { [missingPeer]: "^1.0.0" },
          peerDependenciesMeta: {},
        },
      ]),
    );

    const result = await installNpmPlugin({
      spec: `${blockedPlugin}@1.0.0`,
      npmRoot,
    });

    expect(result.ok).toBe(true);
    const projectRoot = pluginNpmProjectRoot(npmRoot, blockedPlugin);
    const rootManifest = await readJson<{
      dependencies?: Record<string, string>;
      openclaw?: { managedPeerDependencies?: string[] };
    }>(path.join(projectRoot, "package.json"));
    expect(rootManifest.dependencies?.[blockedPlugin]).toBe("1.0.0");
    expect(rootManifest.dependencies?.[missingPeer]).toBeUndefined();
    expect(rootManifest.openclaw?.managedPeerDependencies ?? []).not.toContain(missingPeer);
    await expect(
      fs.lstat(path.join(projectRoot, "node_modules", blockedPlugin, "package.json")),
    ).resolves.toBeTruthy();
  });

  it("does not take ownership of an existing root dependency observed as a peer", async () => {
    const { rootDir, npmRoot } = await makeInstallFixture("npm-plugin-peer-existing-root-e2e");
    const policyExec = await createInstalledPackageTreePolicyExec(rootDir);
    const existingRootDependency = uniquePackageName("existing-root");
    const blockedPlugin = uniquePackageName("blocked-plugin");
    const runtimePeer = uniquePackageName("runtime-peer");
    await useStaticRegistry(
      await registryPackages(rootDir, [
        { packageName: existingRootDependency },
        {
          indexJs: "eval('1');\n",
          packageName: blockedPlugin,
          peerDependencies: {
            [existingRootDependency]: "^1.0.0",
            [runtimePeer]: "^1.0.0",
          },
          peerDependenciesMeta: {},
        },
        { packageName: runtimePeer },
      ]),
    );

    const blockedProjectRoot = pluginNpmProjectRoot(npmRoot, blockedPlugin);
    await installProjectDependencies(blockedProjectRoot, {
      [existingRootDependency]: "1.0.0",
    });

    const result = await installNpmPlugin({
      config: configWithInstalledPackageTreeBlockPolicy(policyExec),
      spec: `${blockedPlugin}@1.0.0`,
      npmRoot,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED);
      expect(result.error).toContain("Install blocked by policy");
      expect(result.error).toContain("Reason: blocked installed package tree");
    }
    const rootManifest = await readJson<{
      dependencies?: Record<string, string>;
      openclaw?: { managedPeerDependencies?: string[] };
    }>(path.join(blockedProjectRoot, "package.json"));
    expect(rootManifest.dependencies?.[existingRootDependency]).toBe("1.0.0");
    expect(rootManifest.dependencies?.[blockedPlugin]).toBeUndefined();
    expect(rootManifest.dependencies?.[runtimePeer]).toBeUndefined();
    expect(rootManifest.openclaw?.managedPeerDependencies ?? []).not.toContain(
      existingRootDependency,
    );
    expect(rootManifest.openclaw?.managedPeerDependencies ?? []).not.toContain(runtimePeer);
    await expect(
      fs.lstat(
        path.join(blockedProjectRoot, "node_modules", existingRootDependency, "package.json"),
      ),
    ).resolves.toBeTruthy();
    await expect(
      fs.lstat(path.join(blockedProjectRoot, "node_modules", blockedPlugin, "package.json")),
    ).rejects.toHaveProperty("code", "ENOENT");
    await expect(
      fs.lstat(path.join(blockedProjectRoot, "node_modules", runtimePeer, "package.json")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });

  it("scrubs host peers inside each isolated npm project", async () => {
    const { rootDir, npmRoot } = await makeInstallFixture("npm-plugin-sibling-peer-e2e");
    const codexName = uniquePackageName("codex-peer-plugin");
    const opikName = uniquePackageName("opik-peer-plugin");
    await useStaticRegistry(
      await registryPackages(rootDir, [
        {
          packageName: codexName,
          peerDependencies: { openclaw: ">=2026.5.5-beta.2" },
          peerDependenciesMeta: { openclaw: { optional: true } },
        },
        {
          packageName: opikName,
          peerDependencies: { openclaw: ">=2026.3.2" },
          peerDependenciesMeta: {},
        },
        {
          packageName: "openclaw",
          pluginId: "registry-openclaw-copy",
          version: "2026.5.4",
        },
      ]),
    );

    const first = await installNpmPlugin({
      spec: `${codexName}@1.0.0`,
      npmRoot,
    });
    if (!first.ok) {
      throw new Error(first.error);
    }

    const second = await installNpmPlugin({
      spec: `${opikName}@1.0.0`,
      npmRoot,
    });
    if (!second.ok) {
      throw new Error(second.error);
    }

    const codexProjectRoot = pluginNpmProjectRoot(npmRoot, codexName);
    const opikProjectRoot = pluginNpmProjectRoot(npmRoot, opikName);
    for (const projectRoot of [codexProjectRoot, opikProjectRoot]) {
      const lock = await readJson<{
        packages?: Record<string, unknown>;
      }>(path.join(projectRoot, "package-lock.json"));
      expect(lock.packages?.["node_modules/openclaw"]).toBeUndefined();
      await expect(
        fs.lstat(path.join(projectRoot, "node_modules", "openclaw")),
      ).rejects.toHaveProperty("code", "ENOENT");
    }
    await expect(
      fs
        .lstat(path.join(first.targetDir, "node_modules", "openclaw"))
        .then((stat) => stat.isSymbolicLink()),
    ).resolves.toBe(true);
    await expect(
      fs
        .lstat(path.join(second.targetDir, "node_modules", "openclaw"))
        .then((stat) => stat.isSymbolicLink()),
    ).resolves.toBe(true);
  });

  it("keeps an earlier isolated openclaw peer link after later plugin installs", async () => {
    const { rootDir, npmRoot } = await makeInstallFixture("npm-plugin-peer-e2e");
    const peerPackageName = uniquePackageName("peer-plugin");
    const laterPackageName = uniquePackageName("later-plugin");
    await useStaticRegistry(
      await registryPackages(rootDir, [
        {
          packageName: peerPackageName,
          peerDependencies: { openclaw: ">=2026.0.0" },
        },
        { packageName: laterPackageName },
      ]),
    );

    const first = await installNpmPlugin({
      spec: `${peerPackageName}@1.0.0`,
      npmRoot,
    });
    if (!first.ok) {
      throw new Error(first.error);
    }
    const peerLink = path.join(first.targetDir, "node_modules", "openclaw");
    await expect(fs.lstat(peerLink).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);

    const second = await installNpmPlugin({
      spec: `${laterPackageName}@1.0.0`,
      npmRoot,
    });
    if (!second.ok) {
      throw new Error(second.error);
    }

    await expect(fs.lstat(peerLink).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);
    const peerProjectRoot = pluginNpmProjectRoot(npmRoot, peerPackageName);
    const manifest = await readJson<{
      dependencies?: Record<string, string>;
    }>(path.join(peerProjectRoot, "package.json"));
    expect(manifest.dependencies?.openclaw).toBeUndefined();
    const lock = await readJson<{
      packages?: Record<string, unknown>;
    }>(path.join(peerProjectRoot, "package-lock.json"));
    expect(lock.packages?.["node_modules/openclaw"]).toBeUndefined();
  });

  it("pins a mutable npm tag to the version resolved before install", async () => {
    const { rootDir, npmRoot } = await makeInstallFixture("npm-plugin-e2e");
    const packageName = uniquePackageName("mutable-plugin");
    const versions = await packPlugins(rootDir, [
      { packageName, version: "1.0.0" },
      { packageName, version: "2.0.0" },
    ]);
    const registry = await startMutableRegistry(
      {
        packageName,
        initialLatest: "1.0.0",
        laterLatest: "2.0.0",
        versions,
      },
      servers,
    );
    useRegistry(registry);

    const result = await installNpmPlugin({
      spec: `${packageName}@latest`,
      npmRoot,
    });

    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.ok).toBe(true);
    expect(result.npmResolution?.version).toBe("1.0.0");

    const projectRoot = pluginNpmProjectRoot(npmRoot, packageName);
    const manifest = await readJson<{
      dependencies?: Record<string, string>;
    }>(path.join(projectRoot, "package.json"));
    expect(manifest.dependencies?.[packageName]).toBe("1.0.0");

    const installedManifest = await readJson<{ version?: string }>(
      path.join(result.targetDir, "package.json"),
    );
    expect(installedManifest.version).toBe("1.0.0");

    const lock = await readJson<{
      packages?: Record<string, { integrity?: string; version?: string }>;
    }>(path.join(projectRoot, "package-lock.json"));
    const installedLockEntry = lock.packages?.[`node_modules/${packageName}`];
    expect(installedLockEntry?.integrity).toBe(versions[0]?.integrity);
    expect(installedLockEntry?.version).toBe("1.0.0");
  });

  it("rejects a trusted pin when a real registry omits dist.integrity", async () => {
    const { rootDir, npmRoot } = await makeInstallFixture("missing-registry-integrity-e2e");
    const packageName = uniquePackageName("missing-registry-integrity-plugin");
    await useStaticRegistry(
      await registryPackages(rootDir, [{ packageName, omitIntegrity: true }]),
    );

    const result = await installNpmPlugin({
      spec: `${packageName}@1.0.0`,
      expectedIntegrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
      npmRoot,
    });

    expect(result).toEqual({
      ok: false,
      error: `aborted: npm package integrity missing for ${packageName}@1.0.0`,
    });
    await expect(fs.access(pluginNpmProjectRoot(npmRoot, packageName))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });
});
