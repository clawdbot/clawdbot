// Builds the shared CLI/package artifacts once before parallel E2E workers
// start long-lived Gateway processes that import those artifacts lazily.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export default async function setup() {
  await execFileAsync(process.execPath, ["scripts/run-node.mjs", "--version"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
    },
    maxBuffer: 8 * 1024 * 1024,
    timeout: 300_000,
  });
  await execFileAsync(
    process.execPath,
    ["scripts/tsdown-build.mjs", "--config", "tsdown.ai.config.ts"],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 300_000,
    },
  );
}
