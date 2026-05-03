import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const [portFile, ...packageArgs] = process.argv.slice(2);

if (!portFile || packageArgs.length === 0 || packageArgs.length % 3 !== 0) {
  console.error(
    "usage: npm-registry-server.mjs <port-file> <package-name> <version> <tarball-path> [...]",
  );
  process.exit(1);
}

const packages = new Map();
for (let index = 0; index < packageArgs.length; index += 3) {
  const packageName = packageArgs[index];
  const version = packageArgs[index + 1];
  const tarballPath = packageArgs[index + 2];
  const archive = fs.readFileSync(tarballPath);
  const existing = packages.get(packageName) ?? {
    encodedPackageName: encodeURIComponent(packageName).replace("%40", "@"),
    packageName,
    latestVersion: version,
    versions: new Map(),
  };
  existing.latestVersion = version;
  existing.versions.set(version, {
    archive,
    dependencies: packageName === "@openclaw/demo-plugin-npm" ? { "is-number": "7.0.0" } : {},
    integrity: `sha512-${crypto.createHash("sha512").update(archive).digest("base64")}`,
    shasum: crypto.createHash("sha1").update(archive).digest("hex"),
    tarballName: path.basename(tarballPath),
    version,
  });
  packages.set(packageName, existing);
}

const metadataFor = (entry, baseUrl) => ({
  name: entry.packageName,
  "dist-tags": { latest: entry.latestVersion },
  versions: Object.fromEntries(
    [...entry.versions.entries()].map(([version, versionEntry]) => [
      version,
      {
        dependencies: versionEntry.dependencies,
        name: entry.packageName,
        version,
        dist: {
          integrity: versionEntry.integrity,
          shasum: versionEntry.shasum,
          tarball: `${baseUrl}/${entry.encodedPackageName}/-/${versionEntry.tarballName}`,
        },
      },
    ]),
  ),
});

function findPackageForPath(pathname) {
  return packages.get(decodeURIComponent(pathname.slice(1)));
}

function findTarballForPath(pathname) {
  for (const entry of packages.values()) {
    const prefix = `/${entry.encodedPackageName}/-/`;
    if (!pathname.toLowerCase().startsWith(prefix.toLowerCase())) {
      continue;
    }
    for (const versionEntry of entry.versions.values()) {
      if (pathname.endsWith(`/${versionEntry.tarballName}`)) {
        return versionEntry;
      }
    }
  }
  return undefined;
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  if (request.method !== "GET") {
    response.writeHead(405, { "content-type": "text/plain" });
    response.end("method not allowed");
    return;
  }

  const packageEntry = findPackageForPath(url.pathname);
  if (packageEntry) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`${JSON.stringify(metadataFor(packageEntry, baseUrl))}\n`);
    return;
  }

  const tarballEntry = findTarballForPath(url.pathname);
  if (tarballEntry) {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(tarballEntry.archive.length),
    });
    response.end(tarballEntry.archive);
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end(`not found: ${url.pathname}`);
});

server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
