import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import { runUtf8CommandWithTimeout } from "./exec.js";
import { killProcessTree } from "./kill-tree.js";

describe("runUtf8CommandWithTimeout Windows integration", () => {
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
        spawnSync("taskkill", ["/F", "/T", "/PID", String(parentPid)], {
          stdio: "ignore",
          timeout: 5_000,
          windowsHide: true,
        });
        parentStdout.destroy();
      }
    },
    15_000,
  );
});
