#!/usr/bin/env node
// Builds cheap rerun commands from a Docker E2E GitHub run or local summary.
// For GitHub runs, the script downloads Docker E2E artifacts, reads
// summary/failures JSON, and prints targeted workflow commands for failed
// lanes, reusing package artifacts and prepared GHCR images when artifacts
// expose them.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    input: "",
    ref: "",
    repo: "",
    workflow: DEFAULT_WORKFLOW,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") {
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
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function maybeGhcrImage(value) {
  return typeof value === "string" && value.startsWith("ghcr.io/") ? value : "";
}

function reuseInputsFromJson(parsed) {
  const packageArtifactRunId = parsed.github?.runId || "";
  if (!packageArtifactRunId) {
    return {};
  }
  return {
    bareImage: maybeGhcrImage(parsed.images?.bare),
    functionalImage: maybeGhcrImage(parsed.images?.functional),
    packageArtifactName:
      parsed.packageArtifactName || parsed.artifacts?.packageName || "docker-e2e-package",
    packageArtifactRunId,
  };
}

function sameReuseInputs(left, right) {
  return (
    (left?.packageArtifactRunId || "") === (right?.packageArtifactRunId || "") &&
    (left?.packageArtifactName || "") === (right?.packageArtifactName || "") &&
    (left?.bareImage || "") === (right?.bareImage || "") &&
    (left?.functionalImage || "") === (right?.functionalImage || "")
  );
}

function commonReuseInputs(entries) {
  const inputs = entries.map((entry) => entry.reuseInputs).filter(Boolean);
  if (inputs.length === 0) {
    return {};
  }
  const [first] = inputs;
  return inputs.every((input) => sameReuseInputs(first, input)) ? first : {};
}

function ghWorkflowCommand(lanes, ref, workflow, reuseInputs = {}) {
  const fields = [
    "gh workflow run",
    shellQuote(workflow),
    "-f",
    `ref=${shellQuote(ref)}`,
    "-f",
    "include_repo_e2e=false",
    "-f",
    "include_release_path_suites=false",
    "-f",
    "include_openwebui=false",
    "-f",
    `docker_lanes=${shellQuote(lanes.join(" "))}`,
    "-f",
    "include_live_suites=false",
    "-f",
    "live_models_only=false",
  ];
  if (reuseInputs.packageArtifactRunId) {
    fields.push("-f", `package_artifact_run_id=${shellQuote(reuseInputs.packageArtifactRunId)}`);
    fields.push(
      "-f",
      `package_artifact_name=${shellQuote(reuseInputs.packageArtifactName || "docker-e2e-package")}`,
    );
  }
  if (reuseInputs.bareImage) {
    fields.push("-f", `docker_e2e_bare_image=${shellQuote(reuseInputs.bareImage)}`);
  }
  if (reuseInputs.functionalImage) {
    fields.push("-f", `docker_e2e_functional_image=${shellQuote(reuseInputs.functionalImage)}`);
  }
  return fields.join(" ");
}

function detectRepo() {
  return JSON.parse(run("gh", ["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
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

function failedLaneEntriesFromJson(file, ref, workflow) {
  const parsed = readJson(file);
  const reuseInputs = reuseInputsFromJson(parsed);
  const source = path.basename(file);
  if (source === "failures.json" && Array.isArray(parsed.lanes)) {
    return parsed.lanes
      .filter((lane) => lane.name)
      .map((lane) => ({
        ghWorkflowCommand:
          lane.ghWorkflowCommand || ghWorkflowCommand([lane.name], ref, workflow, reuseInputs),
        lane: lane.name,
        localRerunCommand: lane.rerunCommand,
        logFile: lane.logFile,
        reuseInputs,
        source: file,
        status: lane.status,
      }));
  }

  const lanes = Array.isArray(parsed.lanes) ? parsed.lanes : [];
  return lanes
    .filter((lane) => lane.status !== 0 && lane.name)
    .map((lane) => ({
      ghWorkflowCommand: ghWorkflowCommand([lane.name], ref, workflow, reuseInputs),
      lane: lane.name,
      localRerunCommand: lane.rerunCommand,
      logFile: lane.logFile,
      reuseInputs,
      source: file,
      status: lane.status,
    }));
}

function mergeByLane(entries) {
  const byLane = new Map();
  for (const entry of entries) {
    if (!byLane.has(entry.lane)) {
      byLane.set(entry.lane, entry);
    }
  }
  return [...byLane.values()].toSorted((left, right) => left.lane.localeCompare(right.lane));
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

function printEntries(entries, ref, workflow, run) {
  if (run) {
    console.log(`Run: ${run.url}`);
    console.log(`Workflow: ${run.workflowName}`);
  }
  console.log(`Ref: ${ref}`);
  console.log(
    "Targeted GitHub reruns reuse package artifacts and prepared GHCR images when the downloaded artifacts expose them.",
  );
  if (entries.length === 0) {
    console.log("No failed Docker E2E lanes found.");
    return;
  }
  console.log(`Failed lanes: ${entries.map((entry) => entry.lane).join(", ")}`);
  console.log("");
  console.log("Combined GitHub rerun:");
  console.log(
    ghWorkflowCommand(
      entries.map((entry) => entry.lane),
      ref,
      workflow,
      commonReuseInputs(entries),
    ),
  );
  console.log("");
  console.log("Per-lane GitHub reruns:");
  for (const entry of entries) {
    console.log(
      `- ${entry.lane}: ${entry.ghWorkflowCommand || ghWorkflowCommand([entry.lane], ref, workflow)}`,
    );
  }
  console.log("");
  console.log("Local rerun starting points:");
  for (const entry of entries) {
    if (entry.localRerunCommand) {
      console.log(`- ${entry.lane}: ${entry.localRerunCommand}`);
    }
  }
}

const options = parseArgs(process.argv.slice(2));
const isLocalJson = fs.existsSync(options.input) && fs.statSync(options.input).isFile();
if (isLocalJson) {
  const ref = options.ref || process.env.GITHUB_SHA || "HEAD";
  printEntries(
    mergeByLane(failedLaneEntriesFromJson(options.input, ref, options.workflow)),
    ref,
    options.workflow,
  );
} else {
  const repo = options.repo || detectRepo();
  const run = runInfo(options.input, repo);
  const ref = options.ref || run.headSha || run.headBranch;
  const outputDir =
    options.dir || path.join(os.tmpdir(), `openclaw-docker-e2e-rerun-${options.input}`);
  const artifactNames = downloadDockerArtifacts(options.input, repo, outputDir);
  const files = findFiles(outputDir, new Set(["failures.json", "summary.json"]));
  const entries = mergeByLane(
    files.flatMap((file) => failedLaneEntriesFromJson(file, ref, options.workflow)),
  );
  console.log(`Artifacts: ${artifactNames.join(", ")}`);
  console.log(`Downloaded: ${outputDir}`);
  printEntries(entries, ref, options.workflow, run);
}
