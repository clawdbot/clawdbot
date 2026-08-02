// Runs package-backed Docker artifact lanes and writes bounded QA evidence.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SOURCE_PATH = "test/e2e/qa-lab/runtime/docker-artifact-proof.ts";

const PROOFS = {
  "compose-setup": {
    title: "Docker Compose setup evidence",
  },
  "docker-package-install": {
    title: "Docker package install evidence",
  },
} as const;

type DockerArtifactProofLane = keyof typeof PROOFS;

type ProducerOptions = {
  artifactBase: string;
  lane: DockerArtifactProofLane;
  repoRoot: string;
};

type ArtifactIdentity = {
  containers: Array<{
    details: Record<string, string>;
    id: string;
    imageId: string;
    name: string;
    role: string;
    state: string;
  }>;
  image: { id: string; reference: string; repoDigests: string[] };
  package: { fileName: string; name: string; sha256: string; sizeBytes: number; version: string };
  scenarioId: string;
};

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isProofLane(value: string): value is DockerArtifactProofLane {
  return Object.hasOwn(PROOFS, value);
}

export function parseDockerArtifactProofOptions(args: string[]): ProducerOptions {
  let artifactBase: string | undefined;
  let lane: DockerArtifactProofLane | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    index += 1;
    if (option === "--artifact-base") {
      artifactBase = value;
    } else if (option === "--lane") {
      if (!isProofLane(value)) {
        throw new Error(`unsupported Docker artifact proof lane: ${value}`);
      }
      lane = value;
    } else {
      throw new Error(`unknown argument: ${option}`);
    }
  }
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  if (!lane) {
    throw new Error("--lane is required");
  }
  return { artifactBase: path.resolve(artifactBase), lane, repoRoot: process.cwd() };
}

function assertIdentity(identity: ArtifactIdentity, lane: DockerArtifactProofLane) {
  if (identity.scenarioId !== lane) {
    throw new Error(`identity scenario ${identity.scenarioId} does not match ${lane}`);
  }
  if (
    !identity.package.name ||
    !identity.package.version ||
    !/^[a-f0-9]{64}$/u.test(identity.package.sha256)
  ) {
    throw new Error("identity package metadata is incomplete");
  }
  if (!identity.image.id || identity.containers.length === 0) {
    throw new Error("identity image or container metadata is incomplete");
  }
}

export function formatDockerArtifactIdentityDetails(identity: ArtifactIdentity) {
  const containers = identity.containers
    .map((container) => `${container.role}=${container.id.slice(0, 12)}`)
    .join(", ");
  return [
    `package=${identity.package.name}@${identity.package.version}`,
    `sha256=${identity.package.sha256}`,
    `image=${identity.image.reference}@${identity.image.id}`,
    `containers=${containers}`,
  ].join("; ");
}

async function runScheduler(options: ProducerOptions, appendLog: (chunk: unknown) => void) {
  const dockerRunDir = path.join(options.artifactBase, "docker-run");
  const identityPath = path.join(options.artifactBase, "artifact-identities.json");
  await fs.mkdir(dockerRunDir, { recursive: true });
  let packageTgz = process.env.OPENCLAW_CURRENT_PACKAGE_TGZ;
  if (packageTgz) {
    const packageDir = path.join(dockerRunDir, "openclaw-package");
    const evidencePackageTgz = path.join(packageDir, "openclaw-current.tgz");
    const sourcePackageTgz = path.resolve(packageTgz);
    await fs.mkdir(packageDir, { recursive: true });
    if (sourcePackageTgz !== evidencePackageTgz) {
      await fs.copyFile(sourcePackageTgz, evidencePackageTgz);
    }
    packageTgz = evidencePackageTgz;
  }
  return await new Promise<{
    code: number | null;
    identityPath: string;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/test-docker-all.mjs"], {
      cwd: options.repoRoot,
      env: {
        ...process.env,
        OPENCLAW_DOCKER_ALL_BUILD: "1",
        OPENCLAW_DOCKER_ALL_DRY_RUN: "0",
        OPENCLAW_DOCKER_ALL_LANES: options.lane,
        OPENCLAW_DOCKER_ALL_LOG_DIR: dockerRunDir,
        OPENCLAW_DOCKER_ALL_PARALLELISM: "1",
        OPENCLAW_DOCKER_ALL_PREFLIGHT: "1",
        OPENCLAW_DOCKER_ALL_TIMINGS_FILE: path.join(dockerRunDir, "lane-timings.json"),
        OPENCLAW_DOCKER_ARTIFACT_IDENTITY_PATH: identityPath,
        ...(packageTgz ? { OPENCLAW_CURRENT_PACKAGE_TGZ: packageTgz } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      appendLog(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      appendLog(chunk);
    });
    child.on("exit", (code, signal) => resolve({ code, identityPath, signal }));
  });
}

async function runDockerArtifactProofProducer(
  options: ProducerOptions,
): Promise<QaEvidenceSummaryJson> {
  const proof = PROOFS[options.lane];
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "docker-artifact-proof.log",
    primaryModel: "docker/package-artifact",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      codeRefs: [
        SOURCE_PATH,
        "scripts/test-docker-all.mjs",
        "scripts/lib/docker-e2e-plan.mjs",
        "scripts/lib/docker-e2e-scenarios.mjs",
        "scripts/package-openclaw-for-docker.mjs",
      ],
      docsRefs: ["docs/install/docker.md", "docs/help/testing.md"],
      id: options.lane,
      sourcePath: SOURCE_PATH,
      title: proof.title,
    },
  });
  const startedAt = Date.now();
  try {
    const result = await runScheduler(options, (chunk) => writer.appendLog(chunk));
    if (result.code !== 0 || result.signal) {
      throw new Error(
        `Docker scheduler lane ${options.lane} failed: code=${String(result.code)} signal=${String(result.signal)}`,
      );
    }
    const identity = JSON.parse(await fs.readFile(result.identityPath, "utf8")) as ArtifactIdentity;
    assertIdentity(identity, options.lane);
    const packagePath = path.join("docker-run", "openclaw-package", "openclaw-current.tgz");
    return await writer.write({
      artifacts: [
        { kind: "identity", filePath: "artifact-identities.json" },
        { kind: "package", filePath: packagePath },
        { kind: "summary", filePath: path.join("docker-run", "summary.json") },
      ],
      details: formatDockerArtifactIdentityDetails(identity),
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

async function main(argv: string[]) {
  const evidence = await runDockerArtifactProofProducer(parseDockerArtifactProofOptions(argv));
  const status = evidence.entries[0]?.result.status;
  console.log(`Docker artifact proof evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Docker artifact proof status: ${status}`);
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
