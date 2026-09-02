#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  downloadActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
  readBoundedRegularFile,
  validateActionsArtifactBinding,
  validateActionsArtifactProducerJob,
} from "./lib/actions-artifact-archive.mjs";
import {
  fetchNpmRegistryPackumentWithRetry,
  fetchNpmRegistryTarballWithRetry,
  resolveNpmPublishPlan,
} from "./lib/npm-publish-plan.mjs";
import { collectExtensionPackageJsonCandidates } from "./lib/plugin-publication-candidates.ts";
import { isPluginPublicationEnabled } from "./lib/plugin-publication-target.mjs";
import { verifyPluginPublicationArtifact } from "./plugin-publication-artifact.mjs";

export const PREPARED_NPM_MANIFEST = "plugin-npm-prepared.json";
const SCHEMA = "openclaw.plugin-npm-prepared/v1";
const WORKFLOW_PATH = ".github/workflows/plugin-npm-release.yml";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const ROUTES = new Set(["npm-oidc", "npm-token-bootstrap", "npm-readback"]);

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(file, maxBytes = MAX_MANIFEST_BYTES) {
  return JSON.parse(readBoundedRegularFile(file, { label: file, maxBytes }).toString("utf8"));
}

function normalizeProducer(value) {
  requireValue(
    value?.workflowPath === WORKFLOW_PATH &&
      value.workflowEvent === "workflow_dispatch" &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository ?? "") &&
      SHA.test(value.workflowSha ?? "") &&
      Number.isSafeInteger(value.runId) &&
      value.runId > 0 &&
      Number.isSafeInteger(value.runAttempt) &&
      value.runAttempt > 0 &&
      typeof value.workflowHeadBranch === "string" &&
      /^(?:main|release\/[0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*|extended-stable\/[0-9]{4}\.[1-9][0-9]*\.33|release-publish\/[a-f0-9]{12}-[1-9][0-9]*)$/u.test(
        value.workflowHeadBranch,
      ),
    "Prepared npm producer must bind an exact trusted workflow run and attempt.",
  );
  return {
    repository: value.repository,
    runId: value.runId,
    runAttempt: value.runAttempt,
    workflowPath: value.workflowPath,
    workflowEvent: value.workflowEvent,
    workflowHeadBranch: value.workflowHeadBranch,
    workflowSha: value.workflowSha,
  };
}

function normalizePackage(value, npmDistTag) {
  requireValue(
    /^[a-z0-9][a-z0-9._-]*$/u.test(value?.extensionId ?? "") &&
      value.packageDir === `extensions/${value.extensionId}` &&
      PACKAGE.test(value.packageName ?? "") &&
      typeof value.installNpmSpec === "string" &&
      value.installNpmSpec.length > 0 &&
      !/[\s\p{Cc}]/u.test(value.installNpmSpec),
    "Prepared npm package identity is invalid.",
  );
  const plan = resolveNpmPublishPlan(
    value.version,
    undefined,
    npmDistTag === "default" ? undefined : npmDistTag,
  );
  requireValue(
    value.channel === plan.channel && value.publishTag === plan.publishTag,
    "Prepared npm package channel differs from its version.",
  );
  return {
    extensionId: value.extensionId,
    packageDir: value.packageDir,
    packageName: value.packageName,
    version: value.version,
    channel: value.channel,
    publishTag: value.publishTag,
    installNpmSpec: value.installNpmSpec,
  };
}

function artifactTuple(metadata, producer) {
  requireValue(
    Number.isSafeInteger(metadata.id) &&
      metadata.id > 0 &&
      typeof metadata.name === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(metadata.name) &&
      DIGEST.test(metadata.digest ?? "") &&
      Number.isSafeInteger(metadata.size_in_bytes) &&
      metadata.size_in_bytes > 0 &&
      metadata.size_in_bytes <= MAX_PACKAGE_BYTES,
    "Prepared npm artifact identity is invalid.",
  );
  return {
    ...producer,
    artifactId: metadata.id,
    artifactName: metadata.name,
    artifactDigest: metadata.digest,
    artifactSizeBytes: metadata.size_in_bytes,
  };
}

function packageArtifactName(entry, route, producer) {
  return `plugin-npm-package-${entry.extensionId}-${entry.version}-${route}-${producer.runId}-${producer.runAttempt}`;
}

export function preparedNpmArtifactName(sourceSha, producer) {
  requireValue(SHA.test(sourceSha), "Prepared npm source must be a full lowercase SHA.");
  const identity = normalizeProducer(producer);
  return `plugin-npm-prepared-${sourceSha}-${identity.runId}-${identity.runAttempt}`;
}

function sourcePackageRoster(sourceRoot, npmDistTag, selectedNames) {
  return collectExtensionPackageJsonCandidates(sourceRoot)
    .filter(({ packageJson }) => isPluginPublicationEnabled(packageJson, "npm"))
    .filter(
      ({ packageJson }) =>
        selectedNames.length === 0 || selectedNames.includes(packageJson.name?.trim()),
    )
    .map(({ extensionId, packageDir, packageJson }) => {
      const plan = resolveNpmPublishPlan(
        packageJson.version,
        undefined,
        npmDistTag === "default" ? undefined : npmDistTag,
      );
      return normalizePackage(
        {
          extensionId,
          packageDir,
          packageName: packageJson.name?.trim(),
          version: packageJson.version?.trim(),
          channel: plan.channel,
          publishTag: plan.publishTag,
          installNpmSpec: packageJson.openclaw?.install?.npmSpec?.trim(),
        },
        npmDistTag,
      );
    })
    .toSorted((a, b) =>
      a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0,
    );
}

export function validatePreparedNpmRelease(manifest, expected) {
  const producer = normalizeProducer(manifest?.producer);
  requireValue(
    manifest.schema === SCHEMA &&
      manifest.runtimeQualification === "packed-runtime-v1" &&
      SHA.test(manifest.sourceSha ?? "") &&
      manifest.sourceSha === expected.sourceSha &&
      manifest.npmDistTag === expected.npmDistTag &&
      ["default", "extended-stable"].includes(manifest.npmDistTag) &&
      manifest.selectionMode === expected.selectionMode &&
      ["selected", "all-publishable"].includes(manifest.selectionMode) &&
      manifest.publisherPolicySha256 === expected.publisherPolicySha256 &&
      /^[a-f0-9]{64}$/u.test(manifest.publisherPolicySha256 ?? "") &&
      producer.repository === expected.repository &&
      producer.workflowSha === expected.workflowSha,
    "Prepared npm release differs from the approved source, tooling, selection, or channel.",
  );
  requireValue(
    Array.isArray(manifest.packages) &&
      manifest.packages.length > 0 &&
      manifest.packages.length <= 256,
    "Prepared npm release must contain the complete non-empty package roster.",
  );
  const names = new Set();
  const artifacts = new Set();
  const packages = manifest.packages.map((value) => {
    const entry = normalizePackage(value, manifest.npmDistTag);
    const tuple = value.artifact;
    requireValue(
      ROUTES.has(value.route),
      "Prepared npm route requires separately authorized repair tooling.",
    );
    requireValue(
      value.route !== "npm-token-bootstrap" || entry.channel === "beta",
      "Prepared npm token bootstrap requires an approved beta package.",
    );
    requireValue(
      JSON.stringify(normalizeProducer(tuple)) === JSON.stringify(producer),
      "Prepared npm package producer differs from the sealed release.",
    );
    const normalizedTuple = artifactTuple(
      {
        id: tuple.artifactId,
        name: tuple.artifactName,
        digest: tuple.artifactDigest,
        size_in_bytes: tuple.artifactSizeBytes,
      },
      producer,
    );
    requireValue(
      normalizedTuple.artifactName === packageArtifactName(entry, value.route, producer),
      "Prepared npm package artifact does not bind its exact producer attempt.",
    );
    requireValue(
      !names.has(entry.packageName) && !artifacts.has(tuple.artifactId),
      "Prepared npm release contains duplicate packages or artifacts.",
    );
    names.add(entry.packageName);
    artifacts.add(tuple.artifactId);
    return { ...entry, route: value.route, artifact: normalizedTuple };
  });
  const selected = (expected.plugins ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .toSorted();
  if (manifest.selectionMode === "all-publishable") {
    requireValue(
      selected.length === 0,
      "All-publishable prepared npm release must not narrow the roster.",
    );
  } else {
    requireValue(
      JSON.stringify(selected) ===
        JSON.stringify([...names].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))),
      "Prepared npm package roster differs from the requested selection.",
    );
  }
  if (expected.sourceRoot !== undefined) {
    const sourcePackages = sourcePackageRoster(expected.sourceRoot, manifest.npmDistTag, selected);
    requireValue(
      JSON.stringify(sourcePackages) ===
        JSON.stringify(packages.map((entry) => normalizePackage(entry, manifest.npmDistTag))),
      "Prepared npm roster differs from the complete selected frozen-source roster.",
    );
  }
  return { ...manifest, producer, packages };
}

export function createPreparedNpmRelease(params) {
  const producer = normalizeProducer(params.producer);
  const packages = params.matrix
    .map((value) => {
      const entry = normalizePackage(value, params.npmDistTag);
      const matches = params.artifacts.filter((artifact) =>
        [...ROUTES].some((route) => artifact.name === packageArtifactName(entry, route, producer)),
      );
      requireValue(
        matches.length === 1,
        `Expected one qualified npm artifact for ${entry.packageName}.`,
      );
      const [metadata] = matches;
      const route = [...ROUTES].find(
        (candidate) => metadata.name === packageArtifactName(entry, candidate, producer),
      );
      const artifact = artifactTuple(metadata, producer);
      const expected = {
        ...artifact,
        runStatePolicy: "same-run-producer-success",
        consumerRunAttempt: producer.runAttempt,
        producerJobName: `Preflight plugin npm package (${entry.packageName})`,
      };
      validateActionsArtifactBinding({
        artifactMetadata: metadata,
        expected,
        workflowRun: params.workflowRun,
      });
      validateActionsArtifactProducerJob({ expected, workflowJobs: params.workflowJobs });
      return { ...entry, route, artifact };
    })
    .toSorted((a, b) =>
      a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0,
    );
  return validatePreparedNpmRelease(
    {
      schema: SCHEMA,
      runtimeQualification: "packed-runtime-v1",
      sourceSha: params.sourceSha,
      npmDistTag: params.npmDistTag,
      selectionMode: params.selectionMode,
      publisherPolicySha256: params.publisherPolicySha256,
      producer,
      packages,
    },
    { ...params, repository: producer.repository, workflowSha: producer.workflowSha },
  );
}

export async function downloadPreparedNpmRelease(params) {
  requireValue(
    typeof params.sourceRoot === "string",
    "Prepared npm admission requires the frozen source root.",
  );
  const producer = normalizeProducer(params.artifact);
  requireValue(
    producer.repository === params.repository &&
      producer.workflowSha === params.workflowSha &&
      params.artifact.artifactName === preparedNpmArtifactName(params.sourceSha, producer),
    "Prepared npm manifest artifact differs from the approved producer.",
  );
  const downloaded = await downloadActionsArtifactArchive({
    token: params.token,
    fetchImpl: params.fetchImpl,
    expected: { ...params.artifact, runStatePolicy: "completed-success" },
    archivePath: params.archivePath,
    maxArchiveBytes: MAX_MANIFEST_BYTES,
  });
  const files = inspectActionsArtifactZipWithPolicy(downloaded.archiveBytes, {
    minEntries: 1,
    maxEntries: 1,
    maxArchiveBytes: MAX_MANIFEST_BYTES,
    maxExpandedBytes: MAX_MANIFEST_BYTES,
    maxEntryBytes: () => MAX_MANIFEST_BYTES,
    allowPath: (name) => name === PREPARED_NPM_MANIFEST,
  });
  const manifest = validatePreparedNpmRelease(
    JSON.parse(files.get(PREPARED_NPM_MANIFEST).toString("utf8")),
    params,
  );
  requireValue(
    JSON.stringify(manifest.producer) === JSON.stringify(producer),
    "Prepared npm manifest producer differs from its artifact.",
  );
  return manifest;
}

export async function consumePreparedNpmPackage(params) {
  const entry = params.package;
  const producer = normalizeProducer(entry.artifact);
  normalizePackage(entry, params.npmDistTag);
  requireValue(
    producer.repository === params.repository &&
      producer.workflowSha === params.workflowSha &&
      ROUTES.has(entry.route) &&
      entry.artifact.artifactName === packageArtifactName(entry, entry.route, producer),
    "Prepared npm package differs from the approved publication identity.",
  );
  const cacheDir = resolve(params.cacheDir);
  mkdirSync(cacheDir, { recursive: true });
  const archivePath = join(cacheDir, `${entry.artifact.artifactId}.zip`);
  const downloaded = await downloadActionsArtifactArchive({
    token: params.token,
    fetchImpl: params.fetchImpl,
    expected: { ...entry.artifact, runStatePolicy: "completed-success" },
    archivePath,
  });
  const metadataPath = join(cacheDir, `${entry.artifact.artifactId}.metadata.json`);
  const runPath = join(cacheDir, `${entry.artifact.artifactId}.run.json`);
  writeFileSync(metadataPath, JSON.stringify(downloaded.artifactMetadata));
  writeFileSync(runPath, JSON.stringify(downloaded.workflowRun));
  return verifyPluginPublicationArtifact({
    ...entry.artifact,
    artifactMetadataPath: metadataPath,
    artifactZipPath: archivePath,
    workflowRunMetadataPath: runPath,
    runStatePolicy: "completed-success",
    packageDir: entry.packageDir,
    packageName: entry.packageName,
    version: entry.version,
    publishTag: entry.publishTag,
    route: entry.route,
    targetSha: params.sourceSha,
    publicationReason: `Stable npm registry preflight selected ${entry.route}.`,
    publisherPolicy: {
      policyId: "plugin-npm-release-workflow",
      schema: "openclaw.plugin-npm-publisher-policy/v1",
      sha256: params.publisherPolicySha256,
    },
    sourcePackageJsonSha256: sha256(
      readBoundedRegularFile(params.sourcePackageJson, {
        label: "source package.json",
        maxBytes: MAX_MANIFEST_BYTES,
      }),
    ),
    outputDir: params.outputDir,
  });
}

export async function verifyPreparedNpmRegistry(params) {
  const tarball = readBoundedRegularFile(params.tarballPath, {
    label: "qualified plugin tarball",
    maxBytes: MAX_PACKAGE_BYTES,
  });
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  const shasum = createHash("sha1").update(tarball).digest("hex");
  requireValue(
    PACKAGE.test(params.packageName) && ROUTES.has(params.route),
    "Invalid prepared npm publication request.",
  );
  const registry = await fetchNpmRegistryPackumentWithRetry({
    packageName: params.packageName,
    packageUrl: `https://registry.npmjs.org/${encodeURIComponent(params.packageName)}`,
    fetchImpl: params.fetchImpl,
  });
  requireValue(
    registry.status === 404 || registry.ok,
    `npm registry returned HTTP ${registry.status}.`,
  );
  if (registry.ok) {
    requireValue(
      registry.packument?.name === params.packageName &&
        registry.packument.versions &&
        typeof registry.packument.versions === "object" &&
        !Array.isArray(registry.packument.versions) &&
        registry.packument["dist-tags"] &&
        typeof registry.packument["dist-tags"] === "object" &&
        !Array.isArray(registry.packument["dist-tags"]),
      "npm registry response is not an authoritative package inventory.",
    );
  }
  const version = registry.packument?.versions?.[params.version];
  if (!version) {
    if (params.allowMissing !== true && (params.remainingReadbacks ?? 5) > 0) {
      // npm replication can lag an accepted publish; conflicts never enter this retry.
      await delay(5_000);
      return verifyPreparedNpmRegistry({
        ...params,
        remainingReadbacks: (params.remainingReadbacks ?? 5) - 1,
      });
    }
    requireValue(
      params.allowMissing === true && params.route !== "npm-readback",
      `${params.packageName}@${params.version}: exact version is not visible yet; verification pending. Retry readback, not publication.`,
    );
    requireValue(
      registry.status !== 404 || params.route === "npm-token-bootstrap",
      "Prepared OIDC package no longer exists; obtain an explicitly approved bootstrap.",
    );
    return { alreadyPublished: false };
  }
  requireValue(
    version.name === params.packageName && version.version === params.version,
    "npm registry version identity differs from the qualified package.",
  );
  requireValue(
    version.dist?.integrity === integrity && version.dist?.shasum === shasum,
    `${params.packageName}@${params.version}: registry bytes conflict with the qualified artifact.`,
  );
  const url = new URL(version.dist.tarball);
  requireValue(
    url.origin === "https://registry.npmjs.org" && !url.username && !url.password,
    "Prepared npm readback requires the canonical registry tarball URL.",
  );
  const published = await fetchNpmRegistryTarballWithRetry({
    packageName: params.packageName,
    packageUrl: url.href,
    maxBytes: tarball.length,
    fetchImpl: params.fetchImpl,
  });
  requireValue(
    published.length === tarball.length && sha256(published) === sha256(tarball),
    "Published npm tarball bytes differ from the qualified artifact.",
  );
  requireValue(
    registry.packument["dist-tags"]?.[params.publishTag] === params.version,
    `${params.packageName}: ${params.publishTag} differs from the prepared version; use authorized tag repair.`,
  );
  return { alreadyPublished: true };
}

function outputValues(file, values) {
  writeFileSync(
    file,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    { flag: "a" },
  );
}

async function main(argv) {
  const [command, ...args] = argv;
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    requireValue(
      key?.startsWith("--") && args[index + 1] !== undefined && !Object.hasOwn(options, key),
      "Invalid prepared npm arguments.",
    );
    options[key] = args[index + 1];
  }
  const common = {
    repository: process.env.GITHUB_REPOSITORY,
    workflowSha: process.env.GITHUB_SHA,
    sourceSha: options["--source-sha"],
    npmDistTag: options["--npm-dist-tag"] ?? "default",
    selectionMode: options["--selection-mode"],
    plugins: options["--plugins"] ?? "",
    publisherPolicySha256: options["--policy-file"]
      ? sha256(readFileSync(options["--policy-file"]))
      : undefined,
    token: process.env.GH_TOKEN,
  };
  if (command === "seal") {
    const producer = {
      repository: common.repository,
      runId: Number(process.env.GITHUB_RUN_ID),
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      workflowPath: WORKFLOW_PATH,
      workflowEvent: process.env.GITHUB_EVENT_NAME,
      workflowHeadBranch: process.env.GITHUB_REF_NAME,
      workflowSha: common.workflowSha,
    };
    const manifest = createPreparedNpmRelease({
      ...common,
      producer,
      matrix: JSON.parse(process.env.PLUGIN_MATRIX),
      artifacts: readJson(options["--artifacts-file"], 4 * MAX_MANIFEST_BYTES).artifacts,
      workflowRun: readJson(options["--run-file"]),
      workflowJobs: readJson(options["--jobs-file"], 4 * MAX_MANIFEST_BYTES),
    });
    mkdirSync(options["--output-dir"], { recursive: true });
    writeFileSync(
      join(options["--output-dir"], PREPARED_NPM_MANIFEST),
      `${JSON.stringify(manifest)}\n`,
    );
    outputValues(options["--github-output"], {
      artifact_name: preparedNpmArtifactName(common.sourceSha, producer),
    });
  } else if (command === "load") {
    const manifest = await downloadPreparedNpmRelease({
      ...common,
      sourceRoot: options["--source-root"] ?? process.cwd(),
      artifact: JSON.parse(options["--artifact"]),
      archivePath: options["--archive-path"],
    });
    writeFileSync(options["--output"], JSON.stringify(manifest));
    outputValues(options["--github-output"], {
      has_candidates: true,
      has_selection: true,
      candidate_count: manifest.packages.length,
      selection_count: manifest.packages.length,
      matrix: JSON.stringify(manifest.packages),
      all_matrix: JSON.stringify(manifest.packages),
    });
  } else if (command === "consume") {
    const result = await consumePreparedNpmPackage({
      ...common,
      package: JSON.parse(options["--package"]),
      sourcePackageJson: options["--source-package-json"],
      cacheDir: options["--cache-dir"],
      outputDir: options["--output-dir"],
    });
    outputValues(options["--github-output"], {
      package_name: result.manifest.package.name,
      package_version: result.manifest.package.version,
      publish_route: result.manifest.publication.route,
      publish_tag: result.manifest.publication.tag,
      tarball_path: result.tarballPath,
      tarball_sha256: result.tarballSha256,
    });
  } else if (command === "registry") {
    const result = await verifyPreparedNpmRegistry({
      packageName: options["--package-name"],
      version: options["--version"],
      publishTag: options["--publish-tag"],
      route: options["--route"],
      tarballPath: options["--tarball"],
      allowMissing: options["--allow-missing"] === "true",
    });
    if (options["--github-output"]) {
      outputValues(options["--github-output"], { already_published: result.alreadyPublished });
    }
    console.log(
      `${options["--package-name"]}@${options["--version"]}: ${result.alreadyPublished ? "verified exact published bytes and selector" : "qualified artifact ready for publication"}`,
    );
  } else {
    throw new Error(
      "Usage: plugin-npm-prepared-release.mjs <seal|load|consume|registry> [options]",
    );
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[plugin-npm-prepared-release] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
