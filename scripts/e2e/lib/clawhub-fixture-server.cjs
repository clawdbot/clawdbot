// CommonJS fixture server for ClawHub package/install E2E scenarios.
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const profile = process.argv[2];
const portFile = process.argv[3];
const artifactManifestFile = process.argv[4];
const requireFromApp = createRequire(path.join(process.cwd(), "package.json"));
const packageName = "@openclaw/kitchen-sink";
const pluginId = "openclaw-kitchen-sink-fixture";

async function assertPrepublishRequests(
  baseUrl,
  requestedPackage,
  version,
  securityMode = "required",
) {
  if (!baseUrl || !requestedPackage || !version) {
    throw new Error("assert-prepublish-requests requires <base-url> <package-name> <version>");
  }
  if (securityMode !== "required" && securityMode !== "absent") {
    throw new Error("assert-prepublish-requests security mode must be required or absent");
  }
  const response = await fetch(new URL("/__fixture__/requests", baseUrl));
  if (!response.ok) {
    throw new Error(`ClawHub fixture request ledger returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload?.requests)) {
    throw new Error("ClawHub fixture request ledger must contain a requests array");
  }
  const packagePath = `/api/v1/packages/${encodeURIComponent(requestedPackage)}`;
  const versionPath = `${packagePath}/versions/${encodeURIComponent(version)}`;
  const expected = [
    `GET ${packagePath}`,
    `GET ${versionPath}/artifact`,
    ...(securityMode === "required" ? [`GET ${versionPath}/security`] : []),
    `GET ${versionPath}/artifact/download`,
  ];
  if (JSON.stringify(payload.requests) !== JSON.stringify(expected)) {
    throw new Error(`unexpected ClawHub fixture requests: ${JSON.stringify(payload.requests)}`);
  }
}

async function assertNoRequests(baseUrl) {
  if (!baseUrl) {
    throw new Error("assert-no-requests requires <base-url>");
  }
  const response = await fetch(new URL("/__fixture__/requests", baseUrl));
  if (!response.ok) {
    throw new Error(`ClawHub fixture request ledger returned HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload?.requests)) {
    throw new Error("ClawHub fixture request ledger must contain a requests array");
  }
  if (payload.requests.length !== 0) {
    throw new Error(`unexpected ClawHub fixture requests: ${JSON.stringify(payload.requests)}`);
  }
}

function startPrepublishArtifactServer() {
  const manifest = JSON.parse(fs.readFileSync(artifactManifestFile, "utf8"));
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) {
    throw new Error("prepublish artifact manifest must contain packages");
  }
  const artifacts = new Map(
    manifest.packages.map((entry) => {
      if (
        typeof entry.name !== "string" ||
        typeof entry.version !== "string" ||
        typeof entry.tarball !== "string" ||
        path.basename(entry.tarball) !== entry.tarball
      ) {
        throw new Error("invalid prepublish artifact manifest entry");
      }
      const tarballPath = path.join(path.dirname(artifactManifestFile), entry.tarball);
      const archive = fs.readFileSync(tarballPath);
      const sha256 = crypto.createHash("sha256").update(archive).digest("hex");
      const packedPackage = JSON.parse(
        execFileSync("tar", ["-xOf", tarballPath, "package/package.json"], {
          encoding: "utf8",
        }),
      );
      const packedPlugin = JSON.parse(
        execFileSync("tar", ["-xOf", tarballPath, "package/openclaw.plugin.json"], {
          encoding: "utf8",
        }),
      );
      if (
        sha256 !== entry.sha256 ||
        packedPackage.name !== entry.name ||
        packedPackage.version !== entry.version ||
        typeof packedPlugin.id !== "string" ||
        packedPlugin.id.length === 0
      ) {
        throw new Error(`prepublish artifact metadata mismatch for ${entry.name}`);
      }
      return [
        entry.name,
        {
          ...entry,
          archive,
          runtimeId: packedPlugin.id,
          npmIntegrity: `sha512-${crypto.createHash("sha512").update(archive).digest("base64")}`,
          npmShasum: crypto.createHash("sha1").update(archive).digest("hex"),
        },
      ];
    }),
  );
  const requestLog = [];
  const json = (response, value, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(`${JSON.stringify(value)}\n`);
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture__/requests") {
      json(response, { requests: requestLog });
      return;
    }
    requestLog.push(`${request.method} ${url.pathname}${url.search}`);
    const match =
      /^\/api\/v1\/packages\/([^/]+)(?:\/versions\/([^/]+)(?:\/(artifact(?:\/download)?|security))?)?$/u.exec(
        url.pathname,
      );
    const entry = match ? artifacts.get(decodeURIComponent(match[1])) : undefined;
    if (request.method !== "GET" || !entry) {
      response.writeHead(request.method === "GET" ? 404 : 405);
      response.end(request.method === "GET" ? "not found" : "method not allowed");
      return;
    }
    const version = match[2] ? decodeURIComponent(match[2]) : undefined;
    if (version && version !== entry.version) {
      json(response, { error: "version not found" }, 404);
      return;
    }
    const packageRecord = {
      name: entry.name,
      family: "code-plugin",
      runtimeId: entry.runtimeId,
    };
    const artifact = {
      kind: "npm-pack",
      sha256: entry.sha256,
      npmIntegrity: entry.npmIntegrity,
      npmShasum: entry.npmShasum,
    };
    const versionRecord = {
      version: entry.version,
      artifact,
    };
    if (!version) {
      json(response, {
        package: {
          ...packageRecord,
          channel: "official",
          isOfficial: true,
          latestVersion: entry.version,
          tags: { latest: entry.version, beta: entry.version },
        },
      });
    } else if (!match[3]) {
      json(response, { package: packageRecord, version: versionRecord });
    } else if (match[3] === "security") {
      json(response, {
        package: {
          name: entry.name,
          displayName: entry.name,
          family: "code-plugin",
        },
        release: {
          releaseId: `fixture:${entry.name}@${entry.version}`,
          version: entry.version,
          artifactKind: "npm-pack",
          artifactSha256: entry.sha256,
          npmIntegrity: entry.npmIntegrity,
          npmShasum: entry.npmShasum,
          npmTarballName: entry.tarball,
          createdAt: 0,
        },
        overview: "No security concerns found in the fixture release.",
        securityAuditUrl: `http://${request.headers.host}${url.pathname}`,
        trust: {
          scanStatus: "clean",
          moderationState: null,
          blockedFromDownload: false,
          reasons: [],
          pending: false,
          stale: false,
        },
      });
    } else if (match[3] === "artifact") {
      json(response, {
        version: versionRecord,
        artifact: {
          artifactKind: "npm-pack",
          artifactSha256: entry.sha256,
          npmIntegrity: entry.npmIntegrity,
        },
      });
    } else {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "X-ClawHub-Artifact-Sha256": entry.sha256,
        "X-ClawHub-Npm-Integrity": entry.npmIntegrity,
        "X-ClawHub-Npm-Shasum": entry.npmShasum,
        "X-ClawHub-Npm-Tarball-Name": entry.tarball,
      });
      response.end(entry.archive);
    }
  });
  server.listen(0, "127.0.0.1", () => {
    fs.writeFileSync(portFile, String(server.address().port));
  });
}

const buildArtifactSummary = ({
  clawpackSha256,
  clawpackSize,
  npmIntegrity,
  npmShasum,
  npmTarballName,
}) => ({
  kind: "npm-pack",
  format: "tgz",
  sha256: clawpackSha256,
  size: clawpackSize,
  npmIntegrity,
  npmShasum,
  npmTarballName,
});

const buildClawPackSummary = ({
  clawpackSha256,
  clawpackSize,
  npmIntegrity,
  npmShasum,
  npmTarballName,
}) => ({
  available: true,
  format: "tgz",
  sha256: clawpackSha256,
  size: clawpackSize,
  npmIntegrity,
  npmShasum,
  npmTarballName,
});

async function buildNpmPackArtifact(fixture) {
  const tar = requireFromApp("tar");
  const packRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-clawhub-fixture-"));
  try {
    const packageDir = path.join(packRoot, "package");
    await fs.promises.mkdir(packageDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(packageDir, "package.json"),
      `${JSON.stringify(fixture.packageJson, null, 2)}\n`,
    );
    await fs.promises.writeFile(path.join(packageDir, "index.js"), fixture.indexJs);
    await fs.promises.writeFile(
      path.join(packageDir, "openclaw.plugin.json"),
      `${JSON.stringify(fixture.manifest, null, 2)}\n`,
    );
    const npmTarballName = `${packageName.replace(/^@/, "").replace("/", "-")}-${fixture.version}.tgz`;
    const archivePath = path.join(packRoot, npmTarballName);
    await tar.c(
      {
        cwd: packRoot,
        file: archivePath,
        gzip: true,
        portable: true,
        noMtime: true,
      },
      ["package"],
    );
    const archive = await fs.promises.readFile(archivePath);
    return {
      archive,
      clawpackSha256: crypto.createHash("sha256").update(archive).digest("hex"),
      clawpackSize: archive.length,
      npmIntegrity: `sha512-${crypto.createHash("sha512").update(archive).digest("base64")}`,
      npmShasum: crypto.createHash("sha1").update(archive).digest("hex"),
      npmTarballName,
    };
  } finally {
    await fs.promises.rm(packRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

const profiles = {
  "kitchen-sink-plugin": {
    version: "0.2.5",
    packageJson: {
      name: packageName,
      version: "0.2.5",
      type: "module",
      dependencies: {
        "is-number": "7.0.0",
      },
      peerDependencies: {
        openclaw: ">=2026.4.11",
      },
      peerDependenciesMeta: {
        openclaw: {
          optional: true,
        },
      },
      openclaw: { extensions: ["./index.js"] },
    },
    indexJs: `import isNumber from "is-number";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const dependencyUrl = import.meta.resolve("is-number");
const expectedDependencyBaseUrl = new URL("./node_modules/is-number/", import.meta.url).href;
if (!dependencyUrl.startsWith(expectedDependencyBaseUrl)) {
  throw new Error(\`kitchen-sink dependency resolved outside plugin root: \${dependencyUrl}\`);
}

export default definePluginEntry({
  id: "${pluginId}",
  name: "OpenClaw Kitchen Sink",
  register(api) {
    if (!isNumber(42)) {
      throw new Error("kitchen-sink dependency sentinel did not load");
    }
    api.registerProvider({
      id: "kitchen-sink-provider",
      label: "Kitchen Sink Provider",
      docsPath: "/providers/kitchen-sink",
      auth: [],
    });
    api.registerContextEngine("${pluginId}", () => ({
      info: {
        id: "${pluginId}",
        name: "Kitchen Sink Context Engine",
      },
      async ingest() {
        return { ingested: false };
      },
      async assemble(params) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      },
      async compact() {
        return {
          ok: true,
          compacted: false,
          reason: "kitchen-sink fixture does not compact",
        };
      },
    }));
    api.registerChannel({
      plugin: {
        id: "kitchen-sink-channel",
        meta: {
          id: "kitchen-sink-channel",
          label: "Kitchen Sink Channel",
          selectionLabel: "Kitchen Sink",
          docsPath: "/channels/kitchen-sink",
          blurb: "Kitchen sink ClawHub fixture channel",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ accountId: "default" }),
        },
        outbound: { deliveryMode: "direct" },
      },
    });
  },
});
`,
    manifest: {
      id: pluginId,
      name: "OpenClaw Kitchen Sink",
      kind: "context-engine",
      channels: ["kitchen-sink-channel"],
      channelConfigs: {
        "kitchen-sink-channel": {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean", default: true },
              token: { type: "string" },
            },
          },
          uiHints: {
            token: {
              sensitive: true,
            },
          },
          label: "Kitchen Sink",
          description:
            "Credential-free channel fixture for deterministic Kitchen Sink install tests.",
          commands: {
            nativeCommandsAutoEnabled: true,
            nativeSkillsAutoEnabled: true,
          },
        },
      },
      providers: ["kitchen-sink-provider"],
      contracts: {
        tools: ["kitchen-sink-tool"],
      },
      configSchema: {
        type: "object",
        properties: {},
      },
    },
    packageDetail(artifact) {
      const clawpack = buildClawPackSummary(artifact);
      const packageArtifact = buildArtifactSummary(artifact);
      const packageDetail = {
        package: {
          name: packageName,
          displayName: "OpenClaw Kitchen Sink",
          family: "code-plugin",
          runtimeId: pluginId,
          channel: "official",
          isOfficial: true,
          summary: "Kitchen sink plugin fixture for prerelease CI.",
          ownerHandle: "openclaw",
          createdAt: 0,
          updatedAt: 0,
          latestVersion: this.version,
          tags: { latest: this.version },
          capabilityTags: ["test-fixture"],
          executesCode: true,
          compatibility: {
            pluginApiRange: ">=2026.4.11",
            minGatewayVersion: "2026.4.11",
          },
          capabilities: {
            executesCode: true,
            runtimeId: pluginId,
            capabilityTags: ["test-fixture"],
            channels: ["kitchen-sink-channel"],
            providers: ["kitchen-sink-provider"],
          },
          verification: {
            tier: "source-linked",
            sourceRepo: "https://github.com/openclaw/kitchen-sink",
            hasProvenance: false,
            scanStatus: "passed",
          },
          artifact: packageArtifact,
          clawpack,
        },
      };
      return {
        packageDetail,
        versionDetail: {
          package: {
            name: packageName,
            displayName: "OpenClaw Kitchen Sink",
            family: "code-plugin",
          },
          version: {
            version: this.version,
            createdAt: 0,
            changelog: "Fixture package for kitchen-sink plugin prerelease CI.",
            distTags: ["latest"],
            sha256hash: artifact.sha256hash,
            compatibility: packageDetail.package.compatibility,
            capabilities: packageDetail.package.capabilities,
            verification: packageDetail.package.verification,
            artifact: packageArtifact,
            clawpack,
          },
        },
        betaStatus: 404,
      };
    },
  },
  plugins: {
    version: "0.1.0",
    packageJson: {
      name: packageName,
      version: "0.1.0",
      dependencies: {
        "is-number": "7.0.0",
      },
      peerDependencies: {
        openclaw: ">=2026.4.11",
      },
      peerDependenciesMeta: {
        openclaw: {
          optional: true,
        },
      },
      openclaw: { extensions: ["./index.js"] },
    },
    indexJs: `module.exports = {
  id: "${pluginId}",
  name: "OpenClaw Kitchen Sink",
  description: "Docker E2E kitchen-sink plugin fixture",
  register(api) {
    api.on("before_prompt_build", async (event, context) => ({
      kitchenSink: true,
      observedEventKeys: Object.keys(event || {}),
      observedContextKeys: Object.keys(context || {}),
    }));
    api.registerTool(() => null, { name: "kitchen_sink_tool" });
    api.registerGatewayMethod("kitchen-sink.ping", async () => ({ ok: true }));
    api.registerCli(() => {}, { commands: ["kitchen-sink"] });
    api.registerService({ id: "kitchen-sink-service", start: () => {} });
  },
};
`,
    manifest: {
      id: pluginId,
      contracts: {
        tools: ["kitchen-sink-tool", "kitchen_sink_tool"],
      },
      configSchema: {
        type: "object",
        properties: {},
      },
    },
    packageDetail(artifact) {
      const compatibility = {
        pluginApiRange: ">=2026.4.26",
        minGatewayVersion: "2026.4.26",
      };
      const clawpack = buildClawPackSummary(artifact);
      const packageArtifact = buildArtifactSummary(artifact);
      return {
        packageDetail: {
          package: {
            name: packageName,
            displayName: "OpenClaw Kitchen Sink",
            family: "code-plugin",
            channel: "official",
            isOfficial: true,
            runtimeId: pluginId,
            latestVersion: this.version,
            createdAt: 0,
            updatedAt: 0,
            compatibility,
            artifact: packageArtifact,
            clawpack,
          },
        },
        versionDetail: {
          version: {
            version: this.version,
            createdAt: 0,
            changelog: "Kitchen-sink fixture package for Docker plugin E2E.",
            sha256hash: artifact.sha256hash,
            compatibility,
            artifact: packageArtifact,
            clawpack,
          },
        },
      };
    },
  },
};

profiles["catalog-search"] = {
  ...profiles.plugins,
  catalogSearch: {
    packages: {
      "code-plugin": [
        {
          score: 4,
          package: {
            name: "@acme/calendar",
            displayName: "Calendar",
            family: "code-plugin",
            channel: "community",
            isOfficial: false,
            summary: "Calendar integration",
            createdAt: 1,
            updatedAt: 2,
            latestVersion: "1.2.3",
          },
        },
        {
          score: 8,
          package: {
            name: "@acme/calendar-code",
            displayName: "Calendar Code Plugin",
            family: "code-plugin",
            channel: "community",
            isOfficial: false,
            summary: "Code-only calendar integration",
            createdAt: 1,
            updatedAt: 2,
            latestVersion: "2.0.0",
          },
        },
      ],
      "bundle-plugin": [
        {
          score: 12,
          package: {
            name: "@acme/calendar",
            displayName: "Calendar Bundle",
            family: "bundle-plugin",
            channel: "official",
            isOfficial: true,
            summary: "Official calendar bundle",
            createdAt: 1,
            updatedAt: 3,
            latestVersion: "3.0.0",
          },
        },
        {
          score: 6,
          package: {
            name: "@acme/calendar-bundle",
            displayName: "Calendar Bundle Plugin",
            family: "bundle-plugin",
            channel: "community",
            isOfficial: false,
            summary: "Community calendar bundle",
            createdAt: 1,
            updatedAt: 2,
            latestVersion: "1.0.0",
          },
        },
      ],
    },
    skills: [
      {
        score: 99,
        source: "clawhub",
        slug: "calendar-skill",
        ownerHandle: "acme",
        displayName: "Calendar Skill",
        summary: "Skill-only calendar result",
        version: "4.0.0",
        updatedAt: 4,
      },
    ],
  },
};

if (profile === "assert-prepublish-requests") {
  assertPrepublishRequests(portFile, artifactManifestFile, process.argv[5], process.argv[6]).catch(
    /** @param {unknown} error */ (error) => {
      console.error(error);
      process.exit(1);
    },
  );
  return;
}

if (profile === "assert-no-requests") {
  assertNoRequests(portFile).catch(
    /** @param {unknown} error */ (error) => {
      console.error(error);
      process.exit(1);
    },
  );
  return;
}

const fixture = profiles[profile];
if (!fixture || !portFile) {
  if (profile === "prepublish-artifacts" && portFile && artifactManifestFile) {
    startPrepublishArtifactServer();
    return;
  }
  console.error(
    "usage: clawhub-fixture-server.cjs <catalog-search|kitchen-sink-plugin|plugins|prepublish-artifacts> <port-file> [manifest-file]",
  );
  process.exit(1);
}

async function main() {
  const JSZip = requireFromApp("jszip");
  const zip = new JSZip();
  zip.file("package/package.json", `${JSON.stringify(fixture.packageJson, null, 2)}\n`, {
    date: new Date(0),
  });
  zip.file("package/index.js", fixture.indexJs, { date: new Date(0) });
  const manifestJson = `${JSON.stringify(fixture.manifest, null, 2)}\n`;
  zip.file("package/openclaw.plugin.json", manifestJson, { date: new Date(0) });

  const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const sha256hash = crypto.createHash("sha256").update(archive).digest("hex");
  const clawpack = await buildNpmPackArtifact(fixture);
  const { packageDetail, versionDetail, betaStatus } = fixture.packageDetail({
    sha256hash,
    ...clawpack,
  });

  const json = (response, value, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(`${JSON.stringify(value)}\n`);
  };
  const artifactResolverDetail = {
    package: versionDetail.package ?? {
      name: packageName,
      displayName: packageDetail.package?.displayName ?? "OpenClaw Kitchen Sink",
      family: packageDetail.package?.family ?? "code-plugin",
    },
    version: versionDetail.version,
    artifact: {
      source: "clawhub",
      artifactKind: "npm-pack",
      packageName,
      version: fixture.version,
      artifactSha256: clawpack.clawpackSha256,
      npmIntegrity: clawpack.npmIntegrity,
      npmShasum: clawpack.npmShasum,
    },
  };
  const securityDetail = {
    package: artifactResolverDetail.package,
    release: {
      version: fixture.version,
    },
    trust: {
      scanStatus: "clean",
      moderationState: null,
      blockedFromDownload: false,
      reasons: [],
      pending: false,
      stale: false,
    },
  };
  const requestLog = [];

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method !== "GET") {
      response.writeHead(405);
      response.end("method not allowed");
      return;
    }
    if (url.pathname === "/__fixture__/requests") {
      json(response, { requests: requestLog });
      return;
    }
    requestLog.push(`${request.method} ${url.pathname}${url.search}`);
    if (fixture.catalogSearch && url.pathname === "/api/v1/packages/search") {
      if (url.searchParams.get("q") === "unavailable") {
        json(response, { error: "catalog unavailable" }, 503);
        return;
      }
      const family = url.searchParams.get("family");
      const results =
        url.searchParams.get("q") === "empty" ? [] : (fixture.catalogSearch.packages[family] ?? []);
      json(response, { results });
      return;
    }
    if (fixture.catalogSearch && url.pathname === "/api/v1/search") {
      const results = url.searchParams.get("q") === "empty" ? [] : fixture.catalogSearch.skills;
      json(response, { results });
      return;
    }
    if (url.pathname === `/api/v1/packages/${encodeURIComponent(packageName)}`) {
      json(response, packageDetail);
      return;
    }
    if (
      url.pathname ===
      `/api/v1/packages/${encodeURIComponent(packageName)}/versions/${fixture.version}`
    ) {
      json(response, versionDetail);
      return;
    }
    if (
      url.pathname ===
      `/api/v1/packages/${encodeURIComponent(packageName)}/versions/${fixture.version}/artifact`
    ) {
      json(response, artifactResolverDetail);
      return;
    }
    if (
      url.pathname ===
      `/api/v1/packages/${encodeURIComponent(packageName)}/versions/${fixture.version}/security`
    ) {
      json(response, securityDetail);
      return;
    }
    if (
      betaStatus !== undefined &&
      url.pathname === `/api/v1/packages/${encodeURIComponent(packageName)}/versions/beta`
    ) {
      json(response, { error: "version not found" }, betaStatus ?? 404);
      return;
    }
    if (url.pathname === `/api/v1/packages/${encodeURIComponent(packageName)}/download`) {
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(archive.length),
      });
      response.end(archive);
      return;
    }
    if (
      url.pathname ===
      `/api/v1/packages/${encodeURIComponent(packageName)}/versions/${fixture.version}/artifact/download`
    ) {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(clawpack.archive.length),
        "X-ClawHub-Artifact-Type": "npm-pack-tarball",
        "X-ClawHub-Artifact-Sha256": clawpack.clawpackSha256,
        "X-ClawHub-Npm-Integrity": clawpack.npmIntegrity,
        "X-ClawHub-Npm-Shasum": clawpack.npmShasum,
      });
      response.end(clawpack.archive);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end(`not found: ${url.pathname}`);
  });

  server.listen(0, "127.0.0.1", () => {
    fs.writeFileSync(portFile, String(server.address().port));
  });
}

main().catch(
  /** @param {unknown} error */ (error) => {
    console.error(error);
    process.exit(1);
  },
);
