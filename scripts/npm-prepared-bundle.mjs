#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  downloadExactActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
  readBoundedRegularFile,
} from "./lib/actions-artifact-archive.mjs";
import { isRecord } from "./lib/record-shared.mjs";
import { resolveReleaseTagPackageIdentity } from "./lib/release-version.mjs";
import { runReleaseToolingGh } from "./release-tooling-identity.mjs";

export const NPM_PACKAGE_PRODUCER_WORKFLOW = ".github/workflows/openclaw-npm-preflight.yml";
export const PREPARED_NPM_BUNDLE_SCHEMA = "openclaw.prepared-npm-bundle/v1";
export const QUALIFIED_NPM_PREFLIGHT_SCHEMA = "openclaw.qualified-npm-preflight/v1";
export const NPM_SOURCE_CHECK_SCHEMA = "openclaw.npm-source-check/v1";
const PACKAGE_MANIFEST_SCHEMA = "openclaw.npm-package-bundle/v1";
const PREPARE_JOB_NAME = "Prepare publishable npm package";
const VERIFY_JOB_NAME = "Qualify prepared npm package";
const SOURCE_JOB_NAME = "Check npm release source";
const CALLER_WORKFLOWS = new Set([
  ".github/workflows/openclaw-npm-release.yml",
  ".github/workflows/full-release-validation.yml",
  ".github/workflows/full-release-candidate.yml",
]);
const CORE_PACKAGE_POLICY = JSON.parse(
  readFileSync(new URL("./lib/npm-core-release-packages.json", import.meta.url), "utf8"),
);
const CORE_PACKAGES = CORE_PACKAGE_POLICY.map((entry) => entry.name);
const MAX_TARBALL_BYTES = 192 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
// SDK evidence embeds complete declaration diffs, which have exceeded 4 MiB.
// Qualified manifests carry that evidence; raw package descriptors do not.
const MAX_SDK_EVIDENCE_BYTES = 16 * 1024 * 1024;

function requireMatch(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function sha(value, label) {
  return requireMatch(value, /^[a-f0-9]{40}$/u, label);
}

function digest(value, label) {
  return requireMatch(value, /^[a-f0-9]{64}$/u, label);
}

function decimal(value, label) {
  const result = requireMatch(value, /^[1-9][0-9]*$/u, label);
  if (!Number.isSafeInteger(Number(result))) {
    throw new Error(`Invalid ${label}.`);
  }
  return result;
}

function fileName(value) {
  return requireMatch(value, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.tgz$/u, "npm tarball filename");
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path, maxBytes = MAX_MANIFEST_BYTES) {
  return JSON.parse(readBoundedRegularFile(path, { label: path, maxBytes }));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function same(left, right, label) {
  if (!isDeepStrictEqual(left, right)) {
    throw new Error(`${label} does not match the prepared npm bundle.`);
  }
}

function producerWorkflow(producer) {
  const repository = requireMatch(
    producer.repository,
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
    "repository",
  );
  const prefix = `${repository}/`;
  if (typeof producer.workflowRef !== "string" || !producer.workflowRef.startsWith(prefix)) {
    throw new Error("Invalid npm bundle workflow ref.");
  }
  const [path, fullRef, extra] = producer.workflowRef.slice(prefix.length).split("@");
  if (
    !CALLER_WORKFLOWS.has(path) ||
    !/^refs\/(heads|tags)\/[^\s@]+$/u.test(fullRef ?? "") ||
    extra
  ) {
    throw new Error("npm bundle must be produced by an approved release workflow.");
  }
  return { path, fullRef, ref: fullRef.replace(/^refs\/(?:heads|tags)\//u, "") };
}

function validateProducer(producer, { repository, toolingSha, jobName }) {
  if (!isRecord(producer)) {
    throw new Error("npm bundle producer is required.");
  }
  producerWorkflow(producer);
  if (
    producer.repository !== repository ||
    producer.workflowSha !== sha(toolingSha, "trusted tooling SHA") ||
    producer.producerWorkflowPath !== NPM_PACKAGE_PRODUCER_WORKFLOW ||
    typeof producer.jobName !== "string" ||
    (producer.jobName !== jobName && !producer.jobName.endsWith(` / ${jobName}`))
  ) {
    throw new Error("npm bundle producer does not match the trusted preflight owner.");
  }
  for (const key of ["runId", "runAttempt", "jobId"]) {
    decimal(producer[key], `producer ${key}`);
  }
  return producer;
}

function validateCorePackages(corePackages, version) {
  if (!Array.isArray(corePackages) || corePackages.length > CORE_PACKAGES.length) {
    throw new Error("Invalid prepared core package inventory.");
  }
  const names = new Set();
  const files = new Set();
  for (const entry of corePackages) {
    if (
      !isRecord(entry) ||
      !CORE_PACKAGES.includes(entry.packageName) ||
      names.has(entry.packageName)
    ) {
      throw new Error("Invalid or duplicate prepared core package.");
    }
    if (entry.packageVersion !== version || files.has(fileName(entry.tarballName))) {
      throw new Error("Prepared core package version or filename mismatch.");
    }
    digest(entry.tarballSha256, "core package tarball digest");
    names.add(entry.packageName);
    files.add(entry.tarballName);
  }
  return corePackages;
}

export function validatePreparedNpmBundleDescriptor({
  descriptor,
  repository,
  sourceSha,
  toolingSha,
}) {
  if (!isRecord(descriptor) || descriptor.schema !== PREPARED_NPM_BUNDLE_SCHEMA) {
    throw new Error("Unsupported prepared npm bundle descriptor.");
  }
  const { artifact, package: pkg, producer } = descriptor;
  validateProducer(producer, { repository, toolingSha, jobName: PREPARE_JOB_NAME });
  if (
    !isRecord(pkg) ||
    pkg.name !== "openclaw" ||
    typeof pkg.version !== "string" ||
    !pkg.version
  ) {
    throw new Error("Invalid prepared npm package identity.");
  }
  if (
    pkg.sourceSha !== sha(sourceSha, "release source SHA") ||
    descriptor.source?.sha !== sourceSha
  ) {
    throw new Error("Prepared npm bundle source SHA mismatch.");
  }
  fileName(pkg.fileName);
  digest(pkg.sha256, "root tarball digest");
  digest(descriptor.manifestSha256, "package manifest digest");
  validateCorePackages(descriptor.corePackages, pkg.version);
  if (descriptor.corePackages.some((entry) => entry.tarballName === pkg.fileName)) {
    throw new Error("Prepared root and core tarball filenames overlap.");
  }
  if (
    !isRecord(artifact) ||
    artifact.name !== `openclaw-npm-package-${producer.runId}-${producer.runAttempt}` ||
    artifact.runId !== producer.runId ||
    artifact.runAttempt !== producer.runAttempt
  ) {
    throw new Error("Prepared npm bundle artifact identity mismatch.");
  }
  decimal(artifact.id, "artifact ID");
  digest(artifact.digest, "artifact digest");
  return descriptor;
}

function githubJson(repository, suffix, runGh, query) {
  return JSON.parse(
    runGh([
      "api",
      `repos/${repository}/${suffix}`,
      "--method",
      "GET",
      ...(query ? ["--jq", query] : []),
    ]),
  );
}

function readAttemptJobs(repository, producer, runGh) {
  const jobs = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = githubJson(
      repository,
      `actions/runs/${producer.runId}/attempts/${producer.runAttempt}/jobs?per_page=100&page=${page}`,
      runGh,
      "{total_count,jobs:[.jobs[] | {id,name,run_id,run_attempt,head_sha,status,conclusion}]}",
    );
    if (
      !Array.isArray(response.jobs) ||
      !Number.isSafeInteger(response.total_count) ||
      response.total_count > 1000
    ) {
      throw new Error("Invalid npm producer job inventory.");
    }
    jobs.push(...response.jobs);
    if (jobs.length === response.total_count) {
      return jobs;
    }
    if (response.jobs.length !== 100 || jobs.length > response.total_count) {
      break;
    }
  }
  throw new Error("Incomplete npm producer job inventory.");
}

export function verifyNpmBundleProducer({
  producer,
  repository,
  toolingSha,
  qualified = false,
  sourceCheck = false,
  requireCompletedParent = false,
  runGh = runReleaseToolingGh,
}) {
  validateProducer(producer, {
    repository,
    toolingSha,
    jobName: sourceCheck ? SOURCE_JOB_NAME : qualified ? VERIFY_JOB_NAME : PREPARE_JOB_NAME,
  });
  const workflow = producerWorkflow(producer);
  const run = githubJson(
    repository,
    `actions/runs/${producer.runId}/attempts/${producer.runAttempt}`,
    runGh,
  );
  const [runPath, runRef] = String(run.path).split("@");
  if (
    String(run.id) !== producer.runId ||
    String(run.run_attempt) !== producer.runAttempt ||
    run.head_sha !== toolingSha ||
    runPath !== workflow.path ||
    (runRef !== undefined && runRef !== workflow.fullRef) ||
    run.head_branch !== workflow.ref ||
    run.event !== "workflow_dispatch" ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository
  ) {
    throw new Error("npm bundle producer run identity mismatch.");
  }
  // Qualification retries reuse completed producer jobs from failed attempts.
  // Publication additionally requires the complete producer attempt to succeed.
  if (requireCompletedParent && (run.status !== "completed" || run.conclusion !== "success")) {
    throw new Error("npm publication requires a successful producer parent.");
  }
  const matches = readAttemptJobs(repository, producer, runGh).filter(
    (job) => job.name === producer.jobName,
  );
  const job = matches[0];
  if (
    matches.length !== 1 ||
    String(job.id) !== producer.jobId ||
    String(job.run_id) !== producer.runId ||
    String(job.run_attempt) !== producer.runAttempt ||
    job.head_sha !== toolingSha ||
    job.status !== "completed" ||
    job.conclusion !== "success"
  ) {
    throw new Error("npm bundle requires its unique exact completed producer job.");
  }
  return { run, job };
}

export function verifyNpmSourceCheck({ descriptor, repository, sourceSha, toolingSha, runGh }) {
  if (
    descriptor?.schema !== NPM_SOURCE_CHECK_SCHEMA ||
    descriptor.source?.sha !== sha(sourceSha, "release source SHA")
  ) {
    throw new Error("npm source-check evidence does not match the release source SHA.");
  }
  return verifyNpmBundleProducer({
    producer: descriptor.producer,
    repository,
    toolingSha,
    sourceCheck: true,
    runGh,
  });
}

function packageInventory(descriptor) {
  return [
    { tarballName: descriptor.package.fileName, tarballSha256: descriptor.package.sha256 },
    ...descriptor.corePackages,
  ];
}

export function verifyPreparedNpmBundleFiles({ descriptor, files }) {
  const manifestBytes = files.get("package-bundle.json");
  if (!manifestBytes || hash(manifestBytes) !== descriptor.manifestSha256) {
    throw new Error("Prepared npm package manifest digest mismatch.");
  }
  const manifest = JSON.parse(manifestBytes);
  if (
    manifest.schema !== PACKAGE_MANIFEST_SCHEMA ||
    manifest.packageName !== descriptor.package.name ||
    manifest.packageVersion !== descriptor.package.version ||
    manifest.releaseSha !== descriptor.source.sha ||
    manifest.tarballName !== descriptor.package.fileName ||
    manifest.tarballSha256 !== descriptor.package.sha256
  ) {
    throw new Error("Prepared npm package manifest identity mismatch.");
  }
  same(manifest.producer, descriptor.producer, "Package producer");
  same(manifest.corePackageTarballs, descriptor.corePackages, "Core package inventory");
  same(
    manifest.dependencyTarballs,
    descriptor.corePackages.filter((entry) => entry.packageName === "@openclaw/ai"),
    "Root dependency inventory",
  );
  for (const entry of packageInventory(descriptor)) {
    const bytes = files.get(entry.tarballName);
    if (!bytes || hash(bytes) !== entry.tarballSha256) {
      throw new Error(`Prepared npm tarball digest mismatch: ${entry.tarballName}.`);
    }
  }
  return manifest;
}

export async function downloadPreparedNpmBundle({
  descriptor,
  repository,
  sourceSha,
  toolingSha,
  outputDir,
  token,
  npmDistTag,
  releaseTag = "",
  runGh = runReleaseToolingGh,
  fetchImpl,
}) {
  validatePreparedNpmBundleDescriptor({ descriptor, repository, sourceSha, toolingSha });
  verifyNpmBundleProducer({ producer: descriptor.producer, repository, toolingSha, runGh });
  const metadata = githubJson(repository, `actions/artifacts/${descriptor.artifact.id}`, runGh);
  const { archiveBytes } = await downloadExactActionsArtifactArchive({
    token,
    fetchImpl,
    expected: {
      repository,
      artifactId: Number(descriptor.artifact.id),
      artifactName: descriptor.artifact.name,
      artifactDigest: `sha256:${descriptor.artifact.digest}`,
      artifactSizeBytes: metadata.size_in_bytes,
      artifactExpiresAt: metadata.expires_at,
      runId: Number(descriptor.artifact.runId),
      workflowSha: toolingSha,
    },
  });
  const files = inspectActionsArtifactZipWithPolicy(archiveBytes, {
    expectedEntries: [
      "package-bundle.json",
      ...packageInventory(descriptor).map((entry) => entry.tarballName),
    ],
    maxEntryBytes: (name) => (name.endsWith(".tgz") ? MAX_TARBALL_BYTES : MAX_MANIFEST_BYTES),
  });
  const manifest = verifyPreparedNpmBundleFiles({ descriptor, files });
  if (npmDistTag !== undefined && manifest.npmDistTag !== npmDistTag) {
    throw new Error("Prepared npm bundle dist-tag mismatch.");
  }
  // Candidate acceptance binds source bytes; qualification also pins the publication tag.
  if (releaseTag && manifest.releaseTag !== releaseTag) {
    throw new Error("Prepared npm bundle release tag mismatch.");
  }
  // Validate the complete archive before any bytes become consumer input.
  mkdirSync(outputDir, { recursive: true });
  if (readdirSync(outputDir).length !== 0) {
    throw new Error("Prepared npm bundle destination must be empty.");
  }
  for (const [name, bytes] of files) {
    writeFileSync(join(outputDir, name), bytes, { flag: "wx" });
  }
  const coreTarballDir = join(outputDir, "core-packages");
  mkdirSync(coreTarballDir);
  for (const entry of descriptor.corePackages) {
    copyFileSync(join(outputDir, entry.tarballName), join(coreTarballDir, entry.tarballName));
  }
  return { manifest, tarballPath: join(outputDir, descriptor.package.fileName), coreTarballDir };
}

function resolveCurrentProducer(env, jobName, runGh = runReleaseToolingGh) {
  const context = JSON.parse(env.JOB_CONTEXT ?? "{}");
  if (
    context.workflow_file_path !== NPM_PACKAGE_PRODUCER_WORKFLOW ||
    context.workflow_repository !== env.GITHUB_REPOSITORY ||
    context.workflow_sha !== env.PREFLIGHT_WORKFLOW_SHA
  ) {
    throw new Error("Current job context must identify the exact canonical npm preflight owner.");
  }
  const producer = {
    repository: env.GITHUB_REPOSITORY,
    workflowRef: env.PREFLIGHT_WORKFLOW_REF,
    workflowSha: env.PREFLIGHT_WORKFLOW_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    jobId: decimal(String(context.check_run_id ?? ""), "current job ID"),
    jobName,
    // Job context names the reusable owner; github.workflow_ref names its caller.
    producerWorkflowPath: NPM_PACKAGE_PRODUCER_WORKFLOW,
  };
  validateProducer(producer, {
    repository: producer.repository,
    toolingSha: producer.workflowSha,
    jobName,
  });
  const job = githubJson(producer.repository, `actions/jobs/${producer.jobId}`, runGh);
  if (
    String(job.id) !== producer.jobId ||
    String(job.run_id) !== producer.runId ||
    String(job.run_attempt) !== producer.runAttempt ||
    job.head_sha !== producer.workflowSha ||
    job.status !== "in_progress" ||
    (job.name !== jobName && !job.name?.endsWith(` / ${jobName}`))
  ) {
    throw new Error("Current npm producer job identity mismatch.");
  }
  return { ...producer, jobName: job.name };
}

function normalizePackModes(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", ".artifacts", ".release-harness"].includes(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      chmodSync(path, 0o755);
      normalizePackModes(path);
    } else if (stat.isFile()) {
      chmodSync(path, stat.mode & 0o111 ? 0o755 : 0o644);
    }
  }
}

export function prepareNpmPackageBundle({
  sourceDir,
  outputDir,
  releaseRef,
  releaseTag: requestedReleaseTag = "",
  npmDistTag,
  producer,
  runPack = (directory, destination) =>
    execFileSync("pnpm", ["--dir", directory, "pack", "--pack-destination", destination], {
      env: {
        ...process.env,
        OPENCLAW_PREPACK_PREPARED: "1",
        ...(/^[a-f0-9]{40}$/u.test(releaseRef)
          ? { OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG: "1" }
          : {}),
      },
      stdio: "inherit",
      timeout: 30 * 60 * 1000,
    }),
}) {
  const sourceSha = execFileSync("git", ["-C", sourceDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const root = readJson(join(sourceDir, "package.json"));
  const sourceRefIsSha = /^[a-f0-9]{40}$/u.test(releaseRef);
  const { releaseTag, baseTag } = resolveReleaseTagPackageIdentity(
    requestedReleaseTag || (sourceRefIsSha ? `v${root.version}` : releaseRef),
    root.version,
  );
  if (
    (sourceRefIsSha && releaseRef !== sourceSha) ||
    (!sourceRefIsSha && releaseRef !== releaseTag)
  ) {
    throw new Error("npm package source does not match the release ref.");
  }
  // A correction may retain base-version bytes only at the exact published base source.
  if (
    baseTag &&
    execFileSync("git", ["-C", sourceDir, "rev-parse", "--verify", `${baseTag}^{commit}`], {
      encoding: "utf8",
    }).trim() !== sourceSha
  ) {
    throw new Error("npm correction package source does not match its base release tag.");
  }
  mkdirSync(outputDir, { recursive: true });
  if (readdirSync(outputDir).length !== 0) {
    throw new Error("npm package output directory must be empty.");
  }
  // Preserve non-root installs before hashing; qualified consumers never rewrite the archive.
  normalizePackModes(sourceDir);
  const pack = (directory, packageName) => {
    const before = new Set(readdirSync(outputDir));
    runPack(directory, outputDir);
    const added = readdirSync(outputDir).filter((name) => !before.has(name));
    if (added.length !== 1) {
      throw new Error(`Expected one new tarball for ${packageName}.`);
    }
    const tarballName = fileName(added[0]);
    const path = join(outputDir, tarballName);
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOf", path, "package/package.json"], {
        encoding: "utf8",
        maxBuffer: MAX_MANIFEST_BYTES,
      }),
    );
    if (manifest.name !== packageName || manifest.version !== root.version) {
      throw new Error(`Packed identity mismatch for ${packageName}.`);
    }
    return {
      packageName,
      packageVersion: root.version,
      tarballName,
      tarballSha256: hash(
        readBoundedRegularFile(path, { label: tarballName, maxBytes: MAX_TARBALL_BYTES }),
      ),
    };
  };
  const corePackageTarballs = CORE_PACKAGE_POLICY.flatMap((policy) => {
    const packageName = policy.name;
    const directory = join(sourceDir, policy.path);
    if (policy.dependency) {
      if (typeof root.dependencies?.[policy.dependency] !== "string") {
        return [];
      }
    } else if (
      !existsSync(join(directory, "package.json")) ||
      readJson(join(directory, "package.json")).openclaw?.release?.publishToNpm !== true
    ) {
      return [];
    }
    if (readJson(join(directory, "package.json")).version !== root.version) {
      throw new Error(`Core package version mismatch: ${packageName}.`);
    }
    return [pack(directory, packageName)];
  });
  const packed = pack(sourceDir, "openclaw");
  const manifest = {
    schema: PACKAGE_MANIFEST_SCHEMA,
    producer,
    releaseTag,
    releaseSha: sourceSha,
    npmDistTag,
    ...packed,
    corePackageTarballs,
    dependencyTarballs: corePackageTarballs.filter((entry) => entry.packageName === "@openclaw/ai"),
  };
  writeJson(join(outputDir, "package-bundle.json"), manifest);
  return manifest;
}

export function describeNpmBundle({ directory, artifact, qualified = false }) {
  const manifestPath = join(
    directory,
    qualified ? "preflight-manifest.json" : "package-bundle.json",
  );
  const manifest = readJson(
    manifestPath,
    qualified ? MAX_SDK_EVIDENCE_BYTES + MAX_MANIFEST_BYTES : MAX_MANIFEST_BYTES,
  );
  const shared = {
    source: { sha: manifest.releaseSha },
    artifact,
    producer: manifest.producer,
    manifestSha256: hash(readFileSync(manifestPath)),
  };
  if (qualified) {
    return {
      schema: QUALIFIED_NPM_PREFLIGHT_SCHEMA,
      ...shared,
      preparedBundle: manifest.preparedBundle,
    };
  }
  return {
    schema: PREPARED_NPM_BUNDLE_SCHEMA,
    ...shared,
    package: {
      name: manifest.packageName,
      fileName: manifest.tarballName,
      sha256: manifest.tarballSha256,
      version: manifest.packageVersion,
      sourceSha: manifest.releaseSha,
    },
    corePackages: manifest.corePackageTarballs,
  };
}

export function qualifyNpmPackageBundle({
  descriptor,
  inputDir,
  outputDir,
  producer,
  pluginSdkApi,
  dependencyEvidenceDir,
}) {
  const files = new Map(
    ["package-bundle.json", ...packageInventory(descriptor).map((entry) => entry.tarballName)].map(
      (name) => [
        name,
        readBoundedRegularFile(join(inputDir, name), {
          label: name,
          maxBytes: name.endsWith(".tgz") ? MAX_TARBALL_BYTES : MAX_MANIFEST_BYTES,
        }),
      ],
    ),
  );
  const prepared = verifyPreparedNpmBundleFiles({ descriptor, files });
  mkdirSync(outputDir, { recursive: true });
  if (readdirSync(outputDir).length !== 0) {
    throw new Error("Qualified npm bundle output directory must be empty.");
  }
  for (const entry of packageInventory(descriptor)) {
    writeFileSync(join(outputDir, entry.tarballName), files.get(entry.tarballName));
  }
  cpSync(dependencyEvidenceDir, join(outputDir, "dependency-evidence"), { recursive: true });
  const { schema: _schema, producer: _producer, ...identity } = prepared;
  const manifest = {
    version: 3,
    producer,
    preparedBundle: descriptor,
    ...identity,
    pluginSdkApi,
    dependencyEvidenceDir: "dependency-evidence",
    dependencyEvidenceManifest: "dependency-evidence/dependency-evidence-manifest.json",
  };
  writeJson(join(outputDir, "preflight-manifest.json"), manifest);
  writeFileSync(join(outputDir, "release-tag.txt"), `${manifest.releaseTag}\n`);
  writeFileSync(join(outputDir, "release-sha.txt"), `${manifest.releaseSha}\n`);
  writeFileSync(join(outputDir, "release-npm-dist-tag.txt"), `${manifest.npmDistTag}\n`);
  if (manifest.corePackageTarballs.length) {
    writeFileSync(
      join(outputDir, "core-packages-SHA256SUMS"),
      manifest.corePackageTarballs
        .map((entry) => `${entry.tarballSha256}  ${entry.tarballName}\n`)
        .join(""),
    );
  }
  return manifest;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
      [
        "descriptor",
        "repository",
        "source-sha",
        "tooling-sha",
        "output-dir",
        "input-dir",
        "source-dir",
        "release-ref",
        "release-tag",
        "npm-dist-tag",
        "plugin-sdk-evidence",
        "dependency-evidence-dir",
        "artifact-id",
        "artifact-name",
        "artifact-digest",
      ].map((name) => [name, { type: "string" }]),
    ),
  });
  const command = positionals[0];
  let result;
  if (command === "download") {
    result = await downloadPreparedNpmBundle({
      descriptor: readJson(values.descriptor),
      repository: values.repository,
      sourceSha: values["source-sha"],
      toolingSha: values["tooling-sha"],
      outputDir: resolve(values["output-dir"]),
      token: process.env.GH_TOKEN,
      npmDistTag: values["npm-dist-tag"],
      releaseTag: values["release-tag"],
    });
  } else if (command === "verify-source") {
    result = verifyNpmSourceCheck({
      descriptor: readJson(values.descriptor),
      repository: values.repository,
      sourceSha: values["source-sha"],
      toolingSha: values["tooling-sha"],
    });
  } else if (command === "source-evidence") {
    result = {
      schema: NPM_SOURCE_CHECK_SCHEMA,
      source: { sha: sha(values["source-sha"], "release source SHA") },
      producer: resolveCurrentProducer(process.env, SOURCE_JOB_NAME),
    };
  } else if (command === "prepare") {
    process.umask(0o022);
    result = prepareNpmPackageBundle({
      sourceDir: resolve(values["source-dir"]),
      outputDir: resolve(values["output-dir"]),
      releaseRef: values["release-ref"],
      releaseTag: values["release-tag"],
      npmDistTag: values["npm-dist-tag"],
      producer: resolveCurrentProducer(process.env, PREPARE_JOB_NAME),
    });
  } else if (command === "qualify") {
    result = qualifyNpmPackageBundle({
      descriptor: readJson(values.descriptor),
      inputDir: resolve(values["input-dir"]),
      outputDir: resolve(values["output-dir"]),
      producer: resolveCurrentProducer(process.env, VERIFY_JOB_NAME),
      pluginSdkApi: readJson(values["plugin-sdk-evidence"], MAX_SDK_EVIDENCE_BYTES),
      dependencyEvidenceDir: values["dependency-evidence-dir"],
    });
  } else if (command === "describe" || command === "describe-qualified") {
    result = describeNpmBundle({
      directory: values["input-dir"],
      qualified: command === "describe-qualified",
      artifact: {
        id: values["artifact-id"],
        name: values["artifact-name"],
        digest: values["artifact-digest"],
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      },
    });
  } else {
    throw new Error(
      "Usage: npm-prepared-bundle.mjs <prepare|download|qualify|describe|describe-qualified> [options]",
    );
  }
  if (process.env.GITHUB_OUTPUT) {
    if (command === "download") {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `tarball_path=${result.tarballPath}\ncore_tarball_dir=${result.coreTarballDir}\n`,
      );
    } else if (command.startsWith("describe") || command === "source-evidence") {
      appendFileSync(process.env.GITHUB_OUTPUT, `bundle_json=${JSON.stringify(result)}\n`);
    } else {
      appendFileSync(process.env.GITHUB_OUTPUT, `release_tag=${result.releaseTag}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
