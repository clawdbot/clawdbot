import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePluginNpmProjectDir } from "./install-paths.js";
import { installPluginFromNpmSpec } from "./install.js";

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

const tempDirs: string[] = [];
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
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function pluginNpmProjectRoot(npmRoot: string, packageName: string): string {
  return resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
}

async function packPlugin(params: {
  dependencies?: Record<string, string>;
  packageName: string;
  optionalDependencies?: Record<string, string>;
  openclaw?: Record<string, unknown>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  pluginId: string;
  version: string;
  rootDir: string;
  indexJs?: string;
}): Promise<PackedVersion> {
  const packageDir = path.join(params.rootDir, `package-${params.packageName}-${params.version}`);
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
        version: params.version,
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
        id: params.pluginId,
        name: params.pluginId,
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
    version: params.version,
  };
}

async function startStaticRegistry(
  packages: Array<{
    latest: string;
    packageName: string;
    versions: PackedVersion[];
  }>,
): Promise<string> {
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
    const rootDir = await makeTempDir("npm-plugin-compatible-version-e2e");
    const npmRoot = path.join(rootDir, "managed-npm");
    const packageName = `compatible-plugin-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
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
        pluginId: packageName,
        version: "2026.5.26",
        rootDir,
        openclaw: compatibleOpenClaw,
      }),
      await packPlugin({
        packageName,
        pluginId: packageName,
        version: "2026.5.27",
        rootDir,
        openclaw: incompatibleOpenClaw,
      }),
    ];
    const registry = await startStaticRegistry([{ packageName, latest: "2026.5.27", versions }]);
    process.env.NPM_CONFIG_REGISTRY = registry;
    process.env.npm_config_registry = registry;
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
      const installedPackageJson = JSON.parse(
        await fs.readFile(
          path.join(projectRoot, "node_modules", packageName, "package.json"),
          "utf8",
        ),
      ) as { version?: string };
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
    const rootDir = await makeTempDir("npm-plugin-required-peer-e2e");
    const npmRoot = path.join(rootDir, "managed-npm");
    const packageName = `required-peer-plugin-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const versions = [
      await packPlugin({
        packageName,
        peerDependencies: { openclaw: ">=2026.0.0" },
        peerDependenciesMeta: {},
        pluginId: packageName,
        version: "1.0.0",
        rootDir,
      }),
    ];
    const openClawVersions = [
      await packPlugin({
        packageName: "openclaw",
        pluginId: "registry-openclaw-copy",
        version: "2026.0.0",
        rootDir,
      }),
    ];
    const registry = await startStaticRegistry([
      { packageName, latest: "1.0.0", versions },
      { packageName: "openclaw", latest: "2026.0.0", versions: openClawVersions },
    ]);
    process.env.NPM_CONFIG_REGISTRY = registry;
    process.env.npm_config_registry = registry;

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
    const rawLock = JSON.parse(
      await fs.readFile(path.join(rawNpmRoot, "package-lock.json"), "utf8"),
    ) as {
      packages?: Record<string, unknown>;
    };
    const rawOpenClawLockEntry = rawLock.packages?.["node_modules/openclaw"] as
      | { peer?: unknown; version?: unknown }
      | undefined;
    expect(rawOpenClawLockEntry?.peer).toBe(true);
    expect(rawOpenClawLockEntry?.version).toBe("2026.0.0");

    const result = await installPluginFromNpmSpec({
      spec: `${packageName}@1.0.0`,
      npmDir: npmRoot,
      logger: { info: () => {}, warn: () => {} },
      timeoutMs: 120_000,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }

    const projectRoot = pluginNpmProjectRoot(npmRoot, packageName);
    const lock = JSON.parse(
      await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8"),
    ) as {
      packages?: Record<string, unknown>;
    };
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
    const rootDir = await makeTempDir("npm-plugin-third-party-peer-e2e");
    const npmRoot = path.join(rootDir, "managed-npm");
    const pluginWithRuntimePeer = `runtime-peer-plugin-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const laterPlugin = `later-plugin-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const runtimePeer = `runtime-peer-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const registry = await startStaticRegistry([
      {
        packageName: pluginWithRuntimePeer,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            packageName: pluginWithRuntimePeer,
            peerDependencies: { [runtimePeer]: "^1.0.0" },
            peerDependenciesMeta: {},
            pluginId: pluginWithRuntimePeer,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
      {
        packageName: laterPlugin,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            packageName: laterPlugin,
            pluginId: laterPlugin,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
      {
        packageName: runtimePeer,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            packageName: runtimePeer,
            pluginId: runtimePeer,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
    ]);
    process.env.NPM_CONFIG_REGISTRY = registry;
    process.env.npm_config_registry = registry;

    const first = await installPluginFromNpmSpec({
      spec: `${pluginWithRuntimePeer}@1.0.0`,
      npmDir: npmRoot,
      logger: { info: () => {}, warn: () => {} },
      timeoutMs: 120_000,
    });
    if (!first.ok) {
      throw new Error(first.error);
    }
    const firstProjectRoot = pluginNpmProjectRoot(npmRoot, pluginWithRuntimePeer);
    await expect(
      fs.lstat(path.join(firstProjectRoot, "node_modules", runtimePeer, "package.json")),
    ).resolves.toBeTruthy();

    const second = await installPluginFromNpmSpec({
      spec: `${laterPlugin}@1.0.0`,
      npmDir: npmRoot,
      logger: { info: () => {}, warn: () => {} },
      timeoutMs: 120_000,
    });
    if (!second.ok) {
      throw new Error(second.error);
    }

    await expect(
      fs.lstat(path.join(firstProjectRoot, "node_modules", runtimePeer, "package.json")),
    ).resolves.toBeTruthy();
  });

  it("plans peers from installed optional dependencies", async () => {
    const rootDir = await makeTempDir("npm-plugin-optional-peer-e2e");
    const npmRoot = path.join(rootDir, "managed-npm");
    const pluginWithOptionalDependency = `optional-owner-plugin-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const optionalDependency = `optional-dep-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const runtimePeer = `optional-peer-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const registry = await startStaticRegistry([
      {
        packageName: pluginWithOptionalDependency,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            packageName: pluginWithOptionalDependency,
            optionalDependencies: { [optionalDependency]: "1.0.0" },
            pluginId: pluginWithOptionalDependency,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
      {
        packageName: optionalDependency,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            packageName: optionalDependency,
            peerDependencies: { [runtimePeer]: "^1.0.0" },
            peerDependenciesMeta: {},
            pluginId: optionalDependency,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
      {
        packageName: runtimePeer,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            packageName: runtimePeer,
            pluginId: runtimePeer,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
    ]);
    process.env.NPM_CONFIG_REGISTRY = registry;
    process.env.npm_config_registry = registry;

    const result = await installPluginFromNpmSpec({
      spec: `${pluginWithOptionalDependency}@1.0.0`,
      npmDir: npmRoot,
      logger: { info: () => {}, warn: () => {} },
      timeoutMs: 120_000,
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
    const rootManifest = JSON.parse(
      await fs.readFile(path.join(projectRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      openclaw?: { managedPeerDependencies?: string[] };
    };
    expect(rootManifest.dependencies?.[runtimePeer]).toBe("1.0.0");
    expect(rootManifest.openclaw?.managedPeerDependencies ?? []).toContain(runtimePeer);
  });

  it("leaves legacy flat-root peer dependencies alone during isolated later installs", async () => {
    const rootDir = await makeTempDir("npm-plugin-repaired-peer-scan-e2e");
    const npmRoot = path.join(rootDir, "managed-npm");
    const pluginWithRuntimePeer = `existing-peer-plugin-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const laterPlugin = `later-plugin-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const runtimePeer = `runtime-peer-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const registry = await startStaticRegistry([
      {
        packageName: pluginWithRuntimePeer,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            packageName: pluginWithRuntimePeer,
            peerDependencies: { [runtimePeer]: "^1.0.0" },
            peerDependenciesMeta: {},
            pluginId: pluginWithRuntimePeer,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
      {
        packageName: laterPlugin,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            packageName: laterPlugin,
            pluginId: laterPlugin,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
      {
        packageName: runtimePeer,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            indexJs: "eval('1');\n",
            packageName: runtimePeer,
            pluginId: runtimePeer,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
    ]);
    process.env.NPM_CONFIG_REGISTRY = registry;
    process.env.npm_config_registry = registry;

    await fs.mkdir(npmRoot, { recursive: true });
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: { [pluginWithRuntimePeer]: "1.0.0" },
        },
        null,
        2,
      )}\n`,
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
      { cwd: npmRoot },
    );
    await expect(
      fs.lstat(path.join(npmRoot, "node_modules", runtimePeer, "package.json")),
    ).rejects.toHaveProperty("code", "ENOENT");

    const later = await installPluginFromNpmSpec({
      spec: `${laterPlugin}@1.0.0`,
      npmDir: npmRoot,
      logger: { info: () => {}, warn: () => {} },
      timeoutMs: 120_000,
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
    const rootManifest = JSON.parse(
      await fs.readFile(path.join(npmRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      openclaw?: { managedPeerDependencies?: string[] };
    };
    expect(rootManifest.dependencies?.[laterPlugin]).toBeUndefined();
    expect(rootManifest.dependencies?.[runtimePeer]).toBeUndefined();
    expect(rootManifest.openclaw?.managedPeerDependencies ?? []).not.toContain(runtimePeer);
  });

  it("ignores legacy flat-root package cycles during isolated installs", async () => {
    const rootDir = await makeTempDir("npm-plugin-peer-cycle-e2e");
    const npmRoot = path.join(rootDir, "managed-npm");
    const existingPlugin = `existing-plugin-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const laterPlugin = `later-plugin-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const registry = await startStaticRegistry([
      {
        packageName: existingPlugin,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            packageName: existingPlugin,
            pluginId: existingPlugin,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
      {
        packageName: laterPlugin,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            packageName: laterPlugin,
            pluginId: laterPlugin,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
    ]);
    process.env.NPM_CONFIG_REGISTRY = registry;
    process.env.npm_config_registry = registry;

    await fs.mkdir(npmRoot, { recursive: true });
    await fs.writeFile(
      path.join(npmRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: { [existingPlugin]: "1.0.0" },
        },
        null,
        2,
      )}\n`,
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
      { cwd: npmRoot },
    );
    const existingPluginDir = path.join(npmRoot, "node_modules", existingPlugin);
    await fs.mkdir(path.join(existingPluginDir, "node_modules"), { recursive: true });
    await fs.symlink(existingPluginDir, path.join(existingPluginDir, "node_modules", "self"));

    const later = await installPluginFromNpmSpec({
      spec: `${laterPlugin}@1.0.0`,
      npmDir: npmRoot,
      logger: { info: () => {}, warn: () => {} },
      timeoutMs: 120_000,
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

  it("rolls back managed peer dependencies added before a failed install scan", async () => {
    const rootDir = await makeTempDir("npm-plugin-peer-rollback-e2e");
    const npmRoot = path.join(rootDir, "managed-npm");
    const blockedPlugin = `blocked-plugin-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const runtimePeer = `runtime-peer-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const registry = await startStaticRegistry([
      {
        packageName: blockedPlugin,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            indexJs: "eval('1');\n",
            packageName: blockedPlugin,
            peerDependencies: { [runtimePeer]: "^1.0.0" },
            peerDependenciesMeta: {},
            pluginId: blockedPlugin,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
      {
        packageName: runtimePeer,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            packageName: runtimePeer,
            pluginId: runtimePeer,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
    ]);
    process.env.NPM_CONFIG_REGISTRY = registry;
    process.env.npm_config_registry = registry;

    const result = await installPluginFromNpmSpec({
      spec: `${blockedPlugin}@1.0.0`,
      npmDir: npmRoot,
      logger: { info: () => {}, warn: () => {} },
      timeoutMs: 120_000,
    });

    expect(result.ok).toBe(false);
    const projectRoot = pluginNpmProjectRoot(npmRoot, blockedPlugin);
    const rootManifest = JSON.parse(
      await fs.readFile(path.join(projectRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      openclaw?: { managedPeerDependencies?: string[] };
    };
    expect(rootManifest.dependencies?.[blockedPlugin]).toBeUndefined();
    expect(rootManifest.dependencies?.[runtimePeer]).toBeUndefined();
    expect(rootManifest.openclaw?.managedPeerDependencies ?? []).not.toContain(runtimePeer);
    await expect(
      fs.lstat(path.join(projectRoot, "node_modules", blockedPlugin, "package.json")),
    ).rejects.toHaveProperty("code", "ENOENT");
    await expect(
      fs.lstat(path.join(projectRoot, "node_modules", runtimePeer, "package.json")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });

  it("falls back to the legacy npm peer mode inside the plugin project when npm cannot plan third-party peers", async () => {
    const rootDir = await makeTempDir("npm-plugin-peer-plan-fallback-e2e");
    const npmRoot = path.join(rootDir, "managed-npm");
    const blockedPlugin = `missing-peer-plugin-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const missingPeer = `missing-peer-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const registry = await startStaticRegistry([
      {
        packageName: blockedPlugin,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            packageName: blockedPlugin,
            peerDependencies: { [missingPeer]: "^1.0.0" },
            peerDependenciesMeta: {},
            pluginId: blockedPlugin,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
    ]);
    process.env.NPM_CONFIG_REGISTRY = registry;
    process.env.npm_config_registry = registry;

    const result = await installPluginFromNpmSpec({
      spec: `${blockedPlugin}@1.0.0`,
      npmDir: npmRoot,
      logger: { info: () => {}, warn: () => {} },
      timeoutMs: 120_000,
    });

    expect(result.ok).toBe(true);
    const projectRoot = pluginNpmProjectRoot(npmRoot, blockedPlugin);
    const rootManifest = JSON.parse(
      await fs.readFile(path.join(projectRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      openclaw?: { managedPeerDependencies?: string[] };
    };
    expect(rootManifest.dependencies?.[blockedPlugin]).toBe("1.0.0");
    expect(rootManifest.dependencies?.[missingPeer]).toBeUndefined();
    expect(rootManifest.openclaw?.managedPeerDependencies ?? []).not.toContain(missingPeer);
    await expect(
      fs.lstat(path.join(projectRoot, "node_modules", blockedPlugin, "package.json")),
    ).resolves.toBeTruthy();
  });

  it("does not take ownership of an existing root dependency observed as a peer", async () => {
    const rootDir = await makeTempDir("npm-plugin-peer-existing-root-e2e");
    const npmRoot = path.join(rootDir, "managed-npm");
    const existingRootDependency = `existing-root-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const blockedPlugin = `blocked-plugin-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const runtimePeer = `runtime-peer-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const registry = await startStaticRegistry([
      {
        packageName: existingRootDependency,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            packageName: existingRootDependency,
            pluginId: existingRootDependency,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
      {
        packageName: blockedPlugin,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            indexJs: "eval('1');\n",
            packageName: blockedPlugin,
            peerDependencies: {
              [existingRootDependency]: "^1.0.0",
              [runtimePeer]: "^1.0.0",
            },
            peerDependenciesMeta: {},
            pluginId: blockedPlugin,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
      {
        packageName: runtimePeer,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            packageName: runtimePeer,
            pluginId: runtimePeer,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
    ]);
    process.env.NPM_CONFIG_REGISTRY = registry;
    process.env.npm_config_registry = registry;

    const blockedProjectRoot = pluginNpmProjectRoot(npmRoot, blockedPlugin);
    await fs.mkdir(blockedProjectRoot, { recursive: true });
    await fs.writeFile(
      path.join(blockedProjectRoot, "package.json"),
      `${JSON.stringify(
        {
          private: true,
          dependencies: { [existingRootDependency]: "1.0.0" },
        },
        null,
        2,
      )}\n`,
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
      { cwd: blockedProjectRoot },
    );

    const result = await installPluginFromNpmSpec({
      spec: `${blockedPlugin}@1.0.0`,
      npmDir: npmRoot,
      logger: { info: () => {}, warn: () => {} },
      timeoutMs: 120_000,
    });

    expect(result.ok).toBe(false);
    const rootManifest = JSON.parse(
      await fs.readFile(path.join(blockedProjectRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      openclaw?: { managedPeerDependencies?: string[] };
    };
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
    const rootDir = await makeTempDir("npm-plugin-sibling-peer-e2e");
    const npmRoot = path.join(rootDir, "managed-npm");
    const codexName = `codex-peer-plugin-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const opikName = `opik-peer-plugin-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const registry = await startStaticRegistry([
      {
        packageName: codexName,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            packageName: codexName,
            peerDependencies: { openclaw: ">=2026.5.5-beta.2" },
            peerDependenciesMeta: { openclaw: { optional: true } },
            pluginId: codexName,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
      {
        packageName: opikName,
        latest: "1.0.0",
        versions: [
          await packPlugin({
            packageName: opikName,
            peerDependencies: { openclaw: ">=2026.3.2" },
            peerDependenciesMeta: {},
            pluginId: opikName,
            version: "1.0.0",
            rootDir,
          }),
        ],
      },
      {
        packageName: "openclaw",
        latest: "2026.5.4",
        versions: [
          await packPlugin({
            packageName: "openclaw",
            pluginId: "registry-openclaw-copy",
            version: "2026.5.4",
            rootDir,
          }),
        ],
      },
    ]);
    process.env.NPM_CONFIG_REGISTRY = registry;
    process.env.npm_config_registry = registry;

    const first = await installPluginFromNpmSpec({
      spec: `${codexName}@1.0.0`,
      npmDir: npmRoot,
      logger: { info: () => {}, warn: () => {} },
      timeoutMs: 120_000,
    });
    if (!first.ok) {
      throw new Error(first.error);
    }

    const second = await installPluginFromNpmSpec({
      spec: `${opikName}@1.0.0`,
      npmDir: npmRoot,
      logger: { info: () => {}, warn: () => {} },
      timeoutMs: 120_000,
    });
    if (!second.ok) {
      throw new Error(second.error);
    }

    const codexProjectRoot = pluginNpmProjectRoot(npmRoot, codexName);
    const opikProjectRoot = pluginNpmProjectRoot(npmRoot, opikName);
    for (const projectRoot of [codexProjectRoot, opikProjectRoot]) {
      const lock = JSON.parse(
        await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8"),
      ) as {
        packages?: Record<string, unknown>;
      };
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
    const rootDir = await makeTempDir("npm-plugin-peer-e2e");
    const npmRoot = path.join(rootDir, "managed-npm");
    const peerPackageName = `peer-plugin-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const laterPackageName = `later-plugin-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const peerVersions = [
      await packPlugin({
        packageName: peerPackageName,
        peerDependencies: { openclaw: ">=2026.0.0" },
        pluginId: peerPackageName,
        version: "1.0.0",
        rootDir,
      }),
    ];
    const laterVersions = [
      await packPlugin({
        packageName: laterPackageName,
        pluginId: laterPackageName,
        version: "1.0.0",
        rootDir,
      }),
    ];
    const registry = await startStaticRegistry([
      { packageName: peerPackageName, latest: "1.0.0", versions: peerVersions },
      { packageName: laterPackageName, latest: "1.0.0", versions: laterVersions },
    ]);
    process.env.NPM_CONFIG_REGISTRY = registry;
    process.env.npm_config_registry = registry;

    const first = await installPluginFromNpmSpec({
      spec: `${peerPackageName}@1.0.0`,
      npmDir: npmRoot,
      logger: { info: () => {}, warn: () => {} },
      timeoutMs: 120_000,
    });
    if (!first.ok) {
      throw new Error(first.error);
    }
    const peerLink = path.join(first.targetDir, "node_modules", "openclaw");
    await expect(fs.lstat(peerLink).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);

    const second = await installPluginFromNpmSpec({
      spec: `${laterPackageName}@1.0.0`,
      npmDir: npmRoot,
      logger: { info: () => {}, warn: () => {} },
      timeoutMs: 120_000,
    });
    if (!second.ok) {
      throw new Error(second.error);
    }

    await expect(fs.lstat(peerLink).then((stat) => stat.isSymbolicLink())).resolves.toBe(true);
    const peerProjectRoot = pluginNpmProjectRoot(npmRoot, peerPackageName);
    const manifest = JSON.parse(
      await fs.readFile(path.join(peerProjectRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.openclaw).toBeUndefined();
    const lock = JSON.parse(
      await fs.readFile(path.join(peerProjectRoot, "package-lock.json"), "utf8"),
    ) as {
      packages?: Record<string, unknown>;
    };
    expect(lock.packages?.["node_modules/openclaw"]).toBeUndefined();
  });

  it("pins a mutable npm tag to the version resolved before install", async () => {
    const rootDir = await makeTempDir("npm-plugin-e2e");
    const npmRoot = path.join(rootDir, "managed-npm");
    const packageName = `mutable-plugin-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const pluginId = packageName;
    const versions = [
      await packPlugin({ packageName, pluginId, version: "1.0.0", rootDir }),
      await packPlugin({ packageName, pluginId, version: "2.0.0", rootDir }),
    ];
    const registry = await startMutableRegistry({
      packageName,
      initialLatest: "1.0.0",
      laterLatest: "2.0.0",
      versions,
    });
    process.env.NPM_CONFIG_REGISTRY = registry;
    process.env.npm_config_registry = registry;

    const result = await installPluginFromNpmSpec({
      spec: `${packageName}@latest`,
      npmDir: npmRoot,
      logger: { info: () => {}, warn: () => {} },
      timeoutMs: 120_000,
    });

    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.ok).toBe(true);
    expect(result.npmResolution?.version).toBe("1.0.0");

    const projectRoot = pluginNpmProjectRoot(npmRoot, packageName);
    const manifest = JSON.parse(
      await fs.readFile(path.join(projectRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.[packageName]).toBe("1.0.0");

    const installedManifest = JSON.parse(
      await fs.readFile(path.join(result.targetDir, "package.json"), "utf8"),
    ) as { version?: string };
    expect(installedManifest.version).toBe("1.0.0");

    const lock = JSON.parse(
      await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8"),
    ) as {
      packages?: Record<string, { integrity?: string; version?: string }>;
    };
    const installedLockEntry = lock.packages?.[`node_modules/${packageName}`];
    expect(installedLockEntry?.integrity).toBe(versions[0]?.integrity);
    expect(installedLockEntry?.version).toBe("1.0.0");
  });
});
