import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const extraArgs = process.argv.slice(2);
const runner = path.resolve("scripts", "run-oxlint.mjs");

const prepareResult = spawnSync(
  process.execPath,
  [path.resolve("scripts", "prepare-extension-package-boundary-artifacts.mjs")],
  {
    stdio: "inherit",
    env: process.env,
  },
);

if (prepareResult.error) {
  throw prepareResult.error;
}
if ((prepareResult.status ?? 1) !== 0) {
  process.exit(prepareResult.status ?? 1);
}

const shards = [
  {
    name: "core",
    args: ["--tsconfig", "tsconfig.oxlint.core.json", "src", "ui", "packages"],
  },
  {
    name: "extensions",
    args: ["--tsconfig", "tsconfig.oxlint.extensions.json", "extensions"],
  },
  {
    name: "scripts",
    args: ["--tsconfig", "tsconfig.oxlint.scripts.json", "scripts"],
  },
];

const results = await Promise.all(shards.map((shard) => runShard(shard)));
process.exitCode = results.find((status) => status !== 0) ?? 0;

async function runShard(shard) {
  console.error(`[oxlint:${shard.name}] starting`);
  const child = spawn(process.execPath, [runner, ...shard.args, ...extraArgs], {
    stdio: "inherit",
    env: {
      ...process.env,
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
