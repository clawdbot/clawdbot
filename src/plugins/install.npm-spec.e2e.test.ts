import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installPluginFromNpmSpec } from "./install.js";

type PackedVersion = {
  archive: Buffer;
  integrity: string;
  shasum: string;
  tarballName: string;
  version: string;
};

const tempDirs: string[] = [];
const servers: http.Server[] = [];
const envKeys = ["NPM_CONFIG_REGISTRY", "npm_config_registry"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

async function packPlugin(params: {
  packageName: string;
  pluginId: string;
  version: string;
  rootDir: string;
}): Promise<PackedVersion> {
  const packageDir = path.join(params.rootDir, `package-${params.version}`);
  await fs.mkdir(path.join(packageDir, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        name: params.packageName,
        version: params.version,
        type: "module",
        openclaw: { extensions: ["./dist/index.js"] },
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
  await fs.writeFile(path.join(packageDir, "dist", "index.js"), "export {};\n", "utf8");

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
    integrity: `sha512-${crypto.createHash("sha512").update(archive).digest("base64")}`,
    shasum: crypto.createHash("sha1").update(archive).digest("hex"),
    tarballName,
    version: params.version,
  };
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

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe("installPluginFromNpmSpec e2e", () => {
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

    const manifest = JSON.parse(await fs.readFile(path.join(npmRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.[packageName]).toBe("1.0.0");

    const installedManifest = JSON.parse(
      await fs.readFile(path.join(result.targetDir, "package.json"), "utf8"),
    ) as { version?: string };
    expect(installedManifest.version).toBe("1.0.0");

    const lock = JSON.parse(await fs.readFile(path.join(npmRoot, "package-lock.json"), "utf8")) as {
      packages?: Record<string, { integrity?: string; version?: string }>;
    };
    expect(lock.packages?.[`node_modules/${packageName}`]).toMatchObject({
      integrity: versions[0]?.integrity,
      version: "1.0.0",
    });
  });
});
