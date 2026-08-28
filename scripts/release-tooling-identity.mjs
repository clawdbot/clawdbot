#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isRecord } from "./lib/record-shared.mjs";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const RELEASE_PUBLISH_REF_PATTERN = /^release-publish\/([a-f0-9]{12})-([1-9][0-9]*)$/u;
const RELEASE_CI_REF_PATTERN = /^release-ci\/([a-f0-9]{12})-([1-9][0-9]*)$/u;
const DIRECT_WORKFLOW_REF_PATTERN =
  /^(?:main|release\/[0-9]{4}\.(?:[1-9]|1[0-2])\.[1-9][0-9]*|extended-stable\/[0-9]{4}\.(?:[1-9]|1[0-2])\.33|tideclaw\/alpha\/[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{4}Z)$/u;
const RELEASE_PUBLISH_PARENT_STATE_POLICIES = new Set([
  "active",
  "active-or-success",
  "manual-recovery",
]);
const GH_COMMAND_TIMEOUT_MS = 60_000;

function fail(message) {
  throw new Error(message);
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} is required.`);
  }
  return value.trim();
}

function requiredSha(value, label) {
  const sha = requiredString(value, label);
  if (!SHA_PATTERN.test(sha)) {
    fail(`${label} must be a lowercase 40-character commit SHA.`);
  }
  return sha;
}

function requireRepository(value) {
  const repository = requiredString(value, "release tooling repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    fail("release tooling repository must be owner/name.");
  }
  return repository;
}

function parseIdentityJson(value) {
  const raw = requiredString(value, "requested release tooling identity");
  let identity;
  try {
    identity = JSON.parse(raw);
  } catch (error) {
    throw new Error("requested release tooling identity must be valid JSON.", { cause: error });
  }
  if (!isRecord(identity)) {
    fail("requested release tooling identity must be a JSON object.");
  }
  return {
    fullRef: requiredString(identity.fullRef, "requested release tooling full ref"),
    ref: requiredString(identity.ref, "requested release tooling ref"),
    sha: requiredSha(identity.sha, "requested release tooling SHA"),
  };
}

export function resolveReleaseToolingIdentity({
  requestedIdentityJson = "",
  workflowContract,
  workflowFullRef,
  workflowRef,
  workflowSha,
}) {
  const contract = requiredString(workflowContract, "release tooling contract");
  if (contract !== "1" && contract !== "2") {
    fail(`release tooling contract ${contract} is not supported.`);
  }
  const ref = requiredString(workflowRef, "workflow ref");
  const fullRef = requiredString(workflowFullRef, "workflow full ref");
  const sha = requiredSha(workflowSha, "workflow SHA");
  const directRoute = fullRef === `refs/heads/${ref}` && DIRECT_WORKFLOW_REF_PATTERN.test(ref);
  const releaseCiMatch = fullRef === `refs/heads/${ref}` ? RELEASE_CI_REF_PATTERN.exec(ref) : null;
  const protectedTagMatch =
    fullRef === `refs/tags/${ref}` ? RELEASE_PUBLISH_REF_PATTERN.exec(ref) : null;

  if (releaseCiMatch && releaseCiMatch[1] !== sha.slice(0, 12)) {
    fail("release-ci workflow ref does not match the workflow SHA.");
  }
  if (protectedTagMatch && protectedTagMatch[1] !== sha.slice(0, 12)) {
    fail("protected workflow ref does not match the workflow SHA.");
  }
  if (!directRoute && !releaseCiMatch && !protectedTagMatch) {
    fail("workflow ref is not a trusted direct, release-ci, or protected-tag route.");
  }

  const requested = requestedIdentityJson.trim()
    ? parseIdentityJson(requestedIdentityJson)
    : undefined;
  if (!requested) {
    if (contract !== "1" && contract !== "2") {
      fail(`release tooling contract ${contract} requires explicit trusted workflow identity.`);
    }
    if (!directRoute) {
      fail("release-ci and protected-tag workflows require explicit trusted workflow identity.");
    }
    return { fullRef, ref, sha };
  }

  if (directRoute || protectedTagMatch) {
    if (requested.ref !== ref || requested.fullRef !== fullRef || requested.sha !== sha) {
      fail("direct workflow identity must match the executing workflow ref and SHA.");
    }
    return requested;
  }

  const requestedProtectedTag = RELEASE_PUBLISH_REF_PATTERN.test(requested.ref);
  const requestedMain = requested.ref === "main" && requested.fullRef === "refs/heads/main";
  if (
    requested.sha !== sha ||
    (!requestedMain &&
      (!requestedProtectedTag || requested.fullRef !== `refs/tags/${requested.ref}`))
  ) {
    fail("release-ci workflow identity must be trusted main or an exact protected tag.");
  }
  return requested;
}

function classifyIdentity({ allowPrevalidatedRef, workflowFullRef, workflowRef, workflowSha }) {
  const ref = requiredString(workflowRef, "release tooling ref");
  const fullRef = requiredString(workflowFullRef, "release tooling full ref");
  const sha = requiredSha(workflowSha, "release tooling SHA");
  const protectedMatch = RELEASE_PUBLISH_REF_PATTERN.exec(ref);

  if (protectedMatch) {
    if (fullRef !== `refs/tags/${ref}`) {
      fail("protected release tooling identity must use the exact tag full ref.");
    }
    if (sha.slice(0, 12) !== protectedMatch[1]) {
      fail("protected release tooling tag SHA prefix does not match the workflow SHA.");
    }
    return { fullRef, ref, route: "protected-tag", sha };
  }

  if (
    ref.startsWith("release-publish/") ||
    fullRef.startsWith("refs/tags/release-publish/") ||
    fullRef.startsWith("refs/heads/release-publish/")
  ) {
    fail("release-publish tooling identity must be an exact protected tag.");
  }

  if (ref === "main" || fullRef === "refs/heads/main") {
    if (ref !== "main" || fullRef !== "refs/heads/main") {
      fail("main release tooling identity must use ref main and full ref refs/heads/main.");
    }
    return { fullRef, ref, route: "main", sha };
  }

  if (allowPrevalidatedRef !== true || fullRef !== `refs/heads/${ref}`) {
    fail(
      "release tooling identity is not trusted main, a protected tag, or a prevalidated branch.",
    );
  }
  return { fullRef, ref, route: "prevalidated-branch", sha };
}

export function validateReleaseToolingIdentity({
  allowPrevalidatedRef = false,
  branchRef,
  mainComparisonStatus,
  tagRef,
  workflowFullRef,
  workflowRef,
  workflowSha,
}) {
  const identity = classifyIdentity({
    allowPrevalidatedRef,
    workflowFullRef,
    workflowRef,
    workflowSha,
  });

  if (identity.route === "protected-tag") {
    if (
      !isRecord(tagRef) ||
      tagRef.ref !== identity.fullRef ||
      !isRecord(tagRef.object) ||
      tagRef.object.type !== "commit" ||
      tagRef.object.sha !== identity.sha
    ) {
      fail(
        "protected release tooling tag is missing, moved, annotated, or bound to the wrong SHA.",
      );
    }
  } else if (identity.route === "main") {
    if (mainComparisonStatus !== "ahead" && mainComparisonStatus !== "identical") {
      fail("main release tooling SHA is not reachable from current main.");
    }
  } else if (
    !isRecord(branchRef) ||
    branchRef.ref !== identity.fullRef ||
    !isRecord(branchRef.object) ||
    branchRef.object.type !== "commit" ||
    branchRef.object.sha !== identity.sha
  ) {
    fail("prevalidated release tooling branch is missing or moved from the workflow SHA.");
  }

  return identity;
}

export function validateReleasePublishParentRun({
  identity,
  releasePublishFullRef,
  releasePublishParentStatePolicy,
  releasePublishRef,
  releasePublishRunAttempt,
  releasePublishRunId,
  repository,
  run,
}) {
  const runId = requiredString(releasePublishRunId, "release publish run id");
  const runAttempt = requiredString(releasePublishRunAttempt, "release publish run attempt");
  if (!/^[1-9][0-9]*$/u.test(runId) || !/^[1-9][0-9]*$/u.test(runAttempt)) {
    fail("release publish run id and attempt must be positive integers.");
  }
  const parentStatePolicy = requiredString(
    releasePublishParentStatePolicy,
    "release publish parent state policy",
  );
  if (!RELEASE_PUBLISH_PARENT_STATE_POLICIES.has(parentStatePolicy)) {
    fail(`release publish parent state policy ${parentStatePolicy} is not supported.`);
  }
  const parentRef = requiredString(releasePublishRef, "release publish ref");
  const parentFullRef = requiredString(releasePublishFullRef, "release publish full ref");
  const parentProtectedMatch = RELEASE_PUBLISH_REF_PATTERN.exec(parentRef);
  const parentDirectRoute =
    parentFullRef === `refs/heads/${parentRef}` && DIRECT_WORKFLOW_REF_PATTERN.test(parentRef);
  const parentProtectedRoute =
    parentFullRef === `refs/tags/${parentRef}` &&
    parentProtectedMatch?.[1] === identity.sha.slice(0, 12);
  if (!parentDirectRoute && !parentProtectedRoute) {
    fail("release publish parent ref is not a trusted direct or exact protected-tag route.");
  }
  const normalizedRepository = requireRepository(repository);
  const [workflowPath, workflowFullRef] = String(run?.path ?? "").split("@", 2);
  const expected = {
    event: "workflow_dispatch",
    headBranch: parentRef,
    headSha: identity.sha,
    repository: normalizedRepository,
    runAttempt: Number(runAttempt),
    runId: Number(runId),
    workflowPath: ".github/workflows/openclaw-release-publish.yml",
  };
  const actual = {
    event: run?.event,
    headBranch: run?.head_branch,
    headSha: run?.head_sha,
    repository: run?.repository?.full_name,
    runAttempt: run?.run_attempt,
    runId: run?.id,
    workflowPath,
  };
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) {
      fail(`release publish parent run ${key} does not match the trusted tooling identity.`);
    }
  }
  if (workflowFullRef && workflowFullRef !== parentFullRef) {
    fail("release publish parent run workflow full ref does not match trusted tooling.");
  }
  const active = run?.status === "in_progress" && !run?.conclusion;
  const completedSuccess = run?.status === "completed" && run?.conclusion === "success";
  const completedFailure = run?.status === "completed" && run?.conclusion === "failure";
  if (
    !active &&
    !(parentStatePolicy === "active-or-success" && completedSuccess) &&
    !(parentStatePolicy === "manual-recovery" && (completedSuccess || completedFailure))
  ) {
    fail(
      `release publish parent run state is not allowed by ${parentStatePolicy}: status=${run?.status ?? "<missing>"} conclusion=${run?.conclusion ?? "<missing>"}.`,
    );
  }
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON.`, { cause: error });
  }
}

function runReleaseToolingGh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GH_COMMAND_TIMEOUT_MS,
  });
}

export function verifyReleaseToolingIdentity({
  allowPrevalidatedRef = false,
  releasePublishFullRef,
  releasePublishParentStatePolicy,
  releasePublishRef,
  releasePublishRunAttempt,
  releasePublishRunId,
  repository,
  runGh = runReleaseToolingGh,
  workflowFullRef,
  workflowRef,
  workflowSha,
}) {
  const normalizedRepository = requireRepository(repository);
  const identity = classifyIdentity({
    allowPrevalidatedRef,
    workflowFullRef,
    workflowRef,
    workflowSha,
  });

  if (identity.route === "protected-tag") {
    let tagRef;
    try {
      tagRef = parseJson(
        runGh([
          "api",
          `repos/${normalizedRepository}/git/ref/tags/${identity.ref}`,
          "--method",
          "GET",
        ]),
        "protected release tooling tag",
      );
    } catch (error) {
      throw new Error("protected release tooling tag is missing or unreadable.", { cause: error });
    }
    const validated = validateReleaseToolingIdentity({
      allowPrevalidatedRef,
      tagRef,
      workflowFullRef,
      workflowRef,
      workflowSha,
    });
    validateParentRunIfRequested({
      identity: validated,
      releasePublishFullRef,
      releasePublishParentStatePolicy,
      releasePublishRef,
      releasePublishRunAttempt,
      releasePublishRunId,
      repository: normalizedRepository,
      runGh,
    });
    return validated;
  }

  if (identity.route === "main") {
    let comparison;
    try {
      comparison = parseJson(
        runGh([
          "api",
          `repos/${normalizedRepository}/compare/${identity.sha}...main`,
          "--method",
          "GET",
        ]),
        "main release tooling comparison",
      );
    } catch (error) {
      throw new Error("main release tooling ancestry could not be verified.", { cause: error });
    }
    const validated = validateReleaseToolingIdentity({
      allowPrevalidatedRef,
      mainComparisonStatus: isRecord(comparison) ? comparison.status : undefined,
      workflowFullRef,
      workflowRef,
      workflowSha,
    });
    validateParentRunIfRequested({
      identity: validated,
      releasePublishFullRef,
      releasePublishParentStatePolicy,
      releasePublishRef,
      releasePublishRunAttempt,
      releasePublishRunId,
      repository: normalizedRepository,
      runGh,
    });
    return validated;
  }

  let branchRef;
  try {
    branchRef = parseJson(
      runGh([
        "api",
        `repos/${normalizedRepository}/git/ref/heads/${identity.ref}`,
        "--method",
        "GET",
      ]),
      "prevalidated release tooling branch",
    );
  } catch (error) {
    throw new Error("prevalidated release tooling branch is missing or unreadable.", {
      cause: error,
    });
  }
  const validated = validateReleaseToolingIdentity({
    allowPrevalidatedRef,
    branchRef,
    workflowFullRef,
    workflowRef,
    workflowSha,
  });
  validateParentRunIfRequested({
    identity: validated,
    releasePublishFullRef,
    releasePublishParentStatePolicy,
    releasePublishRef,
    releasePublishRunAttempt,
    releasePublishRunId,
    repository: normalizedRepository,
    runGh,
  });
  return validated;
}

function validateParentRunIfRequested({
  identity,
  releasePublishFullRef,
  releasePublishParentStatePolicy,
  releasePublishRef,
  releasePublishRunAttempt,
  releasePublishRunId,
  repository,
  runGh,
}) {
  if (
    !releasePublishRunId &&
    !releasePublishRunAttempt &&
    !releasePublishParentStatePolicy &&
    !releasePublishRef &&
    !releasePublishFullRef
  ) {
    return;
  }
  if (
    !releasePublishRunId ||
    !releasePublishRunAttempt ||
    !releasePublishParentStatePolicy ||
    !releasePublishRef ||
    !releasePublishFullRef
  ) {
    fail(
      "release publish run id, attempt, ref, full ref, and parent state policy must be provided together.",
    );
  }
  let run;
  try {
    run = parseJson(
      runGh(["api", `repos/${repository}/actions/runs/${releasePublishRunId}`, "--method", "GET"]),
      "release publish parent run",
    );
  } catch (error) {
    throw new Error("release publish parent run is missing or unreadable.", { cause: error });
  }
  validateReleasePublishParentRun({
    identity,
    releasePublishFullRef,
    releasePublishParentStatePolicy,
    releasePublishRef,
    releasePublishRunAttempt,
    releasePublishRunId,
    repository,
    run,
  });
}

function parseArgs(argv) {
  const options = {
    allowPrevalidatedRef: false,
    command: "",
    releasePublishRunAttempt: "",
    releasePublishRunId: "",
    releasePublishRef: "",
    releasePublishFullRef: "",
    releasePublishParentStatePolicy: "",
    repository: "",
    requestedIdentityJson: "",
    workflowContract: "",
    workflowFullRef: "",
    workflowRef: "",
    workflowSha: "",
  };
  options.command = argv.shift() ?? "";
  if (options.command !== "verify" && options.command !== "resolve") {
    fail("usage: release-tooling-identity.mjs <verify|resolve> [options]");
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-prevalidated-ref") {
      options.allowPrevalidatedRef = true;
      continue;
    }
    const value = argv[(index += 1)] ?? "";
    if (arg === "--release-publish-run-id") {
      options.releasePublishRunId = value;
    } else if (arg === "--release-publish-run-attempt") {
      options.releasePublishRunAttempt = value;
    } else if (arg === "--release-publish-ref") {
      options.releasePublishRef = value;
    } else if (arg === "--release-publish-full-ref") {
      options.releasePublishFullRef = value;
    } else if (arg === "--release-publish-parent-state-policy") {
      options.releasePublishParentStatePolicy = value;
    } else if (arg === "--repository") {
      options.repository = value;
    } else if (arg === "--requested-identity-json") {
      options.requestedIdentityJson = value;
    } else if (arg === "--workflow-contract") {
      options.workflowContract = value;
    } else if (arg === "--workflow-full-ref") {
      options.workflowFullRef = value;
    } else if (arg === "--workflow-ref") {
      options.workflowRef = value;
    } else if (arg === "--workflow-sha") {
      options.workflowSha = value;
    } else {
      fail(`unknown release tooling identity argument: ${arg}`);
    }
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs([...argv]);
  let identity;
  if (options.command === "resolve") {
    identity = resolveReleaseToolingIdentity(options);
    const protectedMatch = RELEASE_PUBLISH_REF_PATTERN.exec(identity.ref);
    verifyReleaseToolingIdentity({
      allowPrevalidatedRef: identity.ref !== "main" && !protectedMatch,
      releasePublishFullRef: options.releasePublishFullRef,
      releasePublishParentStatePolicy: options.releasePublishParentStatePolicy,
      releasePublishRef: options.releasePublishRef,
      releasePublishRunAttempt: options.releasePublishRunAttempt,
      releasePublishRunId: options.releasePublishRunId,
      repository: options.repository,
      workflowFullRef: identity.fullRef,
      workflowRef: identity.ref,
      workflowSha: identity.sha,
    });
  } else {
    identity = verifyReleaseToolingIdentity(options);
  }
  process.stdout.write(`${JSON.stringify(identity)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
