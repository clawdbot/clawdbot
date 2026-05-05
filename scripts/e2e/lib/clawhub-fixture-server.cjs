const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");

const profile = process.argv[2];
const portFile = process.argv[3];
const requireFromApp = createRequire(path.join(process.cwd(), "package.json"));
const JSZip = requireFromApp("jszip");
const tar = requireFromApp("tar");
const packageName = "@openclaw/kitchen-sink";
const pluginId = "openclaw-kitchen-sink-fixture";

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
    api.on("before_agent_start", async (event, context) => ({
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

const fixture = profiles[profile];
if (!fixture || !portFile) {
  console.error("usage: clawhub-fixture-server.cjs <kitchen-sink-plugin|plugins> <port-file>");
  process.exit(1);
}

async function main() {
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

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method !== "GET") {
      response.writeHead(405);
      response.end("method not allowed");
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
