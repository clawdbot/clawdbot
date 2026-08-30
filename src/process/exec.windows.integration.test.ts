import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-utils/temp-dir.js";
import { runCommandWithTimeout, runUtf8CommandWithTimeout } from "./exec.js";
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

describe.runIf(process.platform === "win32")("Windows batch argv preservation", () => {
  const cases = [
    { name: "ordinary arguments", args: ["alpha", "omega"] },
    { name: "spaces", args: ["two words", "omega"] },
    { name: "a leading empty argument", args: ["", "omega"] },
    { name: "a middle empty argument", args: ["alpha", "", "omega"] },
    { name: "a trailing empty argument", args: ["alpha", ""] },
    { name: "an embedded tab", args: ["two\twords", "omega"] },
    { name: "a tab-only argument", args: ["\t", "omega"] },
    { name: "double quotes", args: ['say "hello"', "omega"] },
    { name: "a caret", args: ["left^right", "omega"] },
    { name: "a quoted trailing backslash", args: ["C:\\two words\\", "omega"] },
  ];

  it.each(cases)(
    "preserves $name through a real .cmd wrapper",
    async ({ args }) => {
      await withTempDir("openclaw-batch-argv-", async (cwd) => {
        const command = path.join(cwd, "argv.cmd");
        await writeFile(
          path.join(cwd, "argv.cjs"),
          "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
        );
        await writeFile(command, `@"${process.execPath}" "%~dp0argv.cjs" %*\r\n`);
        const result = await runCommandWithTimeout([command, ...args], { cwd, timeoutMs: 5_000 });
        expect(result.code).toBe(0);
        expect(result.termination).toBe("exit");
        expect(JSON.parse(result.stdout)).toEqual(args);
      });
    },
    15_000,
  );

  it.each(["&", "|", "<", ">", "%", "\r", "\n"])(
    "continues to reject unsafe batch argument character %j before launch",
    async (character) => {
      await withTempDir("openclaw-batch-argv-reject-", async (cwd) => {
        const command = path.join(cwd, "argv.cmd");
        await writeFile(command, "@exit /b 99\r\n");
        await expect(
          runCommandWithTimeout([command, `left${character}right`], { cwd, timeoutMs: 5_000 }),
        ).rejects.toThrow("Unsafe Windows cmd.exe argument detected");
      });
    },
  );
});
