#!/usr/bin/env node
// Builds cheap rerun commands from a Docker E2E GitHub run or local summary.
// For GitHub runs, the script downloads Docker E2E artifacts, reads
// summary/failures JSON, and prints targeted workflow commands for failed
// lanes, repacking the exact artifact target and reusing GHCR-backed prepared
// image refs when artifacts expose them.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDockerE2eJsonArtifact } from "./lib/docker-e2e-json-artifacts.mjs";

const DEFAULT_WORKFLOW = "openclaw-live-and-e2e-checks-reusable.yml";

function usage() {
  return [
    "Usage:",
    "  node scripts/docker-e2e-rerun.mjs <run-id|summary.json|failures.json> [--repo owner/repo] [--dir output-dir] [--workflow workflow.yml] [--ref ref]",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    dir: "",
    help: false,
    input: "",
    ref: "",
    repo: "",
    workflow: DEFAULT_WORKFLOW,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--repo") {
      options.repo = argv[(index += 1)] ?? "";
    } else if (arg?.startsWith("--repo=")) {
      options.repo = arg.slice("--repo=".length);
    } else if (arg === "--dir") {
      options.dir = argv[(index += 1)] ?? "";
    } else if (arg?.startsWith("--dir=")) {
      options.dir = arg.slice("--dir=".length);
    } else if (arg === "--workflow") {
      options.workflow = argv[(index += 1)] ?? "";
    } else if (arg?.startsWith("--workflow=")) {
      options.workflow = arg.slice("--workflow=".length);
    } else if (arg === "--ref") {
      options.ref = argv[(index += 1)] ?? "";
    } else if (arg?.startsWith("--ref=")) {
      options.ref = arg.slice("--ref=".length);
    } else if (!options.input) {
      options.input = arg;
    } else {
      throw new Error(`unknown argument: ${arg}\n${usage()}`);
    }
  }
  if (options.help) {
    return options;
  }
  if (!options.input || !options.workflow) {
    throw new Error(usage());
  }
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status ?? result.signal}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function readJson(file) {
  return readDockerE2eJsonArtifact(file);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function laneNeedsReleasePath(lane) {
  return /^bundled-channel(?:-|$)/u.test(lane);
}

function maybeGhcrImage(value) {
  return typeof value === "string" && value.startsWith("ghcr.io/") ? value : "";
}

const TRUSTED_WORKFLOW_INPUTS = new Map([
  ["docker_e2e_bare_image", "bareImage"],
  ["docker_e2e_functional_image", "functionalImage"],
  ["published_upgrade_survivor_baseline", "publishedUpgradeSurvivorBaseline"],
  ["published_upgrade_survivor_baselines", "publishedUpgradeSurvivorBaselines"],
  ["published_upgrade_survivor_scenarios", "publishedUpgradeSurvivorScenarios"],
  ["allow_unreleased_changelog", "allowUnreleasedChangelog"],
]);

const REUSE_INPUT_KEYS = [
  "bareImage",
  "functionalImage",
  "publishedUpgradeSurvivorBaseline",
  "publishedUpgradeSurvivorBaselines",
  "publishedUpgradeSurvivorScenarios",
  "allowUnreleasedChangelog",
];

const WORKFLOW_INPUT_RE = /(?:^|\s)-f\s+([a-z0-9_]+)=('([^']*)'|[^\s]+)/gu;

function trustedReuseInputsFromCommand(command) {
  const text = String(command ?? "");
  if (!/^\s*gh\s+workflow\s+run\s/u.test(text)) {
    return {};
  }
  const inputs = {};
  for (const match of text.matchAll(WORKFLOW_INPUT_RE)) {
    const target = TRUSTED_WORKFLOW_INPUTS.get(match[1]);
    const value = (match[3] ?? match[2] ?? "").replace(/^'/u, "").replace(/'$/u, "");
    if (!target || !value) {
      continue;
    }
    let normalized = value;
    if (target === "bareImage" || target === "functionalImage") {
      normalized = maybeGhcrImage(value);
    } else if (target === "allowUnreleasedChangelog" && value !== "true") {
      normalized = "";
    }
    if (normalized) {
      inputs[target] = normalized;
    }
  }
  return inputs;
}

function reuseInputsFromJson(parsed) {
  const bareImage = maybeGhcrImage(parsed.images?.bare);
  const functionalImage = maybeGhcrImage(parsed.images?.functional);
  const allowUnreleasedChangelog = parsed.allowUnreleasedChangelog === true ? "true" : undefined;
  return {
    ...(allowUnreleasedChangelog ? { allowUnreleasedChangelog } : {}),
    ...(bareImage ? { bareImage } : {}),
    ...(functionalImage ? { functionalImage } : {}),
  };
}

function artifactTargetRef(parsed, file, required) {
  const values = [parsed.ref, parsed.github?.selectedSha].filter(
    (value) => value !== undefined && value !== null && value !== "",
  );
  const valid = values.every((value) => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value));
  if (!valid) {
    if (required) {
      throw new Error(`${file} has an invalid artifact target ref; expected a full commit SHA`);
    }
    return "";
  }
  const refs = [...new Set(values)];
  if (refs.length > 1) {
    if (required) {
      throw new Error(`${file} has conflicting artifact target refs: ${refs.join(", ")}`);
    }
    return "";
  }
  return refs[0] || "";
}

function discardMismatchedPreparedImages(entry, explicitRef) {
  if (!explicitRef || entry.artifactRef === explicitRef) {
    return entry;
  }
  const reuseInputs = Object.fromEntries(
    Object.entries(entry.reuseInputs ?? {}).filter(
      ([key]) => key !== "bareImage" && key !== "functionalImage",
    ),
  );
  return { ...entry, reuseInputs };
}

function sameReuseInputs(left, right) {
  return REUSE_INPUT_KEYS.every((key) => (left?.[key] || "") === (right?.[key] || ""));
}

function reuseInputsKey(inputs) {
  return JSON.stringify(REUSE_INPUT_KEYS.map((key) => inputs?.[key] || ""));
}

function commonReuseInputs(entries) {
  const inputs = entries.map((entry) => entry.reuseInputs).filter(Boolean);
  if (inputs.length === 0) {
    return {};
  }
  const [first] = inputs;
  return inputs.every((input) => sameReuseInputs(first, input)) ? first : {};
}

function groupByReuseInputs(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = reuseInputsKey(entry.reuseInputs);
    const group = groups.get(key);
    if (group) {
      group.push(entry);
    } else {
      groups.set(key, [entry]);
    }
  }
  return [...groups.values()];
}

function ghWorkflowCommand(lanes, ref, workflow, reuseInputs = {}) {
  const workflowRef = process.env.OPENCLAW_DOCKER_E2E_WORKFLOW_REF;
  const releasePath = lanes.some(laneNeedsReleasePath);
  const fields = [
    "gh workflow run",
    shellQuote(workflow),
    ...(workflowRef ? ["--ref", shellQuote(workflowRef)] : []),
    "-f",
    `ref=${shellQuote(ref)}`,
    "-f",
    "include_repo_e2e=false",
    "-f",
    `include_release_path_suites=${releasePath ? "true" : "false"}`,
    "-f",
    "include_openwebui=false",
    "-f",
    `docker_lanes=${shellQuote(lanes.join(" "))}`,
    "-f",
    "include_live_suites=false",
    "-f",
    "live_models_only=false",
  ];
  if (reuseInputs.bareImage) {
    fields.push("-f", `docker_e2e_bare_image=${shellQuote(reuseInputs.bareImage)}`);
  }
  if (reuseInputs.functionalImage) {
    fields.push("-f", `docker_e2e_functional_image=${shellQuote(reuseInputs.functionalImage)}`);
  }
  if (reuseInputs.bareImage || reuseInputs.functionalImage) {
    fields.push("-f", "shared_image_policy=existing-only");
  }
  if (reuseInputs.allowUnreleasedChangelog === "true") {
    fields.push("-f", "allow_unreleased_changelog=true");
  }
  if (reuseInputs.publishedUpgradeSurvivorBaseline) {
    fields.push(
      "-f",
      `published_upgrade_survivor_baseline=${shellQuote(
        reuseInputs.publishedUpgradeSurvivorBaseline,
      )}`,
    );
  }
  if (reuseInputs.publishedUpgradeSurvivorBaselines) {
    fields.push(
      "-f",
      `published_upgrade_survivor_baselines=${shellQuote(
        reuseInputs.publishedUpgradeSurvivorBaselines,
      )}`,
    );
  }
  if (reuseInputs.publishedUpgradeSurvivorScenarios) {
    fields.push(
      "-f",
      `published_upgrade_survivor_scenarios=${shellQuote(
        reuseInputs.publishedUpgradeSurvivorScenarios,
      )}`,
    );
  }
  return fields.join(" ");
}

function failureName(failure) {
  return failure.name || failure.lane || "";
}

function failedEntryFromRecord(failure, file, artifactRef, reuseInputs) {
  const lane = failureName(failure);
  const targetable = failure.targetable !== false;
  const workflowInputs = {
    ...trustedReuseInputsFromCommand(failure.ghWorkflowCommand),
    ...reuseInputs,
  };
  return {
    artifactRef,
    lane,
    localRerunCommand: failure.rerunCommand,
    logFile: failure.logFile,
    reuseInputs: workflowInputs,
    source: file,
    status: failure.status,
    targetable,
  };
}

function mergeReuseInputs(left = {}, right = {}) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (value) {
      merged[key] = value;
    }
  }
  return merged;
}

function detectRepo() {
  return run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
}

function findFiles(rootDir, basenames, out = []) {
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const file = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      findFiles(file, basenames, out);
    } else if (basenames.has(entry.name)) {
      out.push(file);
    }
  }
  return out;
}

function failedLaneEntriesFromJson(file, explicitRef = "") {
  const parsed = readJson(file);
  const reuseInputs = reuseInputsFromJson(parsed);
  const source = path.basename(file);
  let failures;
  if (source === "failures.json" && Array.isArray(parsed.lanes)) {
    failures = parsed.lanes.filter((lane) => failureName(lane));
  } else {
    const lanes = Array.isArray(parsed.lanes) ? parsed.lanes : [];
    failures =
      Array.isArray(parsed.failures) && parsed.failures.length > 0
        ? parsed.failures
        : lanes.filter((lane) => lane.status !== 0);
    failures = failures.filter((lane) => failureName(lane));
  }
  const needsTargetRef = !explicitRef && failures.some((failure) => failure.targetable !== false);
  const artifactRef = artifactTargetRef(parsed, file, needsTargetRef);
  return failures.map((failure) =>
    discardMismatchedPreparedImages(
      failedEntryFromRecord(failure, file, artifactRef, reuseInputs),
      explicitRef,
    ),
  );
}

function mergeArtifactRefs(left, right, lane) {
  if (left && right && left !== right) {
    throw new Error(`lane ${lane} has mixed artifact target refs: ${left}, ${right}`);
  }
  return left || right || "";
}

function mergeByLane(entries, explicitRef = "") {
  const byLane = new Map();
  for (const entry of entries) {
    const existing = byLane.get(entry.lane);
    if (existing) {
      byLane.set(entry.lane, {
        ...existing,
        ...entry,
        artifactRef:
          explicitRef || mergeArtifactRefs(existing.artifactRef, entry.artifactRef, entry.lane),
        localRerunCommand: existing.localRerunCommand || entry.localRerunCommand,
        logFile: existing.logFile || entry.logFile,
        reuseInputs: mergeReuseInputs(existing.reuseInputs, entry.reuseInputs),
        source: existing.source || entry.source,
        targetable: existing.targetable !== false && entry.targetable !== false,
      });
    } else {
      byLane.set(entry.lane, { ...entry, artifactRef: explicitRef || entry.artifactRef });
    }
  }
  return [...byLane.values()].toSorted((left, right) => left.lane.localeCompare(right.lane));
}

function resolveTargetRef(entries, explicitRef) {
  const targetable = entries.filter((entry) => entry.targetable !== false);
  if (targetable.length === 0) {
    return "";
  }
  if (explicitRef) {
    if (!/^[a-f0-9]{40}$/u.test(explicitRef)) {
      throw new Error("--ref must be the exact lowercase 40-character target SHA");
    }
    return explicitRef;
  }
  const missing = targetable.filter((entry) => !entry.artifactRef);
  if (missing.length > 0) {
    throw new Error(
      `Docker E2E artifacts are missing an exact target ref for: ${missing.map((entry) => entry.lane).join(", ")}; pass --ref explicitly`,
    );
  }
  const refs = [...new Set(targetable.map((entry) => entry.artifactRef).filter(Boolean))];
  if (refs.length > 1) {
    throw new Error(`Docker E2E artifacts contain mixed target refs: ${refs.join(", ")}`);
  }
  return refs[0] || "";
}

function downloadDockerArtifacts(runId, repo, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const artifacts = JSON.parse(
    run("gh", [
      "api",
      `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
      "--jq",
      ".artifacts",
    ]),
  );
  const names = artifacts
    .filter((artifact) => !artifact.expired && artifact.name.startsWith("docker-e2e-"))
    .map((artifact) => artifact.name);
  if (names.length === 0) {
    throw new Error(`No docker-e2e-* artifacts found for run ${runId}`);
  }
  for (const name of names) {
    run(
      "gh",
      ["run", "download", String(runId), "--repo", repo, "--name", name, "--dir", outputDir],
      {
        stdio: "inherit",
      },
    );
  }
  return names;
}

function runInfo(runId, repo) {
  return JSON.parse(
    run("gh", [
      "run",
      "view",
      String(runId),
      "--repo",
      repo,
      "--json",
      "databaseId,headSha,headBranch,status,conclusion,url,workflowName",
    ]),
  );
}

function safePathSegment(value) {
  return (
    String(value ?? "")
      .replace(/[^a-zA-Z0-9_.-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80) || "run"
  );
}

function defaultOutputDir(input) {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), `openclaw-docker-e2e-rerun-${safePathSegment(input)}-`),
  );
}

function printEntries(entries, ref, workflow, runValue) {
  if (runValue) {
    console.log(`Run: ${runValue.url}`);
    console.log(`Workflow: ${runValue.workflowName}`);
  }
  console.log(`Ref: ${ref}`);
  console.log(
    "Targeted GitHub reruns repack the exact artifact target and reuse GHCR-backed prepared image refs when the downloaded artifacts expose them.",
  );
  if (entries.length === 0) {
    console.log("No failed Docker E2E lanes found.");
    return;
  }
  const workflowEntries = entries.filter((entry) => entry.targetable !== false);
  console.log(`Failed Docker E2E entries: ${entries.map((entry) => entry.lane).join(", ")}`);
  if (workflowEntries.length > 0) {
    console.log("");
    const workflowGroups = groupByReuseInputs(workflowEntries);
    if (workflowGroups.length === 1) {
      console.log("Combined GitHub rerun:");
      console.log(
        ghWorkflowCommand(
          workflowEntries.map((entry) => entry.lane),
          ref,
          workflow,
          commonReuseInputs(workflowEntries),
        ),
      );
    } else {
      console.log("Combined GitHub reruns:");
      for (const group of workflowGroups) {
        const lanes = group.map((entry) => entry.lane);
        console.log(
          `- ${lanes.join(", ")}: ${ghWorkflowCommand(lanes, ref, workflow, group[0]?.reuseInputs)}`,
        );
      }
    }
    console.log("");
    console.log("Per-lane GitHub reruns:");
    for (const entry of workflowEntries) {
      console.log(
        `- ${entry.lane}: ${ghWorkflowCommand([entry.lane], ref, workflow, entry.reuseInputs)}`,
      );
    }
  } else {
    console.log("");
    console.log("No targetable failed Docker E2E lanes found.");
  }
  console.log("");
  console.log("Local rerun starting points:");
  for (const entry of entries) {
    if (entry.localRerunCommand) {
      console.log(`- ${entry.lane}: ${entry.localRerunCommand}`);
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const isLocalJson = fs.existsSync(options.input) && fs.statSync(options.input).isFile();
  if (isLocalJson) {
    const entries = mergeByLane(failedLaneEntriesFromJson(options.input, options.ref), options.ref);
    const ref = resolveTargetRef(entries, options.ref);
    printEntries(entries, ref, options.workflow);
  } else {
    const repo = options.repo || detectRepo();
    const runLocal = runInfo(options.input, repo);
    const outputDir = options.dir || defaultOutputDir(options.input);
    const artifactNames = downloadDockerArtifacts(options.input, repo, outputDir);
    const files = findFiles(outputDir, new Set(["failures.json", "summary.json"]));
    const entries = mergeByLane(
      files.flatMap((file) => failedLaneEntriesFromJson(file, options.ref)),
      options.ref,
    );
    const ref = resolveTargetRef(entries, options.ref);
    console.log(`Artifacts: ${artifactNames.join(", ")}`);
    console.log(`Downloaded: ${outputDir}`);
    printEntries(entries, ref, options.workflow, runLocal);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
