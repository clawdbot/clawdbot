#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";

const WORKFLOW = "full-release-validation.yml";
const DEFAULT_INPUTS = {
  provider: "openai",
  mode: "both",
  release_profile: "full",
  rerun_group: "all",
};

function usage() {
  console.error(`Usage: node scripts/full-release-validation-at-sha.mjs [--sha <sha>] [--branch <name>] [--keep-branch] [--dry-run] [-- -f key=value ...]

Creates a temporary remote branch pinned to the target commit, dispatches Full
Release Validation from that branch, watches the parent run, verifies all child
workflow head SHAs match, then deletes the temporary branch by default.`);
}

function run(command, args, options = {}) {
  if (options.dryRun) {
    console.log(["+", command, ...args].join(" "));
    return "";
  }
  const output = execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "inherit"],
  });
  return typeof output === "string" ? output.trim() : "";
}

function runStatus(command, args, options = {}) {
  if (options.dryRun) {
    console.log(["+", command, ...args].join(" "));
    return { status: 0, stdout: "" };
  }
  return spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "inherit"],
  });
}

function parseArgs(argv) {
  const args = {
    sha: "",
    branch: "",
    keepBranch: false,
    dryRun: false,
    inputs: { ...DEFAULT_INPUTS },
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--sha") {
      args.sha = argv[++i] ?? "";
      continue;
    }
    if (arg === "--branch") {
      args.branch = argv[++i] ?? "";
      continue;
    }
    if (arg === "--keep-branch") {
      args.keepBranch = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--") {
      for (const extra of argv.slice(i + 1)) {
        const assignment = extra.startsWith("-f") ? extra.slice(2).trim() : extra;
        const [key, ...valueParts] = assignment.split("=");
        if (!key || valueParts.length === 0) {
          throw new Error(`Unsupported extra argument after --: ${extra}`);
        }
        args.inputs[key] = valueParts.join("=");
      }
      break;
    }
    if (arg === "-f") {
      const assignment = argv[++i] ?? "";
      const [key, ...valueParts] = assignment.split("=");
      if (!key || valueParts.length === 0) {
        throw new Error(`Invalid -f assignment: ${assignment}`);
      }
      args.inputs[key] = valueParts.join("=");
      continue;
    }
    if (arg.startsWith("-f") && arg.includes("=")) {
      const assignment = arg.slice(2).trim();
      const [key, ...valueParts] = assignment.split("=");
      if (!key || valueParts.length === 0) {
        throw new Error(`Invalid -f assignment: ${arg}`);
      }
      args.inputs[key] = valueParts.join("=");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function sanitizeBranchPart(value) {
  return value
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^[/.-]+|[/.-]+$/g, "")
    .slice(0, 80);
}

function resolveSha(requestedSha) {
  const rev = requestedSha || "HEAD";
  return run("git", ["rev-parse", "--verify", `${rev}^{commit}`], { dryRun: false });
}

function collectRunId(dispatchOutput) {
  const match = dispatchOutput.match(/actions\/runs\/(\d+)/);
  return match?.[1] ?? "";
}

function findLatestRunId(branch, sha) {
  const json = run("gh", [
    "run",
    "list",
    "--workflow",
    WORKFLOW,
    "--branch",
    branch,
    "--event",
    "workflow_dispatch",
    "--limit",
    "20",
    "--json",
    "databaseId,headSha,createdAt",
  ]);
  const runs = JSON.parse(json);
  const match = runs.find((runItem) => runItem.headSha === sha);
  return match?.databaseId ? String(match.databaseId) : "";
}

function childRunIds(parentRunId) {
  const jobsJson = run("gh", ["run", "view", parentRunId, "--json", "jobs"]);
  const jobs = JSON.parse(jobsJson).jobs ?? [];
  const summaryJob = jobs.find((job) => job.name === "Verify full validation");
  if (!summaryJob?.databaseId) {
    return [];
  }
  const log = run("gh", [
    "run",
    "view",
    parentRunId,
    "--job",
    String(summaryJob.databaseId),
    "--log",
  ]);
  return [...new Set([...log.matchAll(/actions\/runs\/(\d+)/g)].map((match) => match[1]))];
}

function verifyChildHeads(parentRunId, sha) {
  const ids = childRunIds(parentRunId);
  if (ids.length === 0) {
    throw new Error(
      `Could not find child workflow run ids in parent verifier logs for ${parentRunId}.`,
    );
  }

  let failed = false;
  for (const id of ids) {
    const json = run("gh", ["run", "view", id, "--json", "name,status,conclusion,headSha,url"]);
    const child = JSON.parse(json);
    const ok =
      child.headSha === sha && child.status === "completed" && child.conclusion === "success";
    console.log(
      `${ok ? "ok" : "bad"} ${child.name} ${child.status}/${child.conclusion} ${child.headSha} ${child.url}`,
    );
    failed ||= !ok;
  }
  if (failed) {
    throw new Error(`One or more child workflows failed or did not run at ${sha}.`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sha = resolveSha(args.sha);
  const shortSha = sha.slice(0, 12);
  const branch = sanitizeBranchPart(args.branch || `release-ci/${shortSha}-${Date.now()}`);
  const remoteBranchRef = `refs/heads/${branch}`;
  const dispatchInputs = { ref: sha, ...args.inputs };

  console.log(`Target SHA: ${sha}`);
  console.log(`Temporary workflow ref: ${branch}`);

  run("git", ["push", "origin", `${sha}:${remoteBranchRef}`], {
    dryRun: args.dryRun,
    stdio: "inherit",
  });

  let parentRunId = "";
  try {
    const dispatchArgs = ["workflow", "run", WORKFLOW, "--ref", branch];
    for (const [key, value] of Object.entries(dispatchInputs)) {
      dispatchArgs.push("-f", `${key}=${value}`);
    }

    const dispatchOutput = run("gh", dispatchArgs, { dryRun: args.dryRun });
    if (dispatchOutput) {
      console.log(dispatchOutput);
    }
    parentRunId = collectRunId(dispatchOutput);
    if (!parentRunId && !args.dryRun) {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        parentRunId = findLatestRunId(branch, sha);
        if (parentRunId) {
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
      }
    }
    if (!parentRunId) {
      if (args.dryRun) {
        return;
      }
      throw new Error("Could not determine Full Release Validation run id.");
    }

    console.log(`Parent run: https://github.com/openclaw/openclaw/actions/runs/${parentRunId}`);
    const watch = runStatus(
      "gh",
      ["run", "watch", parentRunId, "--exit-status", "--interval", "30"],
      {
        stdio: "inherit",
      },
    );
    if (watch.status !== 0) {
      throw new Error(
        `Full Release Validation failed: https://github.com/openclaw/openclaw/actions/runs/${parentRunId}`,
      );
    }
    verifyChildHeads(parentRunId, sha);
  } finally {
    if (!args.keepBranch) {
      run("git", ["push", "origin", `:${remoteBranchRef}`], {
        dryRun: args.dryRun,
        stdio: "inherit",
      });
    } else {
      console.log(`Kept ${remoteBranchRef}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
