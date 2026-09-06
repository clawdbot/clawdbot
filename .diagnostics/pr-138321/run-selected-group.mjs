import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const inputRoot = dirname(fileURLToPath(import.meta.url));
const cwd = resolve(inputRoot, "../..");
const groups = JSON.parse(readFileSync(join(inputRoot, "selected-group.json"), "utf8"));
const recorded = JSON.parse(readFileSync(join(inputRoot, "recorded-env.json"), "utf8"));
if (
  process.versions.node !== "24.20.0" ||
  groups.length !== 1 ||
  groups[0].includePatterns.length !== 132
) {
  throw new Error("Original Node or selected group does not match");
}
if (existsSync(join(cwd, "dist")) || existsSync(join(cwd, "dist-runtime"))) {
  throw new Error("This observation requires the original source-only root");
}
execFileSync(
  "git",
  ["merge-base", "--is-ancestor", "0249635cbf06cce81e5877f403ca619b5f42847e", "HEAD"],
  { cwd },
);
const env = {
  ...process.env,
  ...recorded,
  CI: "true",
  OPENCLAW_NODE_TEST_GROUPS_JSON: JSON.stringify(groups),
};
for (const key of [
  "OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64",
  "OPENCLAW_NODE_TEST_TARGETS_JSON",
  "OPENCLAW_VITEST_INCLUDE_FILE",
])
  delete env[key];
console.error(
  JSON.stringify({ marker: "ui-acp-observation-input", groups, recorded, node: process.version }),
);
const child = spawn(process.execPath, ["--import", "tsx", "scripts/ci-run-node-test-shard.mts"], {
  cwd,
  env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  console.error(JSON.stringify({ marker: "ui-acp-observation-exit", code, signal }));
  process.exitCode = code ?? 1;
});
