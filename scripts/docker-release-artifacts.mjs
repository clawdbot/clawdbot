#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { promoteDockerChannel } from "./docker-channel-promote.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { resolveDockerReleasePolicy } from "./lib/docker-release-policy.mjs";
import { resolveReleaseTagPackageIdentity } from "./lib/release-version.mjs";
import {
  collectDockerAttestationErrors,
  inspectRaw,
  parsePlatform,
  verifyDockerAttestations,
} from "./verify-docker-attestations.mjs";

const ARCHITECTURES = ["amd64", "arm64"];
const SEAL_JOB_NAME = "Seal prepared Docker images";
const WORKFLOW_PATH = ".github/workflows/docker-release-prepare.yml";
const PRODUCER_WORKFLOWS = new Set([
  ".github/workflows/full-release-validation.yml",
  ".github/workflows/openclaw-release-publish.yml",
  ".github/workflows/docker-image-refresh.yml",
  WORKFLOW_PATH,
]);
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";

/**
 * Release commands use explicit argv/options and return UTF-8 stdout.
 * @type {(command: string, args: readonly string[], options: import("node:child_process").ExecFileSyncOptionsWithStringEncoding) => string}
 */
const execReleaseCommand = execFileSync;

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(file) {
  requireValue(lstatSync(file).isFile(), `Expected a regular file: ${file}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  });
}

function ghJson(endpoint) {
  return JSON.parse(
    run("gh", [
      "api",
      endpoint,
      "--method",
      "GET",
      "--jq",
      endpoint.includes("/compare/") ? "{status}" : ".",
    ]),
  );
}

export function dockerReleaseArtifactName(sourceSha, runAttempt) {
  requireValue(
    SHA.test(sourceSha) && POSITIVE_INTEGER.test(String(runAttempt)),
    "Invalid Docker artifact identity.",
  );
  return `docker-release-${sourceSha}-${runAttempt}`;
}

export function preparedDockerEvidenceFromFullRelease({ manifest, sourceSha, runId, runAttempt }) {
  const prepared = manifest.publicationArtifacts?.docker;
  // Historical successful FRV manifests did not prepare publication images.
  // Their recovery route invokes the same preparation owner before publishing.
  if (prepared === undefined) {
    return null;
  }
  requireValue(
    manifest.targetSha === sourceSha &&
      String(manifest.runId) === String(runId) &&
      String(manifest.runAttempt) === String(runAttempt),
    "Docker qualification does not match the selected full release run.",
  );
  requireValue(
    prepared?.preparedRunId === String(runId) &&
      prepared.preparedRunAttempt === String(runAttempt) &&
      prepared.preparedArtifactName === dockerReleaseArtifactName(sourceSha, runAttempt) &&
      /^[a-f0-9]{64}$/u.test(prepared.preparedManifestSha256),
    "Full release Docker qualification tuple is incomplete or stale.",
  );
  return prepared;
}

export function validateDockerReleaseIdentity({
  tag,
  sourceSha,
  imageTagSuffix = "",
  packageVersion,
}) {
  requireValue(SHA.test(sourceSha), "Release SHA must be a full lowercase commit SHA.");
  requireValue(
    imageTagSuffix === "" || /^-r[0-9]{8}$/u.test(imageTagSuffix),
    "Invalid Docker image tag suffix.",
  );
  requireValue(
    typeof tag === "string" && tag.startsWith("v"),
    "Docker releases require a v-prefixed tag.",
  );
  const policy = resolveDockerReleasePolicy(tag.slice(1));
  const baseTag =
    packageVersion === undefined
      ? null
      : resolveReleaseTagPackageIdentity(tag, packageVersion).baseTag;
  return { ...policy, baseTag };
}

/** Verify the OCI closure before smoke testing or registry writes. */
export async function verifyDockerReleaseLayout({
  directory,
  architecture,
  sourceSha,
  version,
  builtAt,
  expectedDigest,
}) {
  requireValue(ARCHITECTURES.includes(architecture), "Unsupported Docker release architecture.");
  requireValue(DIGEST.test(expectedDigest), "Missing BuildKit image digest.");
  requireValue(
    readJson(path.join(directory, "oci-layout")).imageLayoutVersion === "1.0.0",
    "Unsupported OCI layout.",
  );
  const layout = readJson(path.join(directory, "index.json"));
  requireValue(
    layout.manifests?.length === 1 && layout.manifests[0].digest === expectedDigest,
    "OCI layout does not match the BuildKit digest.",
  );
  const verified = new Map();
  async function blob(descriptor, json = false) {
    requireValue(
      DIGEST.test(descriptor?.digest) &&
        Number.isSafeInteger(descriptor.size) &&
        descriptor.size >= 0,
      "Invalid OCI descriptor.",
    );
    const file = path.join(directory, "blobs", "sha256", descriptor.digest.slice(7));
    const stat = lstatSync(file);
    requireValue(
      stat.isFile() && stat.size === descriptor.size,
      `OCI blob size/type mismatch: ${descriptor.digest}`,
    );
    if (!verified.has(descriptor.digest)) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) {
        hash.update(chunk);
      }
      requireValue(
        `sha256:${hash.digest("hex")}` === descriptor.digest,
        `OCI blob digest mismatch: ${descriptor.digest}`,
      );
      verified.set(descriptor.digest, descriptor.size);
    }
    return json ? readJson(file) : undefined;
  }
  const index = await blob(layout.manifests[0], true);
  requireValue(
    index.mediaType === INDEX_MEDIA_TYPE && Array.isArray(index.manifests),
    "Expected an OCI image index with attestations.",
  );
  const manifests = new Map();
  for (const descriptor of index.manifests) {
    const manifest = await blob(descriptor, true);
    await blob(manifest.config);
    requireValue(Array.isArray(manifest.layers), "OCI manifest has no layers.");
    for (const layer of manifest.layers) {
      await blob(layer);
    }
    manifests.set(descriptor.digest, manifest);
  }
  const images = index.manifests.filter(
    (descriptor) =>
      descriptor.platform?.os === "linux" && descriptor.platform?.architecture === architecture,
  );
  requireValue(images.length === 1, `Expected one linux/${architecture} image.`);
  const errors = collectDockerAttestationErrors({
    imageRef: expectedDigest,
    index,
    requiredPlatforms: [parsePlatform(`linux/${architecture}`)],
    inspectAttestation: (digest) => manifests.get(digest),
  });
  requireValue(errors.length === 0, errors.join("\n"));
  const image = manifests.get(images[0].digest);
  const config = await blob(image.config, true);
  const labels = config.config?.Labels;
  requireValue(
    config.os === "linux" &&
      config.architecture === architecture &&
      labels?.["org.opencontainers.image.revision"] === sourceSha &&
      labels?.["org.opencontainers.image.version"] === version &&
      labels?.["org.opencontainers.image.created"] === builtAt,
    "Docker image platform or source/version/build-time labels do not match preparation.",
  );
  return {
    indexDigest: expectedDigest,
    imageDigest: images[0].digest,
    configDigest: image.config.digest,
    manifests: index.manifests,
    bytes: [...verified.values()].reduce((sum, size) => sum + size, 0),
  };
}

const WORKSPACE_SMOKE = `
set -eu
smoke_home="$(mktemp -d)"
smoke_cwd="$(mktemp -d)"
trap 'rm -rf "$smoke_home" "$smoke_cwd"' EXIT
export HOME="$smoke_home" USERPROFILE="$smoke_home" OPENCLAW_HOME="$smoke_home"
export OPENCLAW_NO_ONBOARD=1 OPENCLAW_SUPPRESS_NOTES=1 OPENCLAW_DISABLE_BUNDLED_PLUGINS=1
export OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK=1 AWS_EC2_METADATA_DISABLED=true
export AWS_CONFIG_FILE="$smoke_home/aws-config" AWS_SHARED_CREDENTIALS_FILE="$smoke_home/aws-credentials"
cd "$smoke_cwd"
set +e
smoke_output="$(node /app/openclaw.mjs agent --message "workspace bootstrap smoke" --session-id workspace-bootstrap-smoke --local --timeout 1 --json 2>&1)"
smoke_status=$?
set -e
printf '%s\\n' "$smoke_output"
if printf '%s\\n' "$smoke_output" | grep -q "Missing workspace template:"; then exit 1; fi
if [ "$smoke_status" -ne 0 ]; then echo "Agent exited $smoke_status after workspace bootstrap (provider credentials are intentionally absent)."; fi
`;

function smokeImage(directory, architecture, variant, configDigest) {
  const image = `openclaw-release-smoke:${architecture}-${variant}`;
  // Only the smoke copy enters Docker's single-image store. The OCI artifact
  // retains the original index, SBOM, and provenance for digest-preserving promotion.
  run(
    "skopeo",
    [
      "--override-os",
      "linux",
      "--override-arch",
      architecture,
      "copy",
      `oci:${directory}`,
      `docker-daemon:${image}`,
    ],
    { timeout: 600_000, stdio: "inherit" },
  );
  requireValue(
    run("docker", ["image", "inspect", "--format", "{{.Id}}", image]).trim() === configDigest,
    "Smoke image does not match the prepared OCI image.",
  );
  const script =
    variant === "browser"
      ? String.raw`set -eu; browser="$(find /home/node/.cache/ms-playwright -maxdepth 5 -type f \( -name chrome -o -name chromium -o -name chrome-headless-shell \) -print | head -1)"; test -n "$browser"; "$browser" --version`
      : WORKSPACE_SMOKE;
  run("docker", ["run", "--rm", "--entrypoint", "/bin/sh", image, "-lc", script], {
    timeout: 120_000,
    stdio: "inherit",
  });
}

function releaseContext(env) {
  const job = JSON.parse(env.JOB_CONTEXT ?? "null");
  const policy = validateDockerReleaseIdentity({
    tag: env.RELEASE_TAG,
    sourceSha: env.RELEASE_SHA,
    imageTagSuffix: env.IMAGE_TAG_SUFFIX ?? "",
  });
  requireValue(
    SHA.test(env.GITHUB_WORKFLOW_SHA) &&
      POSITIVE_INTEGER.test(env.GITHUB_RUN_ID) &&
      POSITIVE_INTEGER.test(env.GITHUB_RUN_ATTEMPT),
    "Missing immutable Docker workflow identity.",
  );
  requireValue(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(env.GITHUB_REPOSITORY),
    "Invalid Docker repository.",
  );
  requireValue(
    job?.workflow_sha === env.GITHUB_WORKFLOW_SHA &&
      job.workflow_repository === env.GITHUB_REPOSITORY &&
      job.workflow_file_path === WORKFLOW_PATH &&
      job.workflow_ref?.startsWith(`${env.GITHUB_REPOSITORY}/${WORKFLOW_PATH}@`),
    "Docker preparation must execute its pinned canonical workflow.",
  );
  return {
    schemaVersion: 1,
    repository: env.GITHUB_REPOSITORY,
    sourceSha: env.RELEASE_SHA,
    toolingSha: env.GITHUB_WORKFLOW_SHA,
    tag: env.RELEASE_TAG,
    version: policy.version,
    imageTagSuffix: env.IMAGE_TAG_SUFFIX ?? "",
    builtAt: env.BUILT_AT,
    includeBrowser: env.INCLUDE_BROWSER === "true",
    producer: {
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      workflowRef: env.GITHUB_WORKFLOW_REF,
      workflowSha: env.GITHUB_WORKFLOW_SHA,
      preparationWorkflowRef: job.workflow_ref,
    },
  };
}

async function prepareArchitecture(values, env) {
  const context = releaseContext(env);
  const architecture = values.architecture;
  requireValue(ARCHITECTURES.includes(architecture), "Unsupported preparation architecture.");
  const variants = context.includeBrowser ? ["default", "browser"] : ["default"];
  const images = [];
  for (const variant of variants) {
    const directory = path.join(values.directory, variant);
    const image = await verifyDockerReleaseLayout({
      ...context,
      directory,
      architecture,
      expectedDigest: variant === "default" ? env.DEFAULT_DIGEST : env.BROWSER_DIGEST,
    });
    smokeImage(directory, architecture, variant, image.configDigest);
    images.push({ variant, ...image, smoke: "success", attestations: "success" });
  }
  writeJson(values.output, { ...context, architecture, images });
}

function artifactByName(repository, runId, name, readApi) {
  const result = readApi(
    `repos/${repository}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
  );
  const artifacts = result.artifacts?.filter((artifact) => artifact.name === name) ?? [];
  requireValue(
    artifacts.length === 1 &&
      !artifacts[0].expired &&
      POSITIVE_INTEGER.test(String(artifacts[0].id)) &&
      DIGEST.test(artifacts[0].digest),
    `Missing, expired, or ambiguous Docker artifact: ${name}`,
  );
  return artifacts[0];
}

export function sealDockerRelease({ metadataDirectory, context, checkRunId, readApi = ghJson }) {
  const artifactName = dockerReleaseArtifactName(context.sourceSha, context.producer.runAttempt);
  const architectures = ARCHITECTURES.map((architecture) => {
    const metadata = readJson(path.join(metadataDirectory, `${architecture}.json`));
    for (const key of Object.keys(context)) {
      requireValue(
        JSON.stringify(metadata[key]) === JSON.stringify(context[key]),
        `Docker ${architecture} metadata mismatch: ${key}`,
      );
    }
    requireValue(metadata.architecture === architecture, "Docker architecture metadata mismatch.");
    const artifact = artifactByName(
      context.repository,
      context.producer.runId,
      `${artifactName}-${architecture}`,
      readApi,
    );
    return {
      architecture,
      artifact: {
        id: String(artifact.id),
        name: artifact.name,
        digest: artifact.digest,
        sizeBytes: artifact.size_in_bytes,
      },
      images: metadata.images,
    };
  });
  requireValue(
    POSITIVE_INTEGER.test(String(checkRunId)),
    "Missing Docker seal check-run identity.",
  );
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const result = readApi(
      `repos/${context.repository}/actions/runs/${context.producer.runId}/attempts/${context.producer.runAttempt}/jobs?per_page=100&page=${page}`,
    );
    requireValue(
      Array.isArray(result.jobs) && Number.isSafeInteger(result.total_count),
      "Invalid Docker producer jobs response.",
    );
    jobs.push(
      ...result.jobs.filter(
        (job) =>
          job.check_run_url ===
          `https://api.github.com/repos/${context.repository}/check-runs/${checkRunId}`,
      ),
    );
    if (page * 100 >= result.total_count) {
      break;
    }
  }
  requireValue(
    jobs.length === 1 &&
      (jobs[0].name === SEAL_JOB_NAME || jobs[0].name.endsWith(` / ${SEAL_JOB_NAME}`)),
    "Cannot resolve the exact Docker seal job.",
  );
  const manifest = {
    ...context,
    producer: { ...context.producer, jobId: String(jobs[0].id), jobName: jobs[0].name },
    artifactName,
    architectures,
  };
  validateDockerReleaseManifest(manifest, {
    ...context,
    artifactName,
    runId: context.producer.runId,
    runAttempt: context.producer.runAttempt,
  });
  return manifest;
}

export function validateDockerReleaseManifest(manifest, expected) {
  const policy = validateDockerReleaseIdentity({
    tag: expected.tag,
    sourceSha: expected.sourceSha,
    imageTagSuffix: expected.imageTagSuffix ?? "",
  });
  const artifactName = dockerReleaseArtifactName(expected.sourceSha, expected.runAttempt);
  requireValue(
    manifest.schemaVersion === 1 &&
      manifest.repository === expected.repository &&
      manifest.sourceSha === expected.sourceSha &&
      manifest.tag === expected.tag &&
      manifest.version === policy.version &&
      manifest.imageTagSuffix === (expected.imageTagSuffix ?? "") &&
      manifest.artifactName === artifactName &&
      expected.artifactName === artifactName,
    "Prepared Docker manifest does not match the release.",
  );
  requireValue(
    SHA.test(manifest.toolingSha) &&
      manifest.producer?.workflowSha === manifest.toolingSha &&
      manifest.producer.runId === String(expected.runId) &&
      manifest.producer.runAttempt === String(expected.runAttempt) &&
      POSITIVE_INTEGER.test(manifest.producer.jobId) &&
      (manifest.producer.jobName === SEAL_JOB_NAME ||
        manifest.producer.jobName?.endsWith(` / ${SEAL_JOB_NAME}`)),
    "Prepared Docker producer identity mismatch.",
  );
  requireValue(
    typeof manifest.includeBrowser === "boolean" &&
      typeof manifest.builtAt === "string" &&
      Number.isFinite(Date.parse(manifest.builtAt)),
    "Invalid Docker build context.",
  );
  requireValue(
    expected.includeBrowser === undefined || manifest.includeBrowser === expected.includeBrowser,
    "Prepared Docker browser support differs from the finalized source.",
  );
  requireValue(
    Array.isArray(manifest.architectures) && manifest.architectures.length === ARCHITECTURES.length,
    "Prepared Docker release must include both native architectures.",
  );
  for (const [index, architecture] of ARCHITECTURES.entries()) {
    const entry = manifest.architectures[index];
    requireValue(
      entry.architecture === architecture &&
        entry.artifact?.name === `${artifactName}-${architecture}` &&
        POSITIVE_INTEGER.test(entry.artifact.id) &&
        DIGEST.test(entry.artifact.digest),
      "Prepared Docker payload identity mismatch.",
    );
    const variants = manifest.includeBrowser ? ["default", "browser"] : ["default"];
    requireValue(
      Array.isArray(entry.images) && entry.images.length === variants.length,
      "Prepared Docker variants are incomplete.",
    );
    for (const [imageIndex, variant] of variants.entries()) {
      const image = entry.images[imageIndex];
      requireValue(
        image.variant === variant &&
          image.smoke === "success" &&
          image.attestations === "success" &&
          [image.indexDigest, image.imageDigest, image.configDigest].every((digest) =>
            DIGEST.test(digest),
          ) &&
          Array.isArray(image.manifests),
        "Prepared Docker image proof is incomplete.",
      );
    }
  }
  return manifest;
}

function verifyDockerProducerRun(runInfo, manifest, runAttempt) {
  const { repository, toolingSha, producer } = manifest;
  const workflowPath = String(runInfo.path).split("@", 1)[0];
  const prefix = `${repository}/${workflowPath}@`;
  requireValue(
    PRODUCER_WORKFLOWS.has(workflowPath) && producer.workflowRef?.startsWith(prefix),
    "Untrusted Docker producer workflow.",
  );
  const fullRef = producer.workflowRef.slice(prefix.length);
  requireValue(
    /^refs\/(heads|tags)\/.+$/u.test(fullRef) &&
      runInfo.head_branch === fullRef.replace(/^refs\/(heads|tags)\//u, ""),
    "Docker producer ref mismatch.",
  );
  const trustedEvent =
    runInfo.event === "workflow_dispatch" ||
    (workflowPath === ".github/workflows/docker-image-refresh.yml" &&
      runInfo.event === "schedule" &&
      fullRef === "refs/heads/main");
  requireValue(
    String(runInfo.id) === producer.runId &&
      String(runInfo.run_attempt) === runAttempt &&
      runInfo.head_sha === toolingSha &&
      runInfo.repository?.full_name === repository &&
      runInfo.head_repository?.full_name === repository &&
      trustedEvent,
    "Docker producer run/attempt/source mismatch.",
  );
  return { workflowPath, fullRef };
}

/** Preparation belongs to its exact successful seal job. A publisher retry
 * advances the parent attempt without rebuilding that immutable payload. */
export function verifyDockerReleaseProducer(
  manifest,
  { publisherSha, publisherRunId = "", publisherRunAttempt = "", readApi = ghJson },
) {
  const { repository, toolingSha, producer } = manifest;
  requireValue(SHA.test(publisherSha), "Invalid Docker publisher tooling SHA.");
  const currentRun = readApi(`repos/${repository}/actions/runs/${producer.runId}`);
  const currentAttempt = String(currentRun.run_attempt);
  requireValue(
    POSITIVE_INTEGER.test(currentAttempt) && BigInt(currentAttempt) >= BigInt(producer.runAttempt),
    "Docker producer attempt is not available.",
  );
  const { workflowPath, fullRef } = verifyDockerProducerRun(currentRun, manifest, currentAttempt);
  requireValue(
    (currentRun.status === "completed" && currentRun.conclusion === "success") ||
      (currentRun.status === "in_progress" && currentRun.conclusion === null),
    "Docker producer is neither active nor successfully completed.",
  );
  let preparedRun = currentRun;
  if (currentAttempt !== producer.runAttempt) {
    preparedRun = readApi(
      `repos/${repository}/actions/runs/${producer.runId}/attempts/${producer.runAttempt}`,
    );
    verifyDockerProducerRun(preparedRun, manifest, producer.runAttempt);
    // Failed publication may reuse its own successful seal; unrelated publishers
    // still require a successful producer parent, even when that run is retried.
    const resumingOwnPublication =
      producer.runId === publisherRunId &&
      currentAttempt === publisherRunAttempt &&
      currentRun.head_sha === publisherSha &&
      currentRun.status === "in_progress" &&
      preparedRun.status === "completed" &&
      ["failure", "cancelled", "timed_out"].includes(preparedRun.conclusion);
    requireValue(
      (preparedRun.status === "completed" && preparedRun.conclusion === "success") ||
        resumingOwnPublication,
      "Historical Docker producer did not qualify for this publication.",
    );
  }
  // Preparation linkage belongs to its recorded attempt; a publisher-only retry
  // need not list that completed reusable workflow in its current attempt.
  requireValue(
    producer.preparationWorkflowRef === `${repository}/${WORKFLOW_PATH}@${fullRef}` &&
      (workflowPath === WORKFLOW_PATH ||
        preparedRun.referenced_workflows?.some(
          (workflow) =>
            workflow.path === `${repository}/${WORKFLOW_PATH}@${toolingSha}` &&
            workflow.sha === toolingSha &&
            workflow.ref === fullRef,
        )),
    "Docker producer did not execute the pinned preparation workflow.",
  );
  const sealJob = readApi(`repos/${repository}/actions/jobs/${producer.jobId}`);
  requireValue(
    String(sealJob.id) === producer.jobId &&
      String(sealJob.run_id) === producer.runId &&
      String(sealJob.run_attempt) === producer.runAttempt &&
      sealJob.name === producer.jobName &&
      sealJob.status === "completed" &&
      sealJob.conclusion === "success" &&
      sealJob.head_sha === toolingSha,
    "Exact Docker preparation job has not completed successfully.",
  );
  for (const target of new Set(["main", publisherSha])) {
    const comparison = readApi(`repos/${repository}/compare/${toolingSha}...${target}`);
    requireValue(
      comparison.status === "ahead" || comparison.status === "identical",
      `Docker producer tooling is not on ${target} ancestry.`,
    );
  }
  for (const entry of manifest.architectures) {
    const artifact = artifactByName(repository, producer.runId, entry.artifact.name, readApi);
    requireValue(
      String(artifact.id) === entry.artifact.id &&
        artifact.digest === entry.artifact.digest &&
        artifact.workflow_run?.id === Number(producer.runId) &&
        artifact.workflow_run?.head_sha === toolingSha,
      "Prepared Docker payload artifact changed.",
    );
  }
  return manifest;
}

function loadPreparedManifest(values, env) {
  const bytes = readFileSync(values.manifest);
  requireValue(
    /^[a-f0-9]{64}$/u.test(values["manifest-sha256"]) &&
      sha256(bytes) === values["manifest-sha256"],
    "Prepared Docker manifest digest mismatch.",
  );
  const manifest = validateDockerReleaseManifest(JSON.parse(bytes), {
    repository: env.GITHUB_REPOSITORY,
    sourceSha: env.RELEASE_SHA,
    tag: env.RELEASE_TAG,
    imageTagSuffix: env.IMAGE_TAG_SUFFIX ?? "",
    includeBrowser: env.INCLUDE_BROWSER === "true",
    artifactName: values["artifact-name"],
    runId: values["run-id"],
    runAttempt: values["run-attempt"],
  });
  return verifyDockerReleaseProducer(manifest, {
    publisherSha: env.GITHUB_WORKFLOW_SHA,
    publisherRunId: env.GITHUB_RUN_ID,
    publisherRunAttempt: env.GITHUB_RUN_ATTEMPT,
  });
}

function verifyFinalTag(manifest, readApi = ghJson) {
  let object = readApi(`repos/${manifest.repository}/git/ref/tags/${manifest.tag}`).object;
  for (let depth = 0; object?.type === "tag" && depth < 5; depth += 1) {
    object = readApi(`repos/${manifest.repository}/git/tags/${object.sha}`).object;
  }
  requireValue(
    object?.type === "commit" && object.sha === manifest.sourceSha,
    "Finalized Docker release tag moved or does not match prepared source.",
  );
}

function verifyRemoteDigest(ref, expectedDigest, execFileSyncImpl) {
  requireValue(
    resolveRemoteDigest(ref, execFileSyncImpl) === expectedDigest,
    `Registry did not preserve the prepared digest: ${ref}`,
  );
}

function resolveRemoteDigest(ref, execFileSyncImpl) {
  const metadata = JSON.parse(
    execFileSyncImpl(
      "docker",
      ["buildx", "imagetools", "inspect", ref, "--format", "{{json .Manifest}}"],
      {
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 20 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  requireValue(DIGEST.test(metadata.digest), `Missing registry digest: ${ref}`);
  return metadata.digest;
}

export async function publishDockerRelease({
  manifest,
  payloadDirectory,
  images,
  execFileSyncImpl = execReleaseCommand,
  verifyTag = verifyFinalTag,
  promote = promoteDockerChannel,
}) {
  const prepared = [];
  // Verify every payload before the first registry mutation, including siblings.
  for (const entry of manifest.architectures) {
    for (const image of entry.images) {
      const directory = path.join(payloadDirectory, entry.artifact.name, image.variant);
      const verified = await verifyDockerReleaseLayout({
        ...manifest,
        directory,
        architecture: entry.architecture,
        expectedDigest: image.indexDigest,
      });
      requireValue(
        verified.imageDigest === image.imageDigest &&
          verified.configDigest === image.configDigest &&
          JSON.stringify(verified.manifests) === JSON.stringify(image.manifests),
        "Prepared OCI image proof changed.",
      );
      prepared.push({ ...image, architecture: entry.architecture, directory });
    }
  }
  verifyTag(manifest);
  const execute = (command, args) =>
    execFileSyncImpl(command, args, {
      encoding: "utf8",
      timeout: 1_200_000,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 20 * 1024 * 1024,
    });
  const version = `${manifest.version}${manifest.imageTagSuffix}`;
  for (const image of prepared) {
    const suffix = image.variant === "default" ? "" : "-browser";
    for (const registry of images) {
      const ref = `${registry}:${version}${suffix}-${image.architecture}`;
      execute("skopeo", [
        "copy",
        "--all",
        "--preserve-digests",
        `oci:${image.directory}`,
        `docker://${ref}`,
      ]);
      verifyRemoteDigest(ref, image.indexDigest, execFileSyncImpl);
      if (image.variant === "default") {
        const slim = `${registry}:${version}-slim-${image.architecture}`;
        execute("docker", [
          "buildx",
          "imagetools",
          "create",
          "--prefer-index=false",
          "--tag",
          slim,
          `${registry}@${image.indexDigest}`,
        ]);
        verifyRemoteDigest(slim, image.indexDigest, execFileSyncImpl);
      }
    }
  }
  const sourceDigests = [];
  for (const variant of manifest.includeBrowser ? ["default", "browser"] : ["default"]) {
    const selected = prepared.filter((image) => image.variant === variant);
    const suffixes = variant === "default" ? ["", "-slim"] : ["-browser"];
    for (const [registryIndex, registry] of images.entries()) {
      const tags = suffixes.map((suffix) => `${registry}:${version}${suffix}`);
      execute("docker", [
        "buildx",
        "imagetools",
        "create",
        ...tags.flatMap((tag) => ["--tag", tag]),
        ...selected.map((image) => `${registry}@${image.indexDigest}`),
      ]);
      const combinedDigest = resolveRemoteDigest(tags[0], execFileSyncImpl);
      const raw = inspectRaw(`${registry}@${combinedDigest}`, { execFileSyncImpl });
      const combined = JSON.parse(raw);
      const byDigest = (left, right) => left.digest.localeCompare(right.digest);
      const expectedDescriptors = selected.flatMap((image) => image.manifests).toSorted(byDigest);
      requireValue(
        Array.isArray(combined.manifests) &&
          isDeepStrictEqual(combined.manifests.toSorted(byDigest), expectedDescriptors),
        "Published multiarch index changed image or attestation descriptors.",
      );
      for (const tag of tags.slice(1)) {
        verifyRemoteDigest(tag, combinedDigest, execFileSyncImpl);
      }
      verifyDockerAttestations({
        imageRefs: [`${registry}@${combinedDigest}`],
        requiredPlatforms: ARCHITECTURES.map((architecture) =>
          parsePlatform(`linux/${architecture}`),
        ),
        execFileSyncImpl,
      });
      if (registryIndex === 0) {
        for (const suffix of suffixes) {
          sourceDigests.push(`${suffix === "" ? "default" : suffix.slice(1)}=${combinedDigest}`);
        }
      }
    }
  }
  if (resolveDockerReleasePolicy(manifest.version).channel !== "beta") {
    verifyTag(manifest);
    promote(
      {
        version: manifest.version,
        imageTagSuffix: manifest.imageTagSuffix,
        images,
        includeBrowser: manifest.includeBrowser,
      },
      { execFileSyncImpl },
    );
  }
  return sourceDigests.join("\n");
}

async function main() {
  const command = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: Object.fromEntries(
      [
        "directory",
        "architecture",
        "output",
        "manifest",
        "manifest-sha256",
        "artifact-name",
        "run-id",
        "run-attempt",
      ].map((key) => [key, { type: "string" }]),
    ),
  });
  const env = process.env;
  if (command === "prepare") {
    await prepareArchitecture(values, env);
  } else if (command === "seal") {
    const manifest = sealDockerRelease({
      metadataDirectory: values.directory,
      context: releaseContext(env),
      checkRunId: env.SEAL_CHECK_RUN_ID,
    });
    writeJson(values.output, manifest);
    appendFileSync(env.GITHUB_OUTPUT, `manifest_sha256=${sha256(readFileSync(values.output))}\n`);
  } else if (command === "verify" || command === "publish") {
    const manifest = loadPreparedManifest(values, env);
    if (command === "verify") {
      appendFileSync(
        env.GITHUB_OUTPUT,
        `artifact_ids=${manifest.architectures.map((entry) => entry.artifact.id).join(",")}\n`,
      );
    }
    if (command === "publish") {
      const started = Date.now();
      const sourceDigests = await publishDockerRelease({
        manifest,
        payloadDirectory: values.directory,
        images: [`ghcr.io/${env.GITHUB_REPOSITORY.toLowerCase()}`, "docker.io/openclaw/openclaw"],
      });
      appendFileSync(env.GITHUB_OUTPUT, `vcr_source_digests<<EOF\n${sourceDigests}\nEOF\n`);
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `Docker digest promotion completed in ${Math.round((Date.now() - started) / 1000)} seconds. Prepared payload bytes: ${manifest.architectures.reduce((sum, entry) => sum + entry.artifact.sizeBytes, 0)}.\n`,
      );
    }
  } else {
    throw new Error("Usage: docker-release-artifacts.mjs prepare|seal|verify|publish [options]");
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  main().catch((/** @type {unknown} */ error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
