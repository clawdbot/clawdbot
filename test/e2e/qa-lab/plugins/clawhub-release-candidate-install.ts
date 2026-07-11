// Produces QA Lab evidence for release-candidate npm package install proof.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import { createBoundedChildOutput } from "../../../helpers/bounded-child-output.js";
import {
  createQaScriptBlockedStatusTracker,
  createQaScriptEvidenceWriter,
  type QaScriptEvidenceStatus,
} from "../runtime/script-evidence.js";

const SCENARIO_ID = "clawhub-release-candidate-checklist";
const SCENARIO_TITLE = "ClawHub release candidate npm package install proof";
const SOURCE_PATH = "test/e2e/qa-lab/plugins/clawhub-release-candidate-install.ts";
const COVERAGE_ID = "clawhub.npm-pack-local-release-candidate-installs";
const DEFAULT_TARBALL_ENV = "OPENCLAW_QA_RELEASE_CANDIDATE_TARBALL";
const CHECKOUT_BUILD_RESULT_PREFIX = "__OPENCLAW_QA_RELEASE_CANDIDATE_TARBALL__";
const execFileAsync = promisify(execFile);
const CLAWHUB_BLOCKED_PREREQUISITE_PATTERNS = [
  /\bprlctl\b/i,
  /failed to detect parallels host ip/i,
  /vm .*not found/i,
  /could not resolve .*vm/i,
  /no .*vm/i,
  /parallels desktop .*not/i,
  /api key/i,
  /provider auth/i,
];

type ProducerOptions = {
  artifactBase: string;
  buildFromCheckout: boolean;
  platform?: string;
  repoRoot: string;
  tarballEnv: string;
};

type ParallelsSummary = {
  freshTarget?: Record<string, string>;
  freshTargetSpec?: string;
  update?: Record<string, { status?: string; version?: string }>;
  updateTargetPackageVersion?: string;
  updateTargetTarball?: string;
};

type ProofResult = {
  artifacts?: Array<{ filePath: string; kind: string }>;
  details?: string;
  durationMs: number;
  status: QaScriptEvidenceStatus;
};

class ParallelsProofError extends Error {
  constructor(
    message: string,
    readonly evidenceStatus: QaScriptEvidenceStatus,
  ) {
    super(message);
    this.name = "ParallelsProofError";
  }
}

function usage() {
  return `Usage: node --import tsx ${SOURCE_PATH} --artifact-base <dir> [options]

Produces QA Lab evidence for ClawHub release-candidate package install proof.

Options:
  --artifact-base <dir>    Evidence artifact directory
  --repo-root <dir>        Repository root
  --tarball-env <name>     Env var containing candidate .tgz path
                           Default: ${DEFAULT_TARBALL_ENV}
  --build-from-checkout    Build a candidate .tgz from this checkout when no
                           tarball env is set
  --platform <list>        Optional Parallels platform list passed through
  -h, --help               Show this help
`;
}

function readOptionValue(argv: readonly string[], index: number, arg: string) {
  const value = argv[index + 1] ?? "";
  if (!value || value.startsWith("-")) {
    throw new Error(`${arg} requires a value`);
  }
  return value;
}

function parseOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ProducerOptions {
  let artifactBase = "";
  let buildFromCheckout = env.OPENCLAW_QA_RELEASE_CANDIDATE_BUILD === "1";
  let platform: string | undefined;
  let repoRoot = process.cwd();
  let tarballEnv = DEFAULT_TARBALL_ENV;
  const seen = new Set<string>();
  const recordOnce = (flag: string) => {
    if (seen.has(flag)) {
      throw new Error(`${flag} was provided more than once`);
    }
    seen.add(flag);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--artifact-base") {
      recordOnce(arg);
      artifactBase = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--repo-root") {
      recordOnce(arg);
      repoRoot = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--tarball-env") {
      recordOnce(arg);
      tarballEnv = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--build-from-checkout") {
      recordOnce(arg);
      buildFromCheckout = true;
      continue;
    }
    if (arg === "--platform") {
      recordOnce(arg);
      platform = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`unsupported release-candidate install producer arg: ${arg}`);
  }

  if (!artifactBase.trim()) {
    throw new Error("--artifact-base is required");
  }
  if (!tarballEnv.trim()) {
    throw new Error("--tarball-env requires a non-empty env var name");
  }
  return {
    artifactBase: path.resolve(repoRoot, artifactBase),
    buildFromCheckout,
    platform,
    repoRoot: path.resolve(repoRoot),
    tarballEnv,
  };
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function resolveCandidateTarball(options: ProducerOptions) {
  const explicitTarball = process.env[options.tarballEnv]?.trim();
  if (explicitTarball) {
    return path.resolve(options.repoRoot, explicitTarball);
  }
  if (!options.buildFromCheckout) {
    return undefined;
  }
  return await buildCandidateTarballFromCheckout(options);
}

async function buildCandidateTarballFromCheckout(options: ProducerOptions) {
  const destination = path.join(options.artifactBase, "package");
  await fs.mkdir(destination, { recursive: true });
  const evalScript = `
    import { packOpenClaw } from "./scripts/e2e/parallels/package-artifact.ts";
    const artifact = await packOpenClaw({ destination: ${JSON.stringify(destination)} });
    process.stdout.write(${JSON.stringify(CHECKOUT_BUILD_RESULT_PREFIX)} + JSON.stringify({ path: artifact.path }) + "\\n");
  `;
  const result = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", evalScript],
    {
      cwd: options.repoRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const resultLine = result.stdout
    .split("\n")
    .find((line) => line.startsWith(CHECKOUT_BUILD_RESULT_PREFIX));
  if (!resultLine) {
    throw new Error("checkout package build did not report a tarball marker");
  }
  const parsed = JSON.parse(resultLine.slice(CHECKOUT_BUILD_RESULT_PREFIX.length)) as {
    path?: unknown;
  };
  if (typeof parsed.path !== "string" || !parsed.path.trim()) {
    throw new Error("checkout package build did not report a tarball path");
  }
  return parsed.path;
}

async function extractPackageJsonFromTgz<T>(tgzPath: string, entry: string): Promise<T> {
  const result = await execFileAsync("tar", ["-xOf", tgzPath, entry], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(result.stdout) as T;
}

async function validateCandidateTarball(tarballPath: string) {
  const [version, buildCommit] = await Promise.all([
    extractPackageJsonFromTgz<{ version?: string }>(tarballPath, "package/package.json").then(
      (pkg) => pkg.version ?? "",
    ),
    extractPackageJsonFromTgz<{ commit?: string }>(
      tarballPath,
      "package/dist/build-info.json",
    ).then((info) => info.commit ?? ""),
  ]);
  if (!version || !buildCommit) {
    throw new Error(`target tarball is missing package or build metadata: ${tarballPath}`);
  }
  return { buildCommit, version };
}

async function runParallelsProof(params: {
  options: ProducerOptions;
  tarballPath: string;
  writer: ReturnType<typeof createClawHubEvidenceWriter>;
}) {
  const args = [
    "scripts/e2e/parallels-npm-update-smoke.sh",
    "--target-tarball",
    params.tarballPath,
    "--json",
  ];
  if (params.options.platform) {
    args.push("--platform", params.options.platform);
  }
  params.writer.appendLog(`$ bash ${args.map((arg) => JSON.stringify(arg)).join(" ")}\n`);

  return await new Promise<string>((resolve, reject) => {
    const child = spawn("bash", args, {
      cwd: params.options.repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = createBoundedChildOutput(1024 * 1024);
    const statusTracker = createQaScriptBlockedStatusTracker(CLAWHUB_BLOCKED_PREREQUISITE_PATTERNS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      params.writer.appendLog(chunk);
      stdout.append(chunk);
      statusTracker.append(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      params.writer.appendLog(chunk);
      statusTracker.append(chunk);
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      const stdoutText = stdout.text();
      if (status === 0 && !signal) {
        resolve(stdoutText);
        return;
      }
      const reason = signal
        ? `Parallels npm-update proof terminated by ${signal}`
        : `Parallels npm-update proof exited with ${status ?? 1}`;
      reject(new ParallelsProofError(reason, statusTracker.status()));
    });
  });
}

function parseParallelsSummary(stdout: string): ParallelsSummary {
  try {
    return JSON.parse(stdout) as ParallelsSummary;
  } catch (error) {
    throw new Error(
      `Parallels npm-update proof did not print JSON summary: ${formatErrorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}

function requireHostedCandidateTarball(params: { summary: ParallelsSummary; tarballPath: string }) {
  const rawUrl = params.summary.updateTargetTarball?.trim();
  if (!rawUrl) {
    throw new Error("summary missing updateTargetTarball");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new Error(`updateTargetTarball is not a URL: ${rawUrl}`, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`updateTargetTarball is not hosted over HTTP(S): ${rawUrl}`);
  }
  const hostedName = decodeURIComponent(path.posix.basename(url.pathname));
  const expectedName = path.basename(params.tarballPath);
  if (hostedName !== expectedName) {
    throw new Error(
      `updateTargetTarball does not point at the candidate tarball: expected ${expectedName}, got ${hostedName}`,
    );
  }
}

function assertParallelsSummary(params: {
  summary: ParallelsSummary;
  tarballPath: string;
  version: string;
}) {
  requireHostedCandidateTarball(params);
  if (!params.summary.updateTargetPackageVersion) {
    throw new Error("summary missing updateTargetPackageVersion");
  }
  if (params.summary.updateTargetPackageVersion !== params.version) {
    throw new Error(
      `summary target version ${params.summary.updateTargetPackageVersion} does not match candidate ${params.version}`,
    );
  }

  const freshTargetPasses = Object.entries(params.summary.freshTarget ?? {}).filter(
    ([, status]) => status === "pass",
  );
  if (freshTargetPasses.length === 0) {
    throw new Error("summary has no passing freshTarget platform");
  }

  const updatePasses = Object.entries(params.summary.update ?? {}).filter(
    ([, result]) => result?.status === "pass",
  );
  if (updatePasses.length === 0) {
    throw new Error("summary has no passing update platform");
  }
}

function isBlockedPrerequisiteFailure(message: string) {
  return CLAWHUB_BLOCKED_PREREQUISITE_PATTERNS.some((pattern) => pattern.test(message));
}

function createClawHubEvidenceWriter(options: ProducerOptions) {
  return createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "parallels-npm-update.log",
    primaryModel: "mock-openai/gpt-5.6-luna",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: SCENARIO_TITLE,
      sourcePath: SOURCE_PATH,
      primaryCoverageIds: [COVERAGE_ID],
      docsRefs: ["docs/help/testing.md", "docs/concepts/qa-e2e-automation.md"],
      codeRefs: [
        SOURCE_PATH,
        "scripts/e2e/parallels-npm-update-smoke.sh",
        "scripts/e2e/parallels/npm-update-smoke.ts",
        "test/scripts/release-candidate-checklist.test.ts",
      ],
    },
  });
}

async function produceProof(
  options: ProducerOptions,
  writer: ReturnType<typeof createClawHubEvidenceWriter>,
): Promise<ProofResult> {
  const startedAt = Date.now();
  await fs.mkdir(options.artifactBase, { recursive: true });
  const summaryPath = path.join(options.artifactBase, "parallels-summary.json");

  try {
    const tarballPath = await resolveCandidateTarball(options);
    if (!tarballPath) {
      return {
        details: `${options.tarballEnv} is not set; provide a candidate .tgz or pass --build-from-checkout.`,
        durationMs: Math.max(1, Date.now() - startedAt),
        status: "blocked",
      };
    }
    await fs.access(tarballPath);
    const metadata = await validateCandidateTarball(tarballPath);
    writer.appendLog(
      `candidate: ${tarballPath}\nversion: ${metadata.version}\nbuild commit: ${metadata.buildCommit}\n`,
    );
    const commandOutput = await runParallelsProof({ options, tarballPath, writer });
    const summary = parseParallelsSummary(commandOutput);
    assertParallelsSummary({
      summary,
      tarballPath,
      version: metadata.version,
    });
    await writeJson(summaryPath, summary);
    return {
      artifacts: [{ kind: "summary", filePath: "parallels-summary.json" }],
      details: `candidate ${metadata.version} installed fresh and updated through Parallels npm semantics`,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    };
  } catch (error) {
    const details = formatErrorMessage(error);
    const status: QaScriptEvidenceStatus =
      error instanceof ParallelsProofError
        ? error.evidenceStatus
        : isBlockedPrerequisiteFailure(details)
          ? "blocked"
          : "fail";
    writer.appendLog(`\n${status}: ${details}\n`);
    return {
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status,
    };
  }
}

export async function runClawHubReleaseCandidateInstallProducer(
  options: ProducerOptions,
): Promise<QaEvidenceSummaryJson> {
  const writer = createClawHubEvidenceWriter(options);
  const result = await produceProof(options, writer);
  return await writer.write(result);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runClawHubReleaseCandidateInstallProducer(parseOptions(process.argv.slice(2)))
    .then((evidence) => {
      console.log(`ClawHub release-candidate install evidence: ${QA_EVIDENCE_FILENAME}`);
      console.log(
        `ClawHub release-candidate install status: ${evidence.entries[0]?.result.status}`,
      );
    })
    .catch((error: unknown) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}
