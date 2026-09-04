import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { x as extractTar } from "tar";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import { ProtocolSchemas } from "../../../../packages/gateway-protocol/src/schema/protocol-schemas.js";
import { coerceErrorMessage as formatErrorMessage } from "../../../../scripts/lib/error-format.mts";
import {
  assertProtocolSchemaDocument,
  buildProtocolSchemaDocument,
  type ProtocolSchemaDocument,
  REQUIRED_PROTOCOL_DEFINITIONS,
} from "../../../../scripts/lib/protocol-schema-document.mts";
import { listCoreGatewayMethodMetadata } from "../../../../src/gateway/methods/core-descriptors.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SOURCE_PATH = "test/e2e/qa-lab/runtime/gateway-protocol-artifacts.ts";

type ProducerOptions = {
  artifactBase: string;
  repoRoot: string;
};

type ProtocolArtifactSummary = {
  consumer: {
    installed: boolean;
    packageSpecifier: string;
    schemaSpecifier: string;
  };
  definitions: string[];
  package: {
    name: string;
    sha256: string;
    tarball: string;
    version: string;
  };
  validators: {
    connect: boolean;
    request: boolean;
  };
};

type InstalledProtocolInspection = {
  schemas: Record<string, unknown>;
  validators: {
    connect: {
      errors: unknown[] | null;
      valid: boolean;
    };
    request: {
      errors: unknown[] | null;
      valid: boolean;
    };
  };
};

export function buildInstalledProtocolInspectionScript() {
  return `import fs from "node:fs/promises";
import {
  validateConnectParams,
  validateRequestFrame,
} from "@openclaw/gateway-protocol";
import { ProtocolSchemas } from "@openclaw/gateway-protocol/schema";

const requestValid = validateRequestFrame({
  type: "req",
  id: "artifact-request",
  method: "health",
});
const connectValid = validateConnectParams({
  minProtocol: 4,
  maxProtocol: 4,
  client: {
    id: "test",
    version: "artifact-proof",
    platform: process.platform,
    mode: "test",
  },
});
await fs.writeFile(
  process.argv[2],
  JSON.stringify({
    schemas: ProtocolSchemas,
    validators: {
      connect: {
        errors: validateConnectParams.errors,
        valid: connectValid,
      },
      request: {
        errors: validateRequestFrame.errors,
        valid: requestValid,
      },
    },
  }),
  "utf8",
);
`;
}

export function buildSwiftProtocolCompatibilityHarness() {
  return `import Foundation

enum GatewayProtocolArtifactError: Error {
    case unexpected(String)
}

@main
struct GatewayProtocolArtifactHarness {
    static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    static func main() throws {
        let request = try decode(
            GatewayFrame.self,
            #"{"type":"req","id":"old-req","method":"health"}"#)
        let additiveRequest = try decode(
            GatewayFrame.self,
            #"{"type":"req","id":"new-req","method":"health","traceparent":"00-0123456789abcdef0123456789abcdef-0123456789abcdef-01","futureField":true}"#)
        let response = try decode(
            GatewayFrame.self,
            #"{"type":"res","id":"old-req","ok":true}"#)
        let additiveResponse = try decode(
            GatewayFrame.self,
            #"{"type":"res","id":"new-req","ok":true,"payload":{"healthy":true},"futureField":true}"#)
        let event = try decode(
            GatewayFrame.self,
            #"{"type":"event","event":"tick"}"#)
        let additiveEvent = try decode(
            GatewayFrame.self,
            #"{"type":"event","event":"tick","payload":{"ts":1},"seq":2,"futureField":true}"#)
        let legacyConnect = try decode(
            ConnectParams.self,
            #"{"minProtocol":4,"maxProtocol":4,"client":{"id":"test","version":"old","platform":"ios","mode":"test"}}"#)
        let additiveConnect = try decode(
            ConnectParams.self,
            #"{"minProtocol":4,"maxProtocol":4,"client":{"id":"test","version":"new","platform":"ios","mode":"test","futureClientField":true},"role":"operator","scopes":["operator.read"],"locale":"en-US","futureField":true}"#)

        guard case let .req(oldRequest) = request,
              case let .req(newRequest) = additiveRequest,
              case let .res(oldResponse) = response,
              case let .res(newResponse) = additiveResponse,
              case let .event(oldEvent) = event,
              case let .event(newEvent) = additiveEvent
        else {
            throw GatewayProtocolArtifactError.unexpected("frame discriminator")
        }
        guard oldRequest.params == nil,
              oldRequest.traceparent == nil,
              newRequest.traceparent == "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
              oldResponse.payload == nil,
              newResponse.payload != nil,
              oldEvent.seq == nil,
              newEvent.seq == 2,
              legacyConnect.role == nil,
              legacyConnect.scopes == nil,
              legacyConnect.locale == nil,
              additiveConnect.role == "operator",
              additiveConnect.scopes == ["operator.read"],
              additiveConnect.locale == "en-US"
        else {
            throw GatewayProtocolArtifactError.unexpected("legacy or additive decode")
        }
        print("gateway Swift generated-model compatibility passed")
    }
}
`;
}

export function buildPortableSwiftAnyCodableSource(source: string) {
  return source.includes("import CoreFoundation") ? source : `import CoreFoundation\n${source}`;
}

export function parseGatewayProtocolArtifactOptions(
  args: readonly string[],
  cwd = process.cwd(),
): ProducerOptions {
  let artifactBase: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option !== "--artifact-base") {
      throw new Error(`unknown argument: ${option}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error("--artifact-base requires a value");
    }
    if (artifactBase) {
      throw new Error("--artifact-base was provided more than once");
    }
    artifactBase = value;
    index += 1;
  }
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return {
    artifactBase: path.resolve(cwd, artifactBase),
    repoRoot: path.resolve(cwd),
  };
}

export function assertPublishedProtocolSchema(params: {
  builtSchemas: Record<string, unknown>;
  canonical: ProtocolSchemaDocument;
  published: ProtocolSchemaDocument;
}) {
  assert.deepEqual(
    params.builtSchemas,
    params.canonical.definitions,
    "built package schema registry differs from the canonical TypeBox registry",
  );
  assert.deepEqual(
    params.published,
    params.canonical,
    "published protocol.schema.json differs from the canonical TypeBox registry",
  );
  assertProtocolSchemaDocument(params.published);
}

async function runCommand(params: {
  args: string[];
  appendLog: (chunk: unknown) => void;
  command: string;
  cwd: string;
}) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      params.appendLog(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      params.appendLog(chunk);
    });
    child.on("exit", (code, signal) => {
      if (code === 0 && !signal) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${params.command} ${params.args.join(" ")} failed: code=${String(code)} signal=${String(signal)}`,
        ),
      );
    });
  });
}

async function withPreservedPackageOutputs<T>(repoRoot: string, run: () => Promise<T>): Promise<T> {
  const packageRoot = path.join(repoRoot, "packages", "gateway-protocol");
  const targets = [path.join(packageRoot, "dist"), path.join(packageRoot, "protocol.schema.json")];
  const backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-protocol-pack-"));
  const backups: Array<{ backup: string; target: string }> = [];
  try {
    for (const [index, target] of targets.entries()) {
      try {
        await fs.access(target);
      } catch {
        continue;
      }
      const backup = path.join(backupRoot, String(index));
      await fs.rename(target, backup);
      backups.push({ backup, target });
    }
    return await run();
  } finally {
    for (const target of targets) {
      await fs.rm(target, { force: true, recursive: true });
    }
    for (const { backup, target } of backups) {
      await fs.rename(backup, target);
    }
    await fs.rm(backupRoot, { force: true, recursive: true });
  }
}

async function sha256(filePath: string) {
  const contents = await fs.readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

async function packAndInspectProtocol(params: {
  appendLog: (chunk: unknown) => void;
  artifactBase: string;
  repoRoot: string;
}): Promise<ProtocolArtifactSummary> {
  const packageRoot = path.join(params.repoRoot, "packages", "gateway-protocol");
  const packDir = path.join(params.artifactBase, "package");
  const extractDir = path.join(params.artifactBase, "unpacked");
  await fs.rm(packDir, { force: true, recursive: true });
  await fs.rm(extractDir, { force: true, recursive: true });
  await fs.mkdir(packDir, { recursive: true });
  await fs.mkdir(extractDir, { recursive: true });

  await withPreservedPackageOutputs(params.repoRoot, async () => {
    await runCommand({
      args: ["--dir", packageRoot, "pack", "--pack-destination", packDir],
      appendLog: params.appendLog,
      command: "pnpm",
      cwd: params.repoRoot,
    });
  });

  const tarballs = (await fs.readdir(packDir)).filter((entry) => entry.endsWith(".tgz"));
  assert.equal(
    tarballs.length,
    1,
    `expected one packed protocol tarball, found ${tarballs.length}`,
  );
  const tarball = tarballs[0]!;
  const tarballPath = path.join(packDir, tarball);
  await extractTar({ cwd: extractDir, file: tarballPath });

  const unpackedRoot = path.join(extractDir, "package");
  const packageJson = JSON.parse(
    await fs.readFile(path.join(unpackedRoot, "package.json"), "utf8"),
  ) as { name?: string; version?: string };
  assert.equal(packageJson.name, "@openclaw/gateway-protocol");
  assert.ok(packageJson.version, "packed protocol package version is missing");

  const published = JSON.parse(
    await fs.readFile(path.join(unpackedRoot, "protocol.schema.json"), "utf8"),
  ) as ProtocolSchemaDocument;
  const consumerRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-gateway-protocol-consumer-"),
  );
  const consumerInspectionPath = path.join(consumerRoot, "inspection.json");
  const inspection = await (async () => {
    try {
      await fs.writeFile(
        path.join(consumerRoot, "package.json"),
        `${JSON.stringify({
          name: "openclaw-gateway-protocol-artifact-consumer",
          private: true,
          type: "module",
        })}\n`,
        "utf8",
      );
      await fs.writeFile(
        path.join(consumerRoot, "inspect.mjs"),
        buildInstalledProtocolInspectionScript(),
        "utf8",
      );
      await runCommand({
        args: ["--dir", consumerRoot, "add", "--ignore-scripts", "--lockfile=false", tarballPath],
        appendLog: params.appendLog,
        command: "pnpm",
        cwd: params.repoRoot,
      });
      await runCommand({
        args: ["inspect.mjs", consumerInspectionPath],
        appendLog: params.appendLog,
        command: "node",
        cwd: consumerRoot,
      });
      return JSON.parse(
        await fs.readFile(consumerInspectionPath, "utf8"),
      ) as InstalledProtocolInspection;
    } finally {
      await fs.rm(consumerRoot, { force: true, recursive: true });
    }
  })();
  const canonical = buildProtocolSchemaDocument({
    methods: listCoreGatewayMethodMetadata(),
    schemas: ProtocolSchemas,
  });
  assertPublishedProtocolSchema({
    builtSchemas: inspection.schemas,
    canonical,
    published,
  });

  assert.ok(
    inspection.validators.request.valid,
    `installed request validator rejected a minimal frame: ${JSON.stringify(inspection.validators.request.errors)}`,
  );
  assert.ok(
    inspection.validators.connect.valid,
    `installed connect validator rejected a minimal payload: ${JSON.stringify(inspection.validators.connect.errors)}`,
  );

  return {
    consumer: {
      installed: true,
      packageSpecifier: "@openclaw/gateway-protocol",
      schemaSpecifier: "@openclaw/gateway-protocol/schema",
    },
    definitions: REQUIRED_PROTOCOL_DEFINITIONS.filter((definition) =>
      Object.hasOwn(published.definitions, definition),
    ),
    package: {
      name: packageJson.name,
      sha256: await sha256(tarballPath),
      tarball,
      version: packageJson.version,
    },
    validators: {
      connect: inspection.validators.connect.valid,
      request: inspection.validators.request.valid,
    },
  };
}

async function compileAndRunSwiftProtocolModels(params: {
  appendLog: (chunk: unknown) => void;
  artifactBase: string;
  repoRoot: string;
}) {
  const swiftArtifactDir = path.join(params.artifactBase, "swift");
  const anyCodablePath = path.join(swiftArtifactDir, "AnyCodable.swift");
  const harnessPath = path.join(swiftArtifactDir, "GatewayProtocolArtifactHarness.swift");
  const executablePath = path.join(swiftArtifactDir, "gateway-protocol-artifact-harness");
  await fs.rm(swiftArtifactDir, { force: true, recursive: true });
  await fs.mkdir(swiftArtifactDir, { recursive: true });
  const anyCodableSource = await fs.readFile(
    path.join(params.repoRoot, "apps/shared/OpenClawKit/Sources/OpenClawProtocol/AnyCodable.swift"),
    "utf8",
  );
  // Linux Foundation does not re-export the CoreFoundation type-ID helpers.
  await fs.writeFile(anyCodablePath, buildPortableSwiftAnyCodableSource(anyCodableSource), "utf8");
  await fs.writeFile(harnessPath, buildSwiftProtocolCompatibilityHarness(), "utf8");
  await runCommand({
    args: [
      anyCodablePath,
      path.join(
        params.repoRoot,
        "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift",
      ),
      harnessPath,
      "-o",
      executablePath,
    ],
    appendLog: params.appendLog,
    command: "swiftc",
    cwd: params.repoRoot,
  });
  await runCommand({
    args: [],
    appendLog: params.appendLog,
    command: executablePath,
    cwd: params.repoRoot,
  });
}

async function runGatewayProtocolArtifactsProducer(
  options: ProducerOptions,
): Promise<QaEvidenceSummaryJson> {
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "gateway-protocol-artifacts.log",
    primaryModel: "gateway/protocol-artifacts",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      codeRefs: [
        SOURCE_PATH,
        "packages/gateway-protocol/package.json",
        "packages/gateway-protocol/src/schema/protocol-schemas.ts",
        "scripts/protocol-gen.ts",
        "scripts/protocol-gen-swift.ts",
        "apps/shared/OpenClawKit/Tests/OpenClawKitTests/GatewayProtocolGeneratedModelsTests.swift",
      ],
      docsRefs: ["docs/gateway/protocol.md", "docs/reference/test.md"],
      id: "gateway-protocol-artifacts",
      sourcePath: SOURCE_PATH,
      title: "Gateway published protocol artifacts",
    },
  });
  const startedAt = Date.now();
  try {
    await runCommand({
      args: ["protocol:check"],
      appendLog: (line) => writer.appendLog(line),
      command: "pnpm",
      cwd: options.repoRoot,
    });
    const summary = await packAndInspectProtocol({
      appendLog: (line) => writer.appendLog(line),
      artifactBase: options.artifactBase,
      repoRoot: options.repoRoot,
    });
    await compileAndRunSwiftProtocolModels({
      appendLog: (line) => writer.appendLog(line),
      artifactBase: options.artifactBase,
      repoRoot: options.repoRoot,
    });
    const summaryPath = path.join(options.artifactBase, "protocol-artifact-summary.json");
    await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return await writer.write({
      artifacts: [
        { kind: "package", filePath: path.join("package", summary.package.tarball) },
        { kind: "schema", filePath: path.join("unpacked", "package", "protocol.schema.json") },
        { kind: "summary", filePath: "protocol-artifact-summary.json" },
      ],
      details: [
        `package=${summary.package.name}@${summary.package.version}`,
        `sha256=${summary.package.sha256}`,
        `consumer-install=${summary.consumer.installed ? "pass" : "fail"}`,
        `definitions=${summary.definitions.join(",")}`,
        "protocol-check=pass",
        "swift-generated-model-compile=pass",
        "swift-generated-model-decode=pass",
      ].join("; "),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = formatErrorMessage(error);
    writer.appendLog(`\nfail: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  }
}

async function main(argv: readonly string[]) {
  const evidence = await runGatewayProtocolArtifactsProducer(
    parseGatewayProtocolArtifactOptions(argv),
  );
  const status = evidence.entries[0]?.result.status;
  console.log(`Gateway protocol artifact evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Gateway protocol artifact status: ${status}`);
  return status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}
