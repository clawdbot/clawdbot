// Real npm package and loopback registry fixtures for plugin install tests.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { resolveNpmJsonEntries } from "../../infra/npm-registry-spec.js";
import type { Deferred } from "../../shared/deferred.js";

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
  hookName?: string;
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

export type RegistryPackage = {
  latest: string;
  packageName: string;
  versions: PackedVersion[];
};

export async function packPlugin(params: PackPluginParams): Promise<PackedVersion> {
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
        openclaw:
          params.openclaw ??
          (params.hookName
            ? { hooks: [`./hooks/${params.hookName}`] }
            : { extensions: ["./dist/index.js"] }),
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
  if (params.hookName) {
    const hookDir = path.join(packageDir, "hooks", params.hookName);
    await fs.mkdir(hookDir, { recursive: true });
    await fs.writeFile(
      path.join(hookDir, "HOOK.md"),
      `---\nname: ${params.hookName}\ndescription: Install cancellation fixture\nmetadata: {"openclaw":{"events":["command:new"]}}\n---\n`,
    );
    await fs.writeFile(path.join(hookDir, "handler.js"), "export default async () => {};\n");
  } else {
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
  }
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
  const parsed = resolveNpmJsonEntries(JSON.parse(packOutput)) as Array<{ filename: string }>;
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

export async function registryPackage(
  params: PackPluginParams & { latest?: string },
): Promise<RegistryPackage> {
  const version = params.version ?? "1.0.0";
  return {
    packageName: params.packageName,
    latest: params.latest ?? version,
    versions: [await packPlugin({ ...params, version })],
  };
}

export async function startStaticRegistry(
  packages: RegistryPackage[],
  servers: http.Server[],
  downloadBarrier?: { requested: Deferred; released: Deferred },
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
    if (downloadBarrier && url.pathname === "/-/test/authority-close") {
      void downloadBarrier.requested.promise.then(() => response.end("close"));
      return;
    }
    if (downloadBarrier && url.pathname === "/-/test/authority-closed") {
      downloadBarrier.released.resolve();
      response.end("closed");
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
          const sendArchive = () => {
            response.writeHead(200, {
              "content-length": String(entry.archive.length),
              "content-type": "application/octet-stream",
            });
            response.end(entry.archive);
          };
          if (downloadBarrier) {
            downloadBarrier.requested.resolve();
            void downloadBarrier.released.promise.then(sendArchive);
          } else {
            sendArchive();
          }
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

export async function startMutableRegistry(
  params: {
    packageName: string;
    initialLatest: string;
    laterLatest: string;
    versions: PackedVersion[];
  },
  servers: http.Server[],
): Promise<string> {
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
