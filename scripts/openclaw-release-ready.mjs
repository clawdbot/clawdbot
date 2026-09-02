#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs, isDeepStrictEqual } from "node:util";
import {
  preparedClawHubArtifactName,
  resolvePreparedClawHubMatrix,
  restorePreparedClawHubPackage,
} from "./clawhub-prepared-artifact.mjs";
import {
  downloadActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
  readBoundedRegularFile,
} from "./lib/actions-artifact-archive.mjs";
import { isRecord } from "./lib/record-shared.mjs";
import { classifyReleaseTrain, parseReleaseVersion } from "./lib/release-version.mjs";
import {
  consumePreparedNpmPackage,
  downloadPreparedNpmRelease,
  preparedNpmArtifactName,
} from "./plugin-npm-prepared-release.mjs";
import { runReleaseToolingGh, verifyReleaseToolingIdentity } from "./release-tooling-identity.mjs";

const REPOSITORY = "openclaw/openclaw";
const PREPARE_WORKFLOW = ".github/workflows/openclaw-release-prepare.yml";
const PUBLISH_WORKFLOW = ".github/workflows/openclaw-release-publish.yml";
const READY_FILE = "release-ready.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/u;
const INPUTS = new Set([
  "tag",
  "preflight_run_id",
  "plugin_sdk_api_acknowledgement",
  "full_release_validation_run_id",
  "full_release_validation_run_attempt",
  "windows_node_tag",
  "windows_node_installer_digests",
  "npm_telegram_run_id",
  "openclaw_npm_resume_run_id",
  "npm_dist_tag",
  "plugin_publish_scope",
  "plugins",
  "publish_openclaw_npm",
  "publish_docker_only",
  "release_profile",
  "release_evidence_mode",
  "wait_for_clawhub",
]);

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function api(path, args = []) {
  return JSON.parse(runReleaseToolingGh(["api", `repos/${REPOSITORY}/${path}`, ...args]));
}

function git(args, cwd = ".") {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: MAX_MANIFEST_BYTES,
  }).trim();
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `${name}=${typeof value === "string" ? value : JSON.stringify(value)}\n`,
    );
  }
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function readJson(path) {
  return JSON.parse(
    readBoundedRegularFile(path, { label: path, maxBytes: MAX_MANIFEST_BYTES }).toString("utf8"),
  );
}

/** @returns {Record<string, string>} */
export function validateReleaseButtonInputs(value) {
  requireValue(
    isRecord(value) && Object.keys(value).every((key) => INPUTS.has(key)),
    "Prepared release contains unsupported publication inputs.",
  );
  const inputs = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      requireValue(
        (typeof entry === "string" || typeof entry === "boolean") &&
          !/[\r\n\0]/u.test(String(entry)),
        `Invalid release input: ${key}.`,
      );
      return [key, String(entry)];
    }),
  );
  const version = parseReleaseVersion(inputs.tag?.slice(1) ?? "");
  requireValue(
    version !== null && inputs.tag === `v${version.version}`,
    "Prepared release requires an exact version tag.",
  );
  requireValue(
    ["beta", "stable"].includes(classifyReleaseTrain(version)) &&
      inputs.npm_dist_tag !== "extended-stable",
    "Alpha and extended-stable releases retain their existing owner workflows.",
  );
  const expectedChannel = version.channel === "stable" ? ["beta", "latest"] : [version.channel];
  requireValue(
    expectedChannel.includes(inputs.npm_dist_tag),
    "Prepared release npm channel differs from its tag.",
  );
  for (const name of [
    "preflight_run_id",
    "full_release_validation_run_id",
    "full_release_validation_run_attempt",
  ]) {
    requireValue(
      /^[1-9][0-9]*$/u.test(inputs[name] ?? ""),
      `Prepared release requires exact ${name}.`,
    );
  }
  requireValue(
    (inputs.plugin_publish_scope ?? "all-publishable") === "all-publishable" && !inputs.plugins,
    "The release button prepares the complete publishable plugin roster; use the existing publisher for selected repairs.",
  );
  requireValue(
    (inputs.publish_openclaw_npm ?? "true") === "true" &&
      (inputs.publish_docker_only ?? "false") === "false" &&
      (inputs.release_evidence_mode ?? "full-release-validation") === "full-release-validation",
    "The release button requires full release validation and core npm publication.",
  );
  return {
    ...inputs,
    plugin_publish_scope: "all-publishable",
    publish_openclaw_npm: "true",
    publish_docker_only: "false",
    release_evidence_mode: "full-release-validation",
    wait_for_clawhub: "true",
  };
}

function toolingIdentity(environment = process.env) {
  requireValue(
    environment.GITHUB_REPOSITORY === REPOSITORY,
    "Release preparation must run in the canonical repository.",
  );
  const identity = verifyReleaseToolingIdentity({
    repository: REPOSITORY,
    workflowRef: environment.GITHUB_REF_NAME,
    workflowFullRef: environment.GITHUB_REF,
    workflowSha: environment.GITHUB_WORKFLOW_SHA,
  });
  requireValue(
    identity.route === "protected-tag",
    "Prepared publication requires a frozen protected release-publish tag.",
  );
  return { ref: identity.ref, fullRef: identity.fullRef, sha: identity.sha };
}

function producer(run, workflowPath, tooling) {
  const [path, fullRef] = String(run.path).split("@");
  requireValue(
    run.repository?.full_name === REPOSITORY &&
      path === workflowPath &&
      (fullRef === undefined || fullRef === tooling.fullRef) &&
      run.event === "workflow_dispatch" &&
      run.head_branch === tooling.ref &&
      run.head_sha === tooling.sha &&
      Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0,
    "Release producer workflow identity mismatch.",
  );
  return {
    repository: REPOSITORY,
    runId: run.id,
    runAttempt: run.run_attempt,
    workflowPath,
    workflowEvent: run.event,
    workflowHeadBranch: run.head_branch,
    workflowSha: run.head_sha,
  };
}

export function readyArtifactName(sourceSha, runId, runAttempt) {
  requireValue(
    SHA.test(sourceSha) &&
      Number.isSafeInteger(runId) &&
      runId > 0 &&
      Number.isSafeInteger(runAttempt) &&
      runAttempt > 0,
    "Invalid prepared release artifact identity.",
  );
  return `release-ready-${sourceSha.slice(0, 12)}-${runId}-${runAttempt}`;
}

function artifactFor(run, workflow, tooling, name) {
  const identity = producer(run, workflow, tooling);
  const artifacts = [];
  for (let page = 1; page <= 20; page++) {
    const result = api(`actions/runs/${run.id}/artifacts?per_page=100&page=${page}`);
    requireValue(result.total_count <= 2000, "Prepared release artifact list exceeds its limit.");
    artifacts.push(...result.artifacts);
    if (artifacts.length >= result.total_count) {
      break;
    }
  }
  const matches = artifacts.filter((artifact) => artifact.name === name);
  requireValue(matches.length === 1, `Expected one exact prepared artifact: ${name}.`);
  const [artifact] = matches;
  requireValue(
    artifact.expired === false &&
      artifact.workflow_run?.id === run.id &&
      artifact.workflow_run?.head_sha === tooling.sha &&
      /^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? ""),
    "Prepared artifact is expired or differs from its producer.",
  );
  return {
    ...identity,
    artifactId: artifact.id,
    artifactName: artifact.name,
    artifactDigest: artifact.digest,
    artifactSizeBytes: artifact.size_in_bytes,
  };
}

async function waitForRun(runId, attempt, workflow, tooling) {
  const deadline = Date.now() + 110 * 60_000;
  while (Date.now() < deadline) {
    const run = api(`actions/runs/${runId}`);
    producer(run, workflow, tooling);
    requireValue(
      run.run_attempt === attempt,
      "Release producer attempt changed; retain the original evidence and select an exact new attempt explicitly.",
    );
    if (run.status === "completed") {
      requireValue(
        run.conclusion === "success",
        `${workflow} run ${runId}/${attempt} ended ${run.conclusion}; ${
          workflow === PUBLISH_WORKFLOW
            ? "inspect child outcomes for owner recovery, then start a new button run with the same readiness receipt and openclaw_npm_resume_run_id when core npm succeeded. A published core version without a successful child requires core-owner reconciliation. This button remains bound to its original parent attempt."
            : "rerun all jobs of this linked non-publishing child to produce a complete same-attempt package set, then rerun only the outer Verify and seal prepared publication job. Do not repeat preparation dispatch."
        }`,
      );
      return run;
    }
    await delay(15_000);
  }
  throw new Error(
    `Run ${runId}/${attempt} is still pending; resume verification, not publication.`,
  );
}

function dispatch(workflow, inputs, tooling) {
  verifyReleaseToolingIdentity({
    repository: REPOSITORY,
    workflowRef: tooling.ref,
    workflowFullRef: tooling.fullRef,
    workflowSha: tooling.sha,
  });
  const args = [
    "--method",
    "POST",
    "-H",
    "X-GitHub-Api-Version: 2026-03-10",
    "-f",
    `ref=${tooling.ref}`,
  ];
  for (const [key, value] of Object.entries(inputs)) {
    args.push("-f", `inputs[${key}]=${value}`);
  }
  // Dispatch is a mutation: never retry an uncertain response. A new request
  // could create a second publisher even when the first response was lost.
  const result = api(`actions/workflows/${workflow}/dispatches`, args);
  requireValue(
    Number.isSafeInteger(result.workflow_run_id) && result.workflow_run_id > 0,
    "Dispatch response did not identify its run. Inspect Actions before dispatching again.",
  );
  const link = `https://github.com/${REPOSITORY}/actions/runs/${result.workflow_run_id}`;
  console.log(`${workflow}: ${link}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${workflow}: ${link}\n`);
  }
  return result.workflow_run_id;
}

export function validateReadyRelease(value, expected) {
  requireValue(
    isRecord(value) &&
      value.schema === "openclaw.release-ready/v1" &&
      value.repository === REPOSITORY &&
      SHA.test(value.sourceSha) &&
      value.sourceSha === expected.sourceSha &&
      isDeepStrictEqual(value.tooling, expected.tooling),
    "Prepared release source or tooling identity mismatch.",
  );
  const inputs = validateReleaseButtonInputs(value.inputs);
  requireValue(
    isDeepStrictEqual(inputs, value.inputs) &&
      isRecord(value.plugins) &&
      Object.keys(value.plugins).toSorted().join(",") === "clawhub,npm",
    "Prepared release input or package handoff is invalid.",
  );
  for (const [target, path] of [
    ["npm", ".github/workflows/plugin-npm-release.yml"],
    ["clawhub", ".github/workflows/plugin-clawhub-release.yml"],
  ]) {
    const descriptor = value.plugins[target];
    requireValue(
      descriptor?.repository === REPOSITORY &&
        descriptor.workflowSha === value.tooling.sha &&
        descriptor.workflowHeadBranch === value.tooling.ref &&
        descriptor.workflowPath === path,
      `Prepared ${target} producer differs from the release tooling.`,
    );
  }
  return value;
}

export async function loadPreparedPlugins({
  plugins,
  inputs,
  sourceSha,
  toolingSha,
  sourceRoot,
  outputDir,
  token,
  fetchImpl,
}) {
  requireValue(
    isRecord(plugins) && Object.keys(plugins).toSorted().join(",") === "clawhub,npm",
    "Both npm and ClawHub preparation artifacts are required.",
  );
  mkdirSync(outputDir, { recursive: true });
  const publisherPolicySha256 = createHash("sha256")
    .update(readFileSync(new URL("../.github/workflows/plugin-npm-release.yml", import.meta.url)))
    .digest("hex");
  const common = { token, fetchImpl, sourceRoot, selectionMode: "all-publishable", plugins: "" };
  const results = await Promise.allSettled([
    downloadPreparedNpmRelease({
      ...common,
      artifact: plugins.npm,
      sourceSha,
      workflowSha: toolingSha,
      repository: REPOSITORY,
      npmDistTag: inputs.npm_dist_tag === "extended-stable" ? "extended-stable" : "default",
      publisherPolicySha256,
      archivePath: join(outputDir, `npm-${plugins.npm.artifactId}.zip`),
    }),
    resolvePreparedClawHubMatrix({
      ...common,
      descriptor: plugins.clawhub,
      candidateSha: sourceSha,
      toolingSha,
      archivePath: join(outputDir, `clawhub-${plugins.clawhub.artifactId}.zip`),
    }),
  ]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) {
    throw failure.reason;
  }
  const [npm, clawhub] = results.map((result) => result.value);
  return {
    npm,
    clawhub: { packages: clawhub.map((entry) => entry.prepared) },
    publisherPolicySha256,
  };
}

export async function prefetchPreparedPlugins(options) {
  const manifests = await loadPreparedPlugins(options);
  const { plugins, inputs, sourceSha, toolingSha, sourceRoot, outputDir, token, fetchImpl } =
    options;
  const admissionDir = mkdtempSync(join(outputDir, "verified-"));
  const tasks = [
    ...manifests.npm.packages.map(
      (entry) => () =>
        consumePreparedNpmPackage({
          package: entry,
          repository: REPOSITORY,
          sourceSha,
          workflowSha: toolingSha,
          npmDistTag: manifests.npm.npmDistTag,
          publisherPolicySha256: manifests.publisherPolicySha256,
          sourcePackageJson: join(sourceRoot, entry.packageDir, "package.json"),
          cacheDir: join(outputDir, "npm"),
          outputDir: join(admissionDir, `npm-${entry.extensionId}`),
          token,
          fetchImpl,
        }),
    ),
    ...manifests.clawhub.packages.map(
      (entry) => () =>
        restorePreparedClawHubPackage({
          descriptor: plugins.clawhub,
          toolingSha,
          entry,
          outputDir: join(admissionDir, `clawhub-${entry.packageDir.split("/").at(-1)}`),
          archivePath: join(outputDir, `clawhub-${entry.artifactId}.zip`),
          token,
          fetchImpl,
        }),
    ),
  ];
  // Drain the current batch before failing; no publication can race a transfer
  // still being verified, and complete archives remain available for re-entry.
  for (let index = 0; index < tasks.length; index += 4) {
    const results = await Promise.allSettled(tasks.slice(index, index + 4).map((task) => task()));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
  }
  writeJson(join(admissionDir, "verified.json"), {
    sourceSha,
    toolingSha,
    npm: manifests.npm.packages.length,
    clawhub: manifests.clawhub.packages.length,
  });
  return { ...manifests, inputs };
}

async function readReady(descriptor, directory, tooling, token) {
  requireValue(
    descriptor?.workflowPath === PREPARE_WORKFLOW &&
      descriptor.repository === REPOSITORY &&
      descriptor.workflowSha === tooling.sha &&
      descriptor.workflowHeadBranch === tooling.ref,
    "Release readiness must come from the exact protected preparation workflow.",
  );
  const downloaded = await downloadActionsArtifactArchive({
    token,
    expected: { ...descriptor, runStatePolicy: "completed-success" },
    maxArchiveBytes: MAX_MANIFEST_BYTES,
    archivePath: join(directory, `${descriptor.artifactId}.zip`),
  });
  const files = inspectActionsArtifactZipWithPolicy(downloaded.archiveBytes, {
    expectedEntries: [READY_FILE],
    maxArchiveBytes: MAX_MANIFEST_BYTES,
    maxExpandedBytes: MAX_MANIFEST_BYTES,
    maxEntryBytes: () => MAX_MANIFEST_BYTES,
  });
  const value = JSON.parse(files.get(READY_FILE).toString("utf8"));
  requireValue(
    descriptor.artifactName ===
      readyArtifactName(value.sourceSha, descriptor.runId, descriptor.runAttempt),
    "Release readiness artifact name mismatch.",
  );
  const sourceSha = api(`commits/${encodeURIComponent(value.inputs?.tag)}`, ["--jq", "{sha}"]).sha;
  return validateReadyRelease(value, { sourceSha, tooling });
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      inputs: { type: "string" },
      request: { type: "string" },
      artifact: { type: "string" },
      output: { type: "string" },
      "openclaw-npm-resume-run-id": { type: "string" },
      "source-root": { type: "string", default: "." },
    },
  });
  const [operation] = positionals;
  const directory = resolve(values.output ?? ".artifacts/release-ready");
  mkdirSync(directory, { recursive: true });
  const tooling = toolingIdentity();
  const token = process.env.GH_TOKEN;
  if (operation === "dispatch-prepare") {
    requireValue(
      values.request !== undefined || process.env.GITHUB_RUN_ATTEMPT === "1",
      "Preparation dispatch already ran; recover failed linked non-publishing child runs with Re-run all jobs, then rerun only the outer seal. Do not repeat this dispatch.",
    );
    const inputs = validateReleaseButtonInputs(readJson(values.inputs));
    const sourceSha = api(`commits/${encodeURIComponent(inputs.tag)}`, ["--jq", "{sha}"]).sha;
    requireValue(SHA.test(sourceSha), "Release tag does not resolve to a commit.");
    const packageJson = JSON.parse(git(["show", `${sourceSha}:package.json`]));
    requireValue(
      inputs.tag === `v${packageJson.version}`,
      "Release tag and source package version differ.",
    );
    const request = {
      schema: "openclaw.release-ready/v1",
      repository: REPOSITORY,
      sourceSha,
      tooling,
      inputs,
      npmRunId: null,
      clawhubRunId: null,
    };
    const requestPath = join(directory, "request.json");
    if (values.request !== undefined) {
      const recovered = readJson(values.request);
      requireValue(
        isRecord(recovered) &&
          isDeepStrictEqual({ ...recovered, npmRunId: null, clawhubRunId: null }, request),
        "Preparation recovery differs from the frozen source, tooling, or publication inputs.",
      );
      for (const [key, workflow] of [
        ["npmRunId", ".github/workflows/plugin-npm-release.yml"],
        ["clawhubRunId", ".github/workflows/plugin-clawhub-release.yml"],
      ]) {
        requireValue(
          Number.isSafeInteger(recovered[key]) && recovered[key] > 0,
          `Preparation recovery requires an explicitly identified ${key}; inspect Actions before selecting it.`,
        );
        producer(api(`actions/runs/${recovered[key]}`), workflow, tooling);
        request[key] = recovered[key];
      }
      // Adoption is read-only. The seal still proves each selected run's source,
      // complete package roster, producer attempt, and exact qualified bytes.
      writeJson(requestPath, request);
    } else {
      writeJson(requestPath, request);
      const saveAcknowledgedDispatch = () => {
        const nextPath = join(directory, "request.next.json");
        writeJson(nextPath, request);
        renameSync(nextPath, requestPath);
      };
      // Persist before either mutation, then after each acknowledged run. A null
      // ID means unconfirmed, never proof that a lost dispatch created no run.
      request.npmRunId = dispatch(
        "plugin-npm-release.yml",
        {
          ref: sourceSha,
          publish_scope: "all-publishable",
          npm_dist_tag: inputs.npm_dist_tag === "extended-stable" ? "extended-stable" : "default",
          preflight_only: "true",
          trusted_publisher_preflight: "false",
        },
        tooling,
      );
      saveAcknowledgedDispatch();
      request.clawhubRunId = dispatch(
        "plugin-clawhub-release.yml",
        { ref: sourceSha, publish_scope: "all-publishable", dry_run: "true" },
        tooling,
      );
      saveAcknowledgedDispatch();
    }
    output("npm_run_id", String(request.npmRunId));
    output("clawhub_run_id", String(request.clawhubRunId));
    output("request", request);
    output("source_sha", sourceSha);
    return;
  }
  if (operation === "seal") {
    const request = readJson(values.request);
    requireValue(
      isDeepStrictEqual(request.tooling, tooling),
      "Preparation tooling moved before sealing.",
    );
    // Retrying a failed seal job may follow an explicit rerun of the original
    // producers. Resolve each current attempt once, never fall back to an older success.
    const npmAttempt = api(`actions/runs/${request.npmRunId}`).run_attempt;
    const clawhubAttempt = api(`actions/runs/${request.clawhubRunId}`).run_attempt;
    const [npmRun, clawhubRun] = await Promise.all([
      waitForRun(request.npmRunId, npmAttempt, ".github/workflows/plugin-npm-release.yml", tooling),
      waitForRun(
        request.clawhubRunId,
        clawhubAttempt,
        ".github/workflows/plugin-clawhub-release.yml",
        tooling,
      ),
    ]);
    const npmProducer = producer(npmRun, ".github/workflows/plugin-npm-release.yml", tooling);
    const clawhubProducer = producer(
      clawhubRun,
      ".github/workflows/plugin-clawhub-release.yml",
      tooling,
    );
    const plugins = {
      npm: artifactFor(
        npmRun,
        npmProducer.workflowPath,
        tooling,
        preparedNpmArtifactName(request.sourceSha, npmProducer),
      ),
      clawhub: artifactFor(
        clawhubRun,
        clawhubProducer.workflowPath,
        tooling,
        preparedClawHubArtifactName(request.sourceSha, clawhubProducer),
      ),
    };
    const ready = validateReadyRelease(
      {
        schema: request.schema,
        repository: REPOSITORY,
        inputs: request.inputs,
        sourceSha: request.sourceSha,
        tooling,
        plugins,
      },
      request,
    );
    await prefetchPreparedPlugins({
      plugins,
      inputs: ready.inputs,
      sourceSha: ready.sourceSha,
      toolingSha: tooling.sha,
      sourceRoot: resolve(values["source-root"]),
      outputDir: join(directory, "packages"),
      token,
    });
    writeJson(join(directory, READY_FILE), ready);
    output(
      "artifact_name",
      readyArtifactName(
        ready.sourceSha,
        Number(process.env.GITHUB_RUN_ID),
        Number(process.env.GITHUB_RUN_ATTEMPT),
      ),
    );
    return;
  }
  if (operation === "dispatch-publish") {
    requireValue(
      process.env.GITHUB_RUN_ATTEMPT === "1",
      "Publication may already have been dispatched. Rerun failed verification jobs, not the successful dispatch job.",
    );
    const resumeRunId = values["openclaw-npm-resume-run-id"] ?? "";
    requireValue(
      resumeRunId === "" ||
        (/^[1-9][0-9]*$/u.test(resumeRunId) && Number.isSafeInteger(Number(resumeRunId))),
      "openclaw_npm_resume_run_id must be a positive safe integer.",
    );
    const descriptor = readJson(values.artifact);
    const ready = await readReady(descriptor, directory, tooling, token);
    // Recovery changes only the existing owner's resume selector. The parent
    // verifies its authority and canonical core bytes before starting writers.
    const inputs = {
      ...ready.inputs,
      ...(resumeRunId ? { openclaw_npm_resume_run_id: resumeRunId } : {}),
      prepared_plugins: JSON.stringify(ready.plugins),
    };
    const runId = dispatch("openclaw-release-publish.yml", inputs, tooling);
    output("release_run_id", String(runId));
    output("source_sha", ready.sourceSha);
    output("release_tag", ready.inputs.tag);
    output("npm_dist_tag", ready.inputs.npm_dist_tag);
    const request = {
      releaseRunId: runId,
      releaseRunAttempt: 1,
      sourceSha: ready.sourceSha,
      tooling,
      preparedArtifact: descriptor,
      openclawNpmResumeRunId: inputs.openclaw_npm_resume_run_id ?? null,
    };
    output("request", request);
    writeJson(join(directory, "dispatch.json"), request);
    return;
  }
  if (operation === "verify") {
    const request = readJson(values.request);
    requireValue(
      isDeepStrictEqual(request.tooling, tooling),
      "Publication verifier tooling mismatch.",
    );
    const run = await waitForRun(
      request.releaseRunId,
      request.releaseRunAttempt,
      PUBLISH_WORKFLOW,
      tooling,
    );
    const { verifyClawHubPostpublish } = await import("./clawhub-postpublish.mjs");
    await verifyClawHubPostpublish({
      event: { workflow_run: run },
      verifierSha: tooling.sha,
      token,
      outputDir: join(directory, "clawhub-public-verification"),
    });
    output("verified", "true");
    return;
  }
  throw new Error("Expected dispatch-prepare, seal, dispatch-publish, or verify.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[openclaw-release-ready] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
