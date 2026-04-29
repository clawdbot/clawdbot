#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  evaluateLocalTestboxKey,
  evaluateOpenClawTestboxClaim,
  resolveTestboxId,
  writeOpenClawTestboxClaim,
} from "./blacksmith-testbox-state.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function splitRunnerArgs(argv = []) {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex === -1) {
    return { runnerArgs: argv, commandArgs: [] };
  }
  return {
    runnerArgs: argv.slice(0, separatorIndex),
    commandArgs: argv.slice(separatorIndex + 1),
  };
}

export function buildBlacksmithRunArgs({ commandArgs, testboxId }) {
  const command = commandArgs.join(" ").trim();
  if (!command) {
    return [];
  }
  return ["testbox", "run", "--id", testboxId, command];
}

function hasClaimFlag(runnerArgs) {
  return runnerArgs.includes("--claim") || runnerArgs.includes("--claim-fresh");
}

function stripRunnerOnlyFlags(runnerArgs) {
  return runnerArgs.filter((arg) => arg !== "--claim" && arg !== "--claim-fresh");
}

export function runBlacksmithTestboxRunner({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  spawn = spawnSync,
  stderr = process.stderr,
  stdout = process.stdout,
} = {}) {
  const { runnerArgs, commandArgs } = splitRunnerArgs(argv);
  const shouldClaim = hasClaimFlag(runnerArgs);
  const testboxId = resolveTestboxId({ argv: stripRunnerOnlyFlags(runnerArgs), env });
  if (!testboxId) {
    stderr.write(
      "Missing Testbox id. Pass `--id <tbx_id>` or set OPENCLAW_TESTBOX_ID from this session's warmup output.\n",
    );
    return 2;
  }

  const keyResult = evaluateLocalTestboxKey({ env, testboxId });
  if (!keyResult.ok) {
    stderr.write(`${keyResult.problems.join("\n")}\n`);
    stderr.write(
      "Refusing to reuse a remote-visible Testbox without the local private key. Run:\n" +
        "  blacksmith testbox warmup ci-check-testbox.yml --ref main --idle-timeout 90\n",
    );
    return 2;
  }

  const root = git(["rev-parse", "--show-toplevel"], cwd).trim();
  if (path.resolve(cwd) !== path.resolve(root)) {
    stderr.write(
      `Refusing to run Testbox sync from ${cwd}; run from repo root ${root} so rsync does not mirror a subdirectory.\n`,
    );
    return 2;
  }

  if (shouldClaim) {
    const claim = writeOpenClawTestboxClaim({ cwd: root, env, testboxId });
    stdout.write(`OpenClaw Testbox claim written: ${testboxId} -> ${claim.claimPath}\n`);
  } else {
    const claimResult = evaluateOpenClawTestboxClaim({
      cwd: root,
      env,
      testboxId,
    });
    if (!claimResult.ok) {
      stderr.write(`${claimResult.problems.join("\n")}\n`);
      stderr.write(
        "Refusing to run a Testbox that was not claimed by this OpenClaw checkout. Run:\n" +
          "  blacksmith testbox warmup ci-check-testbox.yml --ref main --idle-timeout 90\n" +
          "  pnpm testbox:claim --id <new_tbx_id>\n",
      );
      return 2;
    }
  }

  const blacksmithArgs = buildBlacksmithRunArgs({ commandArgs, testboxId });
  if (blacksmithArgs.length === 0) {
    stdout.write(`Testbox local key and OpenClaw claim ok: ${testboxId}\n`);
    return 0;
  }

  const result = spawn("blacksmith", blacksmithArgs, {
    cwd,
    env,
    stdio: "inherit",
  });
  if (typeof result.status === "number") {
    return result.status;
  }
  if (result.error) {
    stderr.write(`Failed to start blacksmith: ${result.error.message}\n`);
  }
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runBlacksmithTestboxRunner();
}
