import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  formatCliProcessFailure,
  runCliProcessChild,
} from "../cli/cli-process-child.test-helpers.js";

it("exits after a stop frame while the supervisor keeps stdin open", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-worker-exit-")));
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({ nodeHost: { skills: { enabled: false } } }));
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_STATE_DIR: stateDir,
  };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  try {
    const result = await runCliProcessChild({
      nodeArgs: [path.resolve("openclaw.mjs"), "node", "worker"],
      env,
      interact: async (child) => {
        let stdout = "";
        let stderr = "";
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        await new Promise<void>((resolve, reject) => {
          const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            reject(new Error(`worker exited before ready: ${code ?? signal}`));
          };
          const onData = (chunk: string) => {
            stdout += chunk;
            if (stdout.includes('"type":"ready"')) {
              child.stdout.off("data", onData);
              child.off("exit", onExit);
              resolve();
            }
          };
          child.stdout.on("data", onData);
          child.once("exit", onExit);
        });
        child.stdin.write('{"type":"stop"}\n');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(
              new Error(
                formatCliProcessFailure({
                  reason: "worker stayed alive after stop while stdin remained open",
                  stdout,
                  stderr,
                }),
              ),
            );
          }, 2_500);
          timer.unref();
          void once(child, "exit").then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
    });

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
