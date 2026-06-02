import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isRunWithEnvHelpRequest,
  parseRunWithEnvArgs,
  resolveSpawnCommand,
} from "../../scripts/run-with-env.mjs";

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs = 3_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out waiting for child exit"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("run-with-env", () => {
  it("parses leading env assignments before the command separator", () => {
    expect(
      parseRunWithEnvArgs([
        "OPENCLAW_GATEWAY_PROJECT_SHARDS=1",
        "EMPTY=",
        "--",
        "node",
        "scripts/run-vitest.mjs",
        "run",
      ]),
    ).toEqual({
      env: {
        OPENCLAW_GATEWAY_PROJECT_SHARDS: "1",
        EMPTY: "",
      },
      command: "node",
      args: ["scripts/run-vitest.mjs", "run"],
    });
  });

  it("rejects missing command separators", () => {
    expect(() => parseRunWithEnvArgs(["OPENCLAW_GATEWAY_PROJECT_SHARDS=1", "node"])).toThrow(
      /Usage:/u,
    );
  });

  it("prints wrapper help without spawning a command", () => {
    const result = spawnSync(process.execPath, ["scripts/run-with-env.mjs", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: node scripts/run-with-env.mjs");
    expect(result.stderr).toBe("");
  });

  it("keeps command help passthrough after the separator", () => {
    expect(
      isRunWithEnvHelpRequest(["OPENCLAW_GATEWAY_PROJECT_SHARDS=1", "--", "node", "--help"]),
    ).toBe(false);
  });

  it("rejects malformed assignments before spawning", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-with-env.mjs",
        "1INVALID=value",
        "--",
        "node",
        "-e",
        "process.stdout.write('spawned')",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid environment assignment");
  });

  it("uses the current Node executable for node commands", () => {
    expect(resolveSpawnCommand("node", ["scripts/run-vitest.mjs"], "node.exe")).toEqual({
      command: "node.exe",
      args: ["scripts/run-vitest.mjs"],
    });
  });

  it.runIf(process.platform !== "win32").each(["SIGTERM", "SIGHUP"] as const)(
    "forwards parent %s to the wrapped command",
    async (signal) => {
      const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-run-with-env-signals-"));
      const readyFile = path.join(tempDir, "ready");
      const signaledFile = path.join(tempDir, "signaled");
      const handlerLines = ["SIGTERM", "SIGHUP"].flatMap((handledSignal) => [
        `process.on('${handledSignal}', () => {`,
        `  fs.writeFileSync(process.env.SIGNALED_FILE, '${handledSignal}');`,
        "  setTimeout(() => process.exit(0), 25);",
        "});",
      ]);
      const childScript = [
        "const fs = require('node:fs');",
        ...handlerLines,
        "fs.writeFileSync(process.env.READY_FILE, 'ready');",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      const wrapper = spawn(
        process.execPath,
        [
          "scripts/run-with-env.mjs",
          `READY_FILE=${readyFile}`,
          `SIGNALED_FILE=${signaledFile}`,
          "--",
          "node",
          "-e",
          childScript,
        ],
        { cwd: process.cwd(), stdio: "ignore" },
      );

      try {
        await waitFor(() => existsSync(readyFile), "wrapped command readiness");
        wrapper.kill(signal);

        const exit = await waitForExit(wrapper);
        expect(exit).toEqual({ code: null, signal });
        expect(readFileSync(signaledFile, "utf8")).toBe(signal);
      } finally {
        wrapper.kill("SIGKILL");
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")("preserves wrapped command signal exits", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-with-env.mjs",
        "OPENCLAW_RUN_WITH_ENV_SIGNAL_TEST=1",
        "--",
        "node",
        "-e",
        "process.kill(process.pid, 'SIGTERM')",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  it.runIf(process.platform !== "win32")("preserves wrapped command force-kill exits", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-with-env.mjs",
        "OPENCLAW_RUN_WITH_ENV_SIGNAL_TEST=1",
        "--",
        "node",
        "-e",
        "process.kill(process.pid, 'SIGKILL')",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGKILL");
  });
});
