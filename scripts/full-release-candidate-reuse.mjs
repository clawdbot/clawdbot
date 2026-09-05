#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  canonicalFullReleaseCandidateRequestJson,
  candidateRequestSha256,
  fullReleaseCandidateArtifactName,
  validateFullReleaseCandidateRequest,
} from "./full-release-candidate-contract.mjs";
import { classifyReleaseGhTransportError } from "./full-release-validation-policy.mjs";
import { downloadExactActionsArtifactArchive } from "./lib/actions-artifact-archive.mjs";
import {
  CandidateConstituentUnavailableError,
  CandidateDiscoveryBudgetError,
  CandidateEvaluationLimitError,
  candidateArtifactJsonFromBinding,
  loadSelectedFullReleaseCandidate,
  resolveCandidateBinding,
  selectTrustedFullReleaseCandidate,
  validateCandidateBinding,
  verifySealedFullReleaseCandidate,
} from "./lib/full-release-candidate-reuse.mjs";
import { isRecord } from "./lib/record-shared.mjs";

const MAX_ARTIFACT_PAGES = 10;
const CANDIDATE_DISCOVERY_BUDGET_MS = 8 * 60 * 1000;
const GH_TIMEOUT_MS = 60_000;
const CANDIDATE_GH_TIMEOUT_MS = 20_000;
const CANDIDATE_GH_RETRY_ATTEMPTS = 2;
const GH_RETRY_BASE_DELAY_MS = 1_000;

function fail(message) {
  throw new Error(message);
}

function requireDiscoveryBudget(deadlineMs) {
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
    throw new CandidateDiscoveryBudgetError("candidate discovery exceeded its time budget");
  }
}

function requestContract(input) {
  const request = validateFullReleaseCandidateRequest(input);
  const requestJson = canonicalFullReleaseCandidateRequestJson(request);
  return {
    request,
    requestJson: requestJson.trimEnd(),
    requestSha256: candidateRequestSha256(request),
  };
}

function runGhJson(
  repository,
  path,
  label,
  { attempts = 3, deadlineMs, paginate = false, timeoutMs = GH_TIMEOUT_MS } = {},
) {
  let lastError = new Error(`${label} failed`);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    requireDiscoveryBudget(deadlineMs);
    const remainingMs = deadlineMs === undefined ? timeoutMs : deadlineMs - Date.now();
    const args = ["api"];
    if (paginate) {
      args.push("--paginate", "--slurp");
    }
    args.push(`repos/${repository}/${path}`);
    const result = spawnSync("gh", args, {
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 2 * 1024 * 1024,
      timeout: Math.max(1, Math.min(timeoutMs, remainingMs)),
    });
    if (result.error) {
      lastError = result.error;
    } else if (result.status !== 0) {
      lastError = new Error(
        `${label} failed: ${result.stderr.trim() || `exit ${result.status ?? "unknown"}`}`,
      );
    } else {
      try {
        return JSON.parse(result.stdout);
      } catch (error) {
        fail(
          `${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (attempt === attempts || classifyReleaseGhTransportError(lastError) !== "transient") {
      throw lastError;
    }
    requireDiscoveryBudget(deadlineMs);
    const retryDelayMs =
      deadlineMs === undefined
        ? GH_RETRY_BASE_DELAY_MS * attempt
        : Math.min(GH_RETRY_BASE_DELAY_MS * attempt, Math.max(0, deadlineMs - Date.now()));
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
      0,
      0,
      retryDelayMs,
    );
  }
  throw lastError;
}

function readCandidateWorkflowJobs(repository, runId, runAttempt, options) {
  return readWorkflowJobPages(
    repository,
    `actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
    options,
  );
}

function readCandidateWorkflowHistory(repository, runId, options) {
  return readWorkflowJobPages(
    repository,
    `actions/runs/${runId}/jobs?filter=all&per_page=100`,
    options,
  );
}

function readWorkflowJobPages(repository, path, options) {
  const pages = runGhJson(repository, path, "full release candidate workflow jobs", {
    ...options,
    paginate: true,
  });
  if (
    !Array.isArray(pages) ||
    pages.length === 0 ||
    pages.some((page) => !isRecord(page) || !Array.isArray(page.jobs))
  ) {
    fail("full release candidate workflow job pages are invalid");
  }
  const jobs = pages.flatMap((page) => page.jobs);
  return { jobs, total_count: pages[0].total_count };
}

function readRepositoryArtifacts(repository, requestSha256, options) {
  const artifacts = [];
  const name = encodeURIComponent(fullReleaseCandidateArtifactName(requestSha256));
  for (let page = 1; page <= MAX_ARTIFACT_PAGES; page += 1) {
    const response = runGhJson(
      repository,
      `actions/artifacts?name=${name}&per_page=100&page=${page}`,
      "full release candidate artifact listing",
      options,
    );
    if (!Array.isArray(response.artifacts)) {
      fail("full release candidate artifact listing is invalid");
    }
    artifacts.push(...response.artifacts);
    if (response.artifacts.length < 100) {
      return artifacts;
    }
  }
  return null;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return fail(
      `${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) {
    fail(`missing ${name}`);
  }
  return args[index + 1];
}

function optionalOption(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : option(args, name);
}

function output(name, value) {
  const line = `${name}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, line);
  } else {
    process.stdout.write(line);
  }
}

async function discover(args) {
  const contract = requestContract(
    readJson(option(args, "--request-input"), "candidate request input"),
  );
  const expectedRequestSha256 = optionalOption(args, "--expected-request-sha256");
  const expectedPackageSha256 = optionalOption(args, "--expected-package-sha256");
  if (expectedPackageSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(expectedPackageSha256)) {
    fail("expected package digest must be a lowercase SHA-256");
  }
  if (expectedRequestSha256 !== undefined && expectedRequestSha256 !== contract.requestSha256) {
    fail("full release candidate request digest does not match the expected request digest");
  }
  const token = process.env.GH_TOKEN;
  if (!token) {
    fail("GH_TOKEN is required");
  }
  output("request_json", contract.requestJson);
  output("request_sha256", contract.requestSha256);
  let selected;
  const deadlineMs = Date.now() + CANDIDATE_DISCOVERY_BUDGET_MS;
  const ghOptions = {
    attempts: CANDIDATE_GH_RETRY_ATTEMPTS,
    deadlineMs,
    timeoutMs: CANDIDATE_GH_TIMEOUT_MS,
  };
  try {
    const artifacts = readRepositoryArtifacts(
      contract.request.repository,
      contract.requestSha256,
      ghOptions,
    );
    if (artifacts === null) {
      output("state", "unavailable");
      output("reused", "false");
      output("reuse_reason", "candidate artifact inventory exceeded the bounded scan");
      return;
    }
    selected = await selectTrustedFullReleaseCandidate({
      artifacts,
      deadlineMs,
      request: contract.request,
      readWorkflowRun: async (runId) =>
        runGhJson(
          contract.request.repository,
          `actions/runs/${runId}`,
          "full release candidate workflow run",
          ghOptions,
        ),
      readWorkflowJobs: async (runId) =>
        readCandidateWorkflowHistory(contract.request.repository, runId, ghOptions),
    });
  } catch (error) {
    if (
      error instanceof CandidateDiscoveryBudgetError ||
      error instanceof CandidateEvaluationLimitError
    ) {
      output("state", "unavailable");
      output("reused", "false");
      output("reuse_reason", error.message);
      return;
    }
    if (classifyReleaseGhTransportError(error) !== "transient") {
      throw error;
    }
    output("state", "unavailable");
    output("reused", "false");
    output("reuse_reason", "candidate discovery unavailable after bounded retries");
    return;
  }
  if (!selected) {
    output("state", "miss");
    output("reused", "false");
    output("reuse_reason", "no trusted exact candidate artifact");
    return;
  }
  let binding;
  try {
    binding = await loadSelectedFullReleaseCandidate({
      deadlineMs,
      downloadArchive: (params) =>
        downloadExactActionsArtifactArchive({
          ...params,
          deadlineMs,
          retryAttempts: CANDIDATE_GH_RETRY_ATTEMPTS,
          timeoutMs: CANDIDATE_GH_TIMEOUT_MS,
        }),
      readArtifact: async (artifactId) =>
        runGhJson(
          contract.request.repository,
          `actions/artifacts/${artifactId}`,
          "full release candidate constituent artifact",
          ghOptions,
        ),
      readRunAttempt: async (runId, runAttempt) =>
        runGhJson(
          contract.request.repository,
          `actions/runs/${runId}/attempts/${runAttempt}`,
          "full release candidate workflow attempt",
          ghOptions,
        ),
      readWorkflowJobs: async (runId, runAttempt) =>
        readCandidateWorkflowJobs(contract.request.repository, runId, runAttempt, ghOptions),
      request: contract.request,
      selected,
      token,
    });
  } catch (error) {
    if (
      !(error instanceof CandidateConstituentUnavailableError) &&
      !(error instanceof CandidateDiscoveryBudgetError)
    ) {
      throw error;
    }
    output("state", "unavailable");
    output("reused", "false");
    output("reuse_reason", error.message);
    return;
  }
  if (
    expectedPackageSha256 !== undefined &&
    binding.package.packageSha256 !== expectedPackageSha256
  ) {
    output("state", "miss");
    output("reused", "false");
    output("reuse_reason", "candidate package differs from the prepared publication bytes");
    return;
  }
  output("state", "hit");
  output("reused", "true");
  output("reuse_reason", "trusted exact candidate artifact");
  output("binding_json", JSON.stringify(binding));
  output("candidate_artifact_json", candidateArtifactJsonFromBinding(binding));
}

function resolveBinding(args) {
  const input = readJson(option(args, "--input"), "candidate binding input");
  const binding = resolveCandidateBinding(input);
  process.stdout.write(
    `${JSON.stringify({
      binding,
      candidateArtifactJson: binding ? candidateArtifactJsonFromBinding(binding) : "",
    })}\n`,
  );
}

async function verify(args) {
  const plan = readJson(option(args, "--plan"), "release execution plan");
  if (plan.candidate === null) {
    return;
  }
  const token = process.env.GH_TOKEN;
  if (!token) {
    fail("GH_TOKEN is required");
  }
  const binding = validateCandidateBinding(plan.candidate);
  const ghOptions = {
    attempts: CANDIDATE_GH_RETRY_ATTEMPTS,
    timeoutMs: CANDIDATE_GH_TIMEOUT_MS,
  };
  await verifySealedFullReleaseCandidate({
    binding,
    consumerRunAttempt: option(args, "--consumer-run-attempt"),
    consumerRunId: option(args, "--consumer-run-id"),
    readArtifact: async (artifactId) =>
      runGhJson(
        binding.request.repository,
        `actions/artifacts/${artifactId}`,
        "sealed full release candidate artifact",
        ghOptions,
      ),
    readRunAttempt: async (runId, runAttempt) =>
      runGhJson(
        binding.request.repository,
        `actions/runs/${runId}/attempts/${runAttempt}`,
        "sealed full release candidate workflow attempt",
        ghOptions,
      ),
    readWorkflowJobs: async (runId, runAttempt) =>
      readCandidateWorkflowJobs(binding.request.repository, runId, runAttempt, ghOptions),
    downloadArchive: (params) =>
      downloadExactActionsArtifactArchive({
        ...params,
        retryAttempts: CANDIDATE_GH_RETRY_ATTEMPTS,
        timeoutMs: CANDIDATE_GH_TIMEOUT_MS,
      }),
    token,
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "discover") {
    await discover(args);
    return;
  }
  if (command === "resolve") {
    resolveBinding(args);
    return;
  }
  if (command === "verify") {
    await verify(args);
    return;
  }
  fail("usage: full-release-candidate-reuse.mjs <discover|resolve|verify> ...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
