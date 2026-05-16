import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  resolveLocalHeavyCheckEnv,
  shouldAcquireLocalHeavyCheckLockForOxlint,
} from "./lib/local-heavy-check-runtime.mjs";

const extraArgs = process.argv.slice(2);
const runner = path.resolve("scripts", "run-oxlint.mjs");
const env = resolveLocalHeavyCheckEnv(process.env);
const hasMetadataOnlyFlag = extraArgs.some((arg) =>
  ["--help", "-h", "--version", "-V", "--rules", "--print-config", "--init"].includes(arg),
);
const shouldAcquireParentLock =
  !hasMetadataOnlyFlag ||
  shouldAcquireLocalHeavyCheckLockForOxlint(extraArgs, {
    cwd: process.cwd(),
    env,
  });
const releaseLock =
  env.OPENCLAW_OXLINT_SKIP_LOCK === "1"
    ? () => {}
    : shouldAcquireParentLock
      ? acquireLocalHeavyCheckLockSync({
          cwd: process.cwd(),
          env,
          toolName: "oxlint shards",
        })
      : () => {};

const shards = [
  {
    name: "core",
    args: ["--tsconfig", "config/tsconfig/oxlint.core.json", "src", "ui", "packages"],
  },
  {
    name: "extensions",
    args: ["--tsconfig", "config/tsconfig/oxlint.extensions.json", "extensions"],
  },
  {
    name: "scripts",
    args: ["--tsconfig", "config/tsconfig/oxlint.scripts.json", "scripts"],
  },
];

try {
  const prepareResult = spawnSync(
    process.execPath,
    [path.resolve("scripts", "prepare-extension-package-boundary-artifacts.mjs")],
    {
      stdio: "inherit",
      env,
    },
  );

  if (prepareResult.error) {
    throw prepareResult.error;
  }
  if ((prepareResult.status ?? 1) !== 0) {
    process.exitCode = prepareResult.status ?? 1;
  } else {
    const runSerial = env.OPENCLAW_OXLINT_SHARDS_SERIAL === "1";
    const results = runSerial
      ? await runShardsSerial(shards)
      : await Promise.all(shards.map((shard) => runShard(shard)));
    process.exitCode = results.find((status) => status !== 0) ?? 0;
  }
} finally {
  releaseLock();
}

async function runShardsSerial(entries) {
  const results = [];
  for (const shard of entries) {
    results.push(await runShard(shard));
  }
  return results;
}

async function runShard(shard) {
  console.error(`[oxlint:${shard.name}] starting`);
  const child = spawn(process.execPath, [runner, ...shard.args, ...extraArgs], {
    stdio: "inherit",
    env: {
      ...env,
      OPENCLAW_OXLINT_SKIP_LOCK: "1",
      OPENCLAW_OXLINT_SKIP_PREPARE: "1",
    },
  });

  return await new Promise((resolve) => {
    child.once("error", (error) => {
      console.error(error);
      resolve(1);
    });
    child.once("close", (status) => {
      console.error(`[oxlint:${shard.name}] finished`);
      resolve(status ?? 1);
    });
  });
}
