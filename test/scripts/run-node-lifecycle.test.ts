import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { isProcessAlive, waitForDead, waitForPidFile } from "../helpers/process-wait.js";
import { formatShimResult, withShimFixture } from "./direct-run-entrypoints.test-support.js";

it.runIf(process.platform !== "win32").each(["SIGTERM", "SIGHUP"] as const)(
  "joins the dev runner's resistant child before returning from %s",
  async (signal) => {
    await withShimFixture("scripts/run-node.mjs", async (fixture) => {
      const { checkoutRoot, fixtureRoot, implementationPath, wrapperPath, runNode } = fixture;
      const childPidPath = path.join(fixtureRoot, "child.pid");
      const wrapperPidPath = path.join(fixtureRoot, "wrapper.pid");
      const childPath = path.join(fixtureRoot, "resistant-child.mjs");
      writeFileSync(
        childPath,
        `import fs from "node:fs";
process.on("SIGTERM", () => {});
process.on("SIGHUP", () => {});
fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));
setInterval(() => {}, 1000);
`,
      );
      const implementationUrl = pathToFileURL(path.resolve("scripts/run-node.mts")).href;
      writeFileSync(
        implementationPath,
        `import fs from "node:fs";
import { spawn } from "node:child_process";
import { runNodeMain } from ${JSON.stringify(implementationUrl)};
fs.writeFileSync(${JSON.stringify(wrapperPidPath)}, String(process.ppid));
process.exit(await runNodeMain({
  cwd: ${JSON.stringify(checkoutRoot)},
  env: { ...process.env, OPENCLAW_FORCE_BUILD: "1", OPENCLAW_RUNNER_LOG: "0" },
  spawn: (_command, _args, options) => spawn(process.execPath, [${JSON.stringify(childPath)}], {
    ...options, stdio: "ignore",
  }),
}));
`,
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PNPM_CONFIG_MODULES_DIR: path.dirname(
          path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")),
        ),
      };
      delete env.NODE_OPTIONS;
      const command = runNode([wrapperPath], env, checkoutRoot);
      try {
        const childPid = await waitForPidFile(childPidPath, 5_000);
        const wrapperPid = await waitForPidFile(wrapperPidPath, 5_000);
        process.kill(wrapperPid, signal);
        const result = await command;
        expect(result.error, formatShimResult(result)).toBeUndefined();
        expect(isProcessAlive(childPid), "the stopped runner still owns a live child").toBe(false);
        expect(result.status).not.toBe(0);
      } finally {
        // Negative controls can orphan a separate process group; the test owns its cleanup.
        if (existsSync(childPidPath)) {
          const childPid = Number(readFileSync(childPidPath, "utf8"));
          if (isProcessAlive(childPid)) {
            process.kill(-childPid, "SIGKILL");
          }
          await waitForDead(childPid, 5_000);
        }
        await command;
      }
    });
  },
);
