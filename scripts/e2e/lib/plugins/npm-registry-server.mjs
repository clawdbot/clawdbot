import { execFileSync } from "node:child_process";
// Fixture npm registry server for plugin E2E scenarios.
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  createBoundedResponseTooLargeError,
  readBoundedResponseBytes,
} from "../../../lib/bounded-response.mjs";

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

const upstreamRegistry = normalizeUpstreamRegistry(
  process.env.OPENCLAW_NPM_REGISTRY_UPSTREAM || process.env.OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL,
);
const upstreamMergeMode = process.env.OPENCLAW_NPM_REGISTRY_MERGE_UPSTREAM;
const mergeUpstream = upstreamMergeMode === "1" || upstreamMergeMode === "versions";
const distTagOverrides = new Map(
  (process.env.OPENCLAW_NPM_REGISTRY_DIST_TAGS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 0 || separator === entry.length - 1) {
        throw new Error(
          "OPENCLAW_NPM_REGISTRY_DIST_TAGS must contain comma-separated tag=version entries",
        );
      }
      return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
    }),
);
// Match other E2E package-download budgets while keeping public-registry hops
// inside the install deadline and decoded bodies inside a fixed memory budget.
const UPSTREAM_REQUEST_TIMEOUT_MS = 120_000;
const UPSTREAM_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
const UPSTREAM_TARBALL_MAX_BYTES = 512 * 1024 * 1024;

if (!portFile || packageArgs.length === 0 || packageArgs.length % 3 !== 0) {
  console.error(
    "usage: npm-registry-server.mjs <port-file> <package-name> <version> <tarball-path> [...]",
  );
  process.exit(1);
}

const packages = new Map();

function readPackageManifest(tarballPath, packageName) {
  try {
    // GNU tar treats Windows drive letters as remote archive hosts. Keep the
    // archive argument local, as in the prerelease artifact validator.
    const packageJson = JSON.parse(
      execFileSync("tar", ["-xOf", path.basename(tarballPath), "package/package.json"], {
        cwd: path.dirname(tarballPath),
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
  "dist-tags": {
    latest: entry.latestVersion,
    ...Object.fromEntries(distTagOverrides),
  },
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

function metadataForProxy(metadata, baseUrl) {
  if (
    !metadata?.versions ||
    typeof metadata.versions !== "object" ||
    Array.isArray(metadata.versions)
  ) {
    return metadata;
  }
  const prefix = `${upstreamRegistry}/`;
  return {
    ...metadata,
    versions: Object.fromEntries(
      Object.entries(metadata.versions).map(([version, manifest]) => {
        const tarball = manifest?.dist?.tarball;
        if (typeof tarball !== "string" || !tarball.startsWith(prefix)) {
          return [version, manifest];
        }
        // npm 12 requires registry tarballs to share its origin, including port.
        // Project each response separately; cached upstream metadata stays unchanged.
        return [
          version,
          {
            ...manifest,
            dist: { ...manifest.dist, tarball: `${baseUrl}/${tarball.slice(prefix.length)}` },
          },
        ];
      }),
    ),
  };
}

// Baseline roots can request older core dependencies through this candidate
// registry. Keep published versions available while exact candidate bytes win.
const upstreamMetadata = new Map();
async function metadataWithPublishedVersions(entry, baseUrl) {
  const local = metadataFor(entry, baseUrl);
  if (!mergeUpstream || !upstreamRegistry) {
    return local;
  }
  if (!upstreamMetadata.has(entry.packageName)) {
    upstreamMetadata.set(
      entry.packageName,
      (async () => {
        const response = await fetch(`${upstreamRegistry}/${entry.encodedPackageName}`, {
          redirect: "error",
          signal: AbortSignal.timeout(UPSTREAM_REQUEST_TIMEOUT_MS),
        });
        if (response.status === 404) {
          await response.body?.cancel();
          return {};
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`upstream package metadata returned ${response.status}`);
        }
        const bytes = await readBoundedResponseBytes(
          response,
          "npm registry upstream",
          UPSTREAM_RESPONSE_MAX_BYTES,
        );
        const published = JSON.parse(bytes.toString("utf8"));
        if (
          !published?.versions ||
          typeof published.versions !== "object" ||
          Array.isArray(published.versions)
        ) {
          throw new Error("upstream package metadata has no versions object");
        }
        return published;
      })().catch((/** @type {unknown} */ error) => {
        upstreamMetadata.delete(entry.packageName);
        throw error;
      }),
    );
  }
  const published = metadataForProxy(await upstreamMetadata.get(entry.packageName), baseUrl);
  // Baseline installs keep published tags; candidate installs select each local
  // package's release while retaining published versions for older dependencies.
  const distTags =
    upstreamMergeMode === "versions"
      ? { ...published["dist-tags"], ...local["dist-tags"] }
      : { ...local["dist-tags"], ...published["dist-tags"] };
  return {
    ...published,
    ...local,
    "dist-tags": {
      ...distTags,
      ...Object.fromEntries(distTagOverrides),
    },
    versions: { ...published.versions, ...local.versions },
  };
}

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

async function proxyUpstream(rawRequestUrl, response, baseUrl) {
  if (!upstreamRegistry) {
    return false;
  }
  try {
    const upstreamUrl = resolveUpstreamRequestUrl(rawRequestUrl);
    const upstreamResponse = await fetch(upstreamUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_REQUEST_TIMEOUT_MS),
    });
    const requestUrl = new URL(rawRequestUrl || "/", "http://127.0.0.1");
    if (requestUrl.pathname.includes("/-/")) {
      await streamUpstreamTarball(upstreamResponse, response);
      return true;
    }
    let body = await readBoundedResponseBytes(
      upstreamResponse,
      "npm registry upstream",
      UPSTREAM_RESPONSE_MAX_BYTES,
      { createTooLargeError: createBoundedResponseTooLargeError },
    );
    if (upstreamResponse.ok && upstreamResponse.headers.get("content-type")?.includes("json")) {
      const metadata = JSON.parse(body.toString("utf8"));
      body = Buffer.from(JSON.stringify(metadataForProxy(metadata, baseUrl)));
    }
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
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
      return true;
    }
    response.writeHead(502, { "content-type": "text/plain" });
    response.end(`upstream registry request failed: ${String(error)}`);
  }
  return true;
}

async function streamUpstreamTarball(upstreamResponse, response) {
  const declaredLength = Number(upstreamResponse.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > UPSTREAM_TARBALL_MAX_BYTES) {
    throw new Error(`npm registry upstream tarball exceeded ${UPSTREAM_TARBALL_MAX_BYTES} bytes`);
  }
  const headers = {};
  for (const name of ["content-type", "location"]) {
    const value = upstreamResponse.headers.get(name);
    if (value) {
      headers[name] = value;
    }
  }
  response.writeHead(upstreamResponse.status, headers);
  if (!upstreamResponse.body) {
    response.end();
    return;
  }
  let streamedBytes = 0;
  for await (const chunk of upstreamResponse.body) {
    const bytes = Buffer.from(chunk);
    streamedBytes += bytes.length;
    if (streamedBytes > UPSTREAM_TARBALL_MAX_BYTES) {
      response.destroy(
        new Error(`npm registry upstream tarball exceeded ${UPSTREAM_TARBALL_MAX_BYTES} bytes`),
      );
      return;
    }
    if (!response.write(bytes)) {
      await once(response, "drain");
    }
  }
  response.end();
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
    const metadata = await metadataWithPublishedVersions(packageEntry, baseUrl);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`${JSON.stringify(metadata)}\n`);
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

  if (await proxyUpstream(request.url, response, baseUrl)) {
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
  // Callers use file existence as readiness; publish only the complete port.
  const tempFile = `${portFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempFile, String(server.address().port));
    fs.renameSync(tempFile, portFile);
  } finally {
    fs.rmSync(tempFile, { force: true });
  }
});
