import { execFileSync } from "node:child_process";
// Fixture npm registry server for plugin E2E scenarios.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const [portFile, ...packageArgs] = process.argv.slice(2);
function normalizeUpstreamRegistry(raw) {
  if (!raw) {
    return undefined;
  }
  const url = new URL(raw);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("OPENCLAW_NPM_REGISTRY_UPSTREAM must be an HTTP(S) origin");
  }
  return url.origin;
}

const upstreamRegistry = normalizeUpstreamRegistry(process.env.OPENCLAW_NPM_REGISTRY_UPSTREAM);

if (!portFile || packageArgs.length === 0 || packageArgs.length % 3 !== 0) {
  console.error(
    "usage: npm-registry-server.mjs <port-file> <package-name> <version> <tarball-path> [...]",
  );
  process.exit(1);
}

const packages = new Map();

function readPackageManifest(tarballPath, packageName) {
  try {
    const packageJson = JSON.parse(
      execFileSync("tar", ["-xOf", tarballPath, "package/package.json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
    return packageJson && typeof packageJson === "object" && !Array.isArray(packageJson)
      ? packageJson
      : {};
  } catch {
    return packageName === "@openclaw/demo-plugin-npm"
      ? { dependencies: { "is-number": "7.0.0" } }
      : {};
  }
}

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
    integrity: `sha512-${crypto.createHash("sha512").update(archive).digest("base64")}`,
    manifest: readPackageManifest(tarballPath, packageName),
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
        ...versionEntry.manifest,
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

function decodePackagePath(pathname) {
  try {
    return decodeURIComponent(pathname.slice(1));
  } catch {
    return undefined;
  }
}

function findPackageForPath(pathname) {
  const packageName = decodePackagePath(pathname);
  return packageName === undefined ? undefined : packages.get(packageName);
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

function resolveUpstreamRequestUrl(rawRequestUrl) {
  const raw = rawRequestUrl || "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    throw new Error(`refusing non-origin registry request URL: ${JSON.stringify(raw)}`);
  }
  const requestUrl = new URL(raw, "http://127.0.0.1");
  return `${upstreamRegistry}${requestUrl.pathname}${requestUrl.search}`;
}

async function proxyUpstream(rawRequestUrl, response) {
  if (!upstreamRegistry) {
    return false;
  }
  try {
    const upstreamUrl = resolveUpstreamRequestUrl(rawRequestUrl);
    const upstreamResponse = await fetch(upstreamUrl, { redirect: "manual" });
    const body = Buffer.from(await upstreamResponse.arrayBuffer());
    // Fetch decodes compressed bodies but preserves upstream length metadata.
    // Emit the decoded size so npm clients do not truncate proxied responses.
    const headers = { "content-length": String(body.length) };
    for (const name of ["content-type", "location"]) {
      const value = upstreamResponse.headers.get(name);
      if (value) {
        headers[name] = value;
      }
    }
    response.writeHead(upstreamResponse.status, headers);
    response.end(body);
  } catch (error) {
    response.writeHead(502, { "content-type": "text/plain" });
    response.end(`upstream registry request failed: ${String(error)}`);
  }
  return true;
}

async function handleRequest(request, response) {
  const fallbackHost = `127.0.0.1:${server.address().port}`;
  const requestHost = request.headers.host || fallbackHost;
  const url = new URL(request.url ?? "/", `http://${requestHost}`);
  const baseUrl = url.origin;
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

  if (await proxyUpstream(request.url, response)) {
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end(`not found: ${url.pathname}`);
}

const server = http.createServer((request, response) => {
  void handleRequest(request, response).catch((/** @type {unknown} */ error) => {
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(`registry request failed: ${String(error)}`);
      return;
    }
    response.destroy(error instanceof Error ? error : new Error(String(error)));
  });
});

const bindHost = process.env.OPENCLAW_NPM_REGISTRY_BIND_HOST || "127.0.0.1";
const requestedPort = Number(process.env.OPENCLAW_NPM_REGISTRY_PORT || 0);
server.listen(requestedPort, bindHost, () => {
  fs.writeFileSync(portFile, String(server.address().port));
});
