import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import {
  inspectNodeWorkerProcessIdentity,
  requireNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "../node-host/node-worker-process-identity.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runUtf8CommandWithTimeout } from "./exec.js";
import { killProcessTree } from "./kill-tree.js";

describe("runUtf8CommandWithTimeout Windows integration", () => {
  it.runIf(process.platform === "win32")(
    "closes a nested Node descendant after an inner spawnSync timeout and outer failure",
    async () => {
      const descendantSource = 'setInterval(() => {}, 1000); process.send("ready");';
      const innerSource = [
        'const { spawn } = require("node:child_process");',
        `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });`,
        'child.once("message", () => process.stdout.write(String(child.pid) + "\\n"));',
      ].join("\n");
      // Match the finalization fence's real child deadline. Each non-detached Node
      // child has libuv job ownership; this does not cover arbitrary grandchildren
      // or hosts that deny job assignment.
      const outerSource = [
        'const { spawnSync } = require("node:child_process");',
        `const result = spawnSync(process.execPath, ["-"], { input: ${JSON.stringify(innerSource)}, stdio: ["pipe", "inherit", "pipe"], timeout: 60_000, killSignal: "SIGKILL", encoding: "utf8", windowsHide: true });`,
        "if (result.error) process.stderr.write(result.error.message);",
        "process.exitCode = result.error || result.status !== 0 ? 1 : 0;",
      ].join("\n");
      const ready = createDeferredCore<NodeWorkerProcessIdentity>();
      const controller = new AbortController();
      let child: NodeWorkerProcessIdentity | undefined;
      let output = "";
      const pending = runUtf8CommandWithTimeout([process.execPath, "-e", outerSource], {
        timeoutMs: 75_000,
        killProcessTree: true,
        signal: controller.signal,
        onOutputChunk: (chunk, stream) => {
          if (stream !== "stdout" || child) {
            return;
          }
          output += chunk.toString("utf8");
          if (output.includes("\n")) {
            child = requireNodeWorkerProcessIdentity(Number(output.trim()));
            ready.resolve(child);
          }
        },
      });
      try {
        const descendant = await Promise.race([
          ready.promise,
          pending.then(() => {
            throw new Error("inner command ended without descendant readiness");
          }),
        ]);
        expect(inspectNodeWorkerProcessIdentity(descendant)).toBe("live");
        await expect(pending).resolves.toMatchObject({
          code: 1,
          termination: "exit",
          stderr: expect.stringContaining("ETIMEDOUT"),
        });
        await vi.waitFor(
          () => {
            expect(inspectNodeWorkerProcessIdentity(descendant)).toBe("dead");
          },
          { timeout: 5_000, interval: 50 },
        );
      } finally {
        controller.abort();
        await pending.catch(() => undefined);
        // Failed assertions still clean only the exact observed fixture process.
        if (child && inspectNodeWorkerProcessIdentity(child) === "live") {
          process.kill(child.pid, "SIGKILL");
          await vi.waitFor(
            () => {
              expect(inspectNodeWorkerProcessIdentity(child!)).toBe("dead");
            },
            { timeout: 5_000, interval: 50 },
          );
        }
      }
    },
    90_000,
  );

  it.runIf(process.platform === "win32")(
    "keeps truncated UTF-8 head output on a code point boundary",
    async () => {
      const result = await runUtf8CommandWithTimeout(
        [process.execPath, "-e", "process.stdout.write('a😀z'); process.stderr.write('b😀y')"],
        {
          maxOutputBytes: 3,
          outputCapture: "head",
          timeoutMs: 3_000,
        },
      );

      expect(result.stdout).toBe("a");
      expect(result.stderr).toBe("b");
      expect(result.stdoutTruncatedBytes).toBe(5);
      expect(result.stderrTruncatedBytes).toBe(5);
    },
  );

  it.runIf(process.platform === "win32")(
    "force-kills a real Windows process tree when graceful taskkill refuses it",
    async () => {
      const program = [
        'const { spawn } = require("node:child_process");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });',
        'child.once("spawn", () => process.stdout.write(String(child.pid) + "\\n"));',
        'child.once("error", () => process.exit(1));',
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const parent = spawn(process.execPath, ["-e", program], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const parentPid = parent.pid;
      const parentStdout = parent.stdout;

      if (parentPid === undefined || parentStdout === null) {
        parent.kill();
        throw new Error("Could not start the Windows process tree");
      }

      try {
        const [output] = await once(parentStdout, "data");
        const childPid = Number.parseInt(String(output).trim(), 10);
        expect(Number.isSafeInteger(childPid)).toBe(true);
        expect(() => process.kill(parentPid, 0)).not.toThrow();
        expect(() => process.kill(childPid, 0)).not.toThrow();

        // An unforced taskkill refuses Node console processes. Cleanup must not
        // depend on this unref'd timer surviving an application shutdown.
        killProcessTree(parentPid, { graceMs: 30_000 });

        await vi.waitFor(
          () => {
            expect(() => process.kill(parentPid, 0)).toThrow();
            expect(() => process.kill(childPid, 0)).toThrow();
          },
          { timeout: 5_000, interval: 50 },
        );
      } finally {
        // The retained child handle is safe after exit; taskkill of its reusable
        // PID is not. This fixture's non-detached Node child is in its libuv job.
        parent.kill("SIGKILL");
        parentStdout.destroy();
      }
    },
    15_000,
  );
});
