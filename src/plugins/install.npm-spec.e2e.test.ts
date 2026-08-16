// Exercises npm-spec plugin install behavior through the CLI path.
import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginNpmProjectDir } from "./install-paths.js";
import { installPluginFromNpmSpec, PLUGIN_INSTALL_ERROR_CODE } from "./install.js";

type PackedVersion = {
  archive: Buffer;
  dependencies?: Record<string, string>;
  integrity: string;
  openclaw?: Record<string, unknown>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  shasum: string;
  tarballName: string;
  version: string;
};

type PackPluginParams = {
  dependencies?: Record<string, string>;
  indexJs?: string;
  openclaw?: Record<string, unknown>;
  optionalDependencies?: Record<string, string>;
  packageName: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  pluginId?: string;
  rootDir: string;
  version?: string;
};

type RegistryPackage = {
  latest: string;
  packageName: string;
  versions: PackedVersion[];
};

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

const installedPackageTreePolicySource = `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  if (request.sourcePathKind === "directory") {
    process.stdout.write(JSON.stringify({
      protocolVersion: 1,
      decision: "block",
      reason: "blocked installed package tree",
    }));
    return;
  }
  process.stdout.write(JSON.stringify({ protocolVersion: 1, decision: "allow" }));
});
`;

async function createInstalledPackageTreePolicyExec(rootDir: string) {
  if (process.platform === "win32") {
    return { command: process.execPath, args: ["-e", installedPackageTreePolicySource] };
  }
  const command = path.join(rootDir, "install-policy.cjs");
  await fs.writeFile(command, `#!${process.execPath}\n${installedPackageTreePolicySource}`, "utf8");
  await fs.chmod(command, 0o700);
  return { command, args: [] };
}

function configWithInstalledPackageTreeBlockPolicy(exec: {
  command: string;
  args: string[];
}): OpenClawConfig {
  return {
    security: {
      installPolicy: {
        enabled: true,
        exec: {
          source: "exec",
          command: exec.command,
          args: exec.args,
          timeoutMs: 5000,
          maxOutputBytes: 16 * 1024,
        },
      },
    },
  };
}

function pluginNpmProjectRoot(npmRoot: string, packageName: string): string {
  return resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
}

async function packPlugin(params: PackPluginParams): Promise<PackedVersion> {
  const version = params.version ?? "1.0.0";
  const packageDir = path.join(params.rootDir, `package-${params.packageName}-${version}`);
  const peerDependenciesMeta = params.peerDependencies
    ? (params.peerDependenciesMeta ??
      Object.fromEntries(
        Object.keys(params.peerDependencies).map((name) => [name, { optional: true }]),
      ))
    : undefined;
  await fs.mkdir(path.join(packageDir, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        name: params.packageName,
        version,
        type: "module",
        openclaw: params.openclaw ?? { extensions: ["./dist/index.js"] },
        ...(params.dependencies ? { dependencies: params.dependencies } : {}),
        ...(params.optionalDependencies
          ? { optionalDependencies: params.optionalDependencies }
          : {}),
        ...(params.peerDependencies
          ? {
              peerDependencies: params.peerDependencies,
              ...(peerDependenciesMeta ? { peerDependenciesMeta } : {}),
            }
          : {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(packageDir, "openclaw.plugin.json"),
    `${JSON.stringify(
      {
        id: params.pluginId ?? params.packageName,
        name: params.pluginId ?? params.packageName,
        configSchema: { type: "object" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(packageDir, "dist", "index.js"),
    params.indexJs ?? "export {};\n",
    "utf8",
  );

  const packOutput = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", params.rootDir],
    { cwd: packageDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const parsed = JSON.parse(packOutput) as Array<{ filename: string }>;
  const tarballName = parsed[0]?.filename;
  if (!tarballName) {
    throw new Error(`npm pack did not return a tarball for ${params.packageName}`);
  }
  const archive = await fs.readFile(path.join(params.rootDir, tarballName));
  return {
    archive,
    ...(params.dependencies ? { dependencies: params.dependencies } : {}),
    integrity: `sha512-${crypto.createHash("sha512").update(archive).digest("base64")}`,
    ...(params.openclaw ? { openclaw: params.openclaw } : {}),
    ...(params.optionalDependencies ? { optionalDependencies: params.optionalDependencies } : {}),
    ...(params.peerDependencies ? { peerDependencies: params.peerDependencies } : {}),
    ...(peerDependenciesMeta ? { peerDependenciesMeta } : {}),
    shasum: crypto.createHash("sha1").update(archive).digest("hex"),
    tarballName,
    version,
  };
}

async function registryPackage(
  params: PackPluginParams & { latest?: string },
): Promise<RegistryPackage> {
  const version = params.version ?? "1.0.0";
  return {
    packageName: params.packageName,
    latest: params.latest ?? version,
    versions: [await packPlugin({ ...params, version })],
  };
}

async function startStaticRegistry(packages: RegistryPackage[]): Promise<string> {
  const packageEntries = packages.map((pkg) => ({
    ...pkg,
    encodedPackageName: encodeURIComponent(pkg.packageName).replace("%40", "@"),
    versionsByVersion: new Map(pkg.versions.map((entry) => [entry.version, entry])),
  }));
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "text/plain" });
      response.end("method not allowed");
      return;
    }

    for (const pkg of packageEntries) {
      if (url.pathname === `/${pkg.encodedPackageName}`) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          `${JSON.stringify({
            name: pkg.packageName,
            "dist-tags": { latest: pkg.latest },
            versions: Object.fromEntries(
              [...pkg.versionsByVersion.entries()].map(([version, entry]) => [
                version,
                {
                  name: pkg.packageName,
                  version,
                  ...(entry.openclaw ? { openclaw: entry.openclaw } : {}),
                  ...(entry.dependencies ? { dependencies: entry.dependencies } : {}),
                  ...(entry.optionalDependencies
                    ? { optionalDependencies: entry.optionalDependencies }
                    : {}),
                  ...(entry.peerDependencies ? { peerDependencies: entry.peerDependencies } : {}),
                  ...(entry.peerDependenciesMeta
                    ? { peerDependenciesMeta: entry.peerDependenciesMeta }
                    : {}),
                  dist: {
                    integrity: entry.integrity,
                    shasum: entry.shasum,
                    tarball: `${baseUrl}/${pkg.encodedPackageName}/-/${entry.tarballName}`,
                  },
                },
              ]),
            ),
          })}\n`,
        );
        return;
      }

      const tarballPrefix = `/${pkg.encodedPackageName}/-/`;
      if (url.pathname.startsWith(tarballPrefix)) {
        const entry = [...pkg.versionsByVersion.values()].find((candidate) =>
          url.pathname.endsWith(`/${candidate.tarballName}`),
        );
        if (entry) {
          response.writeHead(200, {
            "content-length": String(entry.archive.length),
            "content-type": "application/octet-stream",
          });
          response.end(entry.archive);
          return;
        }
      }
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end(`not found: ${url.pathname}`);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function useStaticRegistry(packages: RegistryPackage[]): Promise<string> {
  const registry = await startStaticRegistry(packages);
  useRegistry(registry);
  return registry;
}

function useRegistry(registry: string): void {
  process.env.NPM_CONFIG_REGISTRY = registry;
  process.env.npm_config_registry = registry;
}

async function installNpmPlugin(params: {
  config?: OpenClawConfig;
  npmRoot: string;
  spec: string;
}) {
  return await installPluginFromNpmSpec({
    ...(params.config ? { config: params.config } : {}),
    spec: params.spec,
    npmDir: params.npmRoot,
    logger: { info: () => {}, warn: () => {} },
    timeoutMs: 120_000,
  });
}

async function installProjectDependencies(
  projectRoot: string,
  dependencies: Record<string, string>,
): Promise<void> {
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "package.json"),
    `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`,
    "utf8",
  );
  await execFileAsync(
    "npm",
    [
      "install",
      "--omit=dev",
      "--omit=peer",
      "--legacy-peer-deps",
      "--loglevel=error",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: projectRoot },
  );
}

async function startMutableRegistry(params: {
  packageName: string;
  initialLatest: string;
  laterLatest: string;
  versions: PackedVersion[];
}): Promise<string> {
  let latestVersion = params.initialLatest;
  let metadataRequests = 0;
  const versions = new Map(params.versions.map((entry) => [entry.version, entry]));
  const encodedPackageName = encodeURIComponent(params.packageName).replace("%40", "@");

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "text/plain" });
      response.end("method not allowed");
      return;
    }

    if (url.pathname === `/${encodedPackageName}`) {
      metadataRequests += 1;
      const metadataLatest = latestVersion;
      if (metadataRequests === 1) {
        latestVersion = params.laterLatest;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        `${JSON.stringify({
          name: params.packageName,
          "dist-tags": { latest: metadataLatest },
          versions: Object.fromEntries(
            [...versions.entries()].map(([version, entry]) => [
              version,
              {
                name: params.packageName,
                version,
                ...(entry.openclaw ? { openclaw: entry.openclaw } : {}),
                ...(entry.peerDependencies ? { peerDependencies: entry.peerDependencies } : {}),
                ...(entry.peerDependenciesMeta
                  ? { peerDependenciesMeta: entry.peerDependenciesMeta }
                  : {}),
                dist: {
                  integrity: entry.integrity,
                  shasum: entry.shasum,
                  tarball: `${baseUrl}/${encodedPackageName}/-/${entry.tarballName}`,
                },
              },
            ]),
          ),
        })}\n`,
      );
      return;
    }

    const tarballPrefix = `/${encodedPackageName}/-/`;
    if (url.pathname.startsWith(tarballPrefix)) {
      const entry = [...versions.values()].find((candidate) =>
        url.pathname.endsWith(`/${candidate.tarballName}`),
      );
      if (entry) {
        response.writeHead(200, {
          "content-length": String(entry.archive.length),
          "content-type": "application/octet-stream",
        });
        response.end(entry.archive);
        return;
      }
    }

    response.writeHead(404, { "content-type": "text/plain" });
    response.end(`not found: ${url.pathname}`);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("installPluginFromNpmSpec e2e", () => {
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
    const versions = [
      await packPlugin({
        packageName,
        version: "2026.5.26",
        rootDir,
        openclaw: compatibleOpenClaw,
      }),
      await packPlugin({
        packageName,
        version: "2026.5.27",
        rootDir,
        openclaw: incompatibleOpenClaw,
      }),
    ];
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
    const registry = await useStaticRegistry([
      await registryPackage({
        packageName,
        peerDependencies: { openclaw: ">=2026.0.0" },
        peerDependenciesMeta: {},
        rootDir,
      }),
      await registryPackage({
        packageName: "openclaw",
        pluginId: "registry-openclaw-copy",
        version: "2026.0.0",
        rootDir,
      }),
    ]);

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
    await useStaticRegistry([
      await registryPackage({
        packageName: pluginWithRuntimePeer,
        peerDependencies: { [runtimePeer]: "^1.0.0" },
        peerDependenciesMeta: {},
        rootDir,
      }),
      await registryPackage({ packageName: laterPlugin, rootDir }),
      await registryPackage({ packageName: runtimePeer, rootDir }),
    ]);

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
    await useStaticRegistry([
      await registryPackage({
        packageName: pluginWithOptionalDependency,
        optionalDependencies: { [optionalDependency]: "1.0.0" },
        rootDir,
      }),
      await registryPackage({
        packageName: optionalDependency,
        peerDependencies: { [runtimePeer]: "^1.0.0" },
        peerDependenciesMeta: {},
        rootDir,
      }),
      await registryPackage({ packageName: runtimePeer, rootDir }),
    ]);

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
    await useStaticRegistry([
      await registryPackage({
        packageName: pluginWithRuntimePeer,
        peerDependencies: { [runtimePeer]: "^1.0.0" },
        peerDependenciesMeta: {},
        rootDir,
      }),
      await registryPackage({ packageName: laterPlugin, rootDir }),
      await registryPackage({ indexJs: "eval('1');\n", packageName: runtimePeer, rootDir }),
    ]);

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
    await useStaticRegistry([
      await registryPackage({ packageName: existingPlugin, rootDir }),
      await registryPackage({ packageName: laterPlugin, rootDir }),
    ]);

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
    await useStaticRegistry([
      await registryPackage({
        indexJs: "eval('1');\n",
        packageName: blockedPlugin,
        peerDependencies: { [runtimePeer]: "^1.0.0" },
        peerDependenciesMeta: {},
        rootDir,
      }),
      await registryPackage({ packageName: runtimePeer, rootDir }),
    ]);

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
    await useStaticRegistry([
      await registryPackage({
        packageName: blockedPlugin,
        peerDependencies: { [missingPeer]: "^1.0.0" },
        peerDependenciesMeta: {},
        rootDir,
      }),
    ]);

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
    await useStaticRegistry([
      await registryPackage({ packageName: existingRootDependency, rootDir }),
      await registryPackage({
        indexJs: "eval('1');\n",
        packageName: blockedPlugin,
        peerDependencies: {
          [existingRootDependency]: "^1.0.0",
          [runtimePeer]: "^1.0.0",
        },
        peerDependenciesMeta: {},
        rootDir,
      }),
      await registryPackage({ packageName: runtimePeer, rootDir }),
    ]);

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
    await useStaticRegistry([
      await registryPackage({
        packageName: codexName,
        peerDependencies: { openclaw: ">=2026.5.5-beta.2" },
        peerDependenciesMeta: { openclaw: { optional: true } },
        rootDir,
      }),
      await registryPackage({
        packageName: opikName,
        peerDependencies: { openclaw: ">=2026.3.2" },
        peerDependenciesMeta: {},
        rootDir,
      }),
      await registryPackage({
        packageName: "openclaw",
        pluginId: "registry-openclaw-copy",
        version: "2026.5.4",
        rootDir,
      }),
    ]);

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
    await useStaticRegistry([
      await registryPackage({
        packageName: peerPackageName,
        peerDependencies: { openclaw: ">=2026.0.0" },
        rootDir,
      }),
      await registryPackage({ packageName: laterPackageName, rootDir }),
    ]);

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
    const versions = [
      await packPlugin({ packageName, version: "1.0.0", rootDir }),
      await packPlugin({ packageName, version: "2.0.0", rootDir }),
    ];
    const registry = await startMutableRegistry({
      packageName,
      initialLatest: "1.0.0",
      laterLatest: "2.0.0",
      versions,
    });
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
});
