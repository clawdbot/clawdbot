import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchJsonWithTimeout, runCommand } from "../../scripts/e2e/telegram-user-credential-io.ts";
import {
  expandHome,
  resolvePrivateJsonDirectory,
  writePrivateJson,
} from "../../scripts/e2e/telegram-user-credential-paths.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`timeout waiting for ${filePath}`);
}

async function waitForDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`process still alive: ${pid}`);
}

async function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null };
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("telegram user credential path handling", () => {
  it("expands home paths with the host path implementation", () => {
    expect(
      expandHome("~/payload.json", {
        env: { HOME: "/home/runner" },
        pathImpl: path.posix,
      }),
    ).toBe("/home/runner/payload.json");
    expect(
      expandHome("~/payload.json", {
        env: { USERPROFILE: String.raw`C:\Users\runner` },
        pathImpl: win32,
      }),
    ).toBe(String.raw`C:\Users\runner\payload.json`);
  });

  it("resolves native Windows private JSON parent directories", () => {
    expect(
      resolvePrivateJsonDirectory(String.raw`C:\Users\runner\AppData\Local\payload.json`, {
        pathImpl: win32,
      }),
    ).toBe(String.raw`C:\Users\runner\AppData\Local`);
  });

  it("resolves relative private JSON output to the current directory", () => {
    expect(resolvePrivateJsonDirectory("payload.json")).toBe(".");
  });

  it("writes private JSON files", async () => {
    const dir = makeTempDir("openclaw-telegram-credential-");
    await writePrivateJson(path.join(dir, "payload.json"), { status: "ok" });
    await expect(readFile(path.join(dir, "payload.json"), "utf8")).resolves.toBe(
      '{\n  "status": "ok"\n}\n',
    );
  });
});

describe("telegram user credential IO", () => {
  it("fails hung child processes instead of waiting for the outer proof timeout", async () => {
    await expect(
      runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], undefined, {
        timeoutMs: 25,
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: expect.stringContaining("timed out after 25ms"),
    });
  });

  it.runIf(process.platform !== "win32")(
    "waits for timed-out child processes to exit before rejecting",
    async () => {
      const dir = makeTempDir("openclaw-telegram-credential-timeout-");
      const terminatedPath = path.join(dir, "terminated.txt");
      const scriptPath = path.join(dir, "ignore-term.cjs");
      writeFileSync(
        scriptPath,
        `
const fs = require("node:fs");
process.on("SIGTERM", () => {
  setTimeout(() => {
    fs.writeFileSync(process.argv[2], "terminated");
    process.exit(0);
  }, 75);
});
setInterval(() => {}, 1000);
`,
        "utf8",
      );

      const runPromise = runCommand(process.execPath, [scriptPath, terminatedPath], undefined, {
        timeoutKillGraceMs: 1_000,
        timeoutMs: 100,
      });
      const runError = runPromise.catch((error: unknown) => error);

      try {
        const error = (await runError) as Error & { code?: string };
        expect(error).toBeInstanceOf(Error);
        expect(error.code).toBe("ETIMEDOUT");
        expect(error.message).toContain("timed out after 100ms");
        expect(existsSync(terminatedPath)).toBe(true);
      } finally {
        await runPromise.catch(() => {});
      }
    },
  );

  it.runIf(process.platform !== "win32")("kills timed-out child process groups", async () => {
    const dir = makeTempDir("openclaw-telegram-credential-tree-timeout-");
    const childPidPath = path.join(dir, "child.pid");
    let childPid: number | undefined;

    try {
      const childScript = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
        `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("");

      const runPromise = runCommand(process.execPath, ["-e", parentScript], dir, {
        timeoutKillGraceMs: 25,
        timeoutMs: 100,
      });
      await waitForFile(childPidPath, 2_000);
      childPid = Number.parseInt(readFileSync(childPidPath, "utf8"), 10);

      await expect(runPromise).rejects.toMatchObject({
        code: "ETIMEDOUT",
        message: expect.stringContaining("timed out after 100ms"),
      });
      await waitForDead(childPid, 2_000);
    } finally {
      if (childPid !== undefined && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
    }
  });

  it.runIf(process.platform !== "win32")(
    "exits promptly after forwarded SIGTERM children exit cleanly",
    async () => {
      const dir = makeTempDir("openclaw-telegram-credential-signal-");
      const runnerPath = path.join(dir, "runner.mjs");
      const readyPath = path.join(dir, "ready.txt");
      const childPidPath = path.join(dir, "child.pid");
      const ioModuleUrl = new URL(
        "../../scripts/e2e/telegram-user-credential-io.ts",
        import.meta.url,
      ).href;
      const childScript = [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
        `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("");
      writeFileSync(
        runnerPath,
        [
          `import { runCommand } from ${JSON.stringify(ioModuleUrl)};`,
          `await runCommand(process.execPath, ['-e', ${JSON.stringify(childScript)}], undefined, { timeoutMs: 30_000 });`,
          "",
        ].join("\n"),
        "utf8",
      );
      const runner = spawn(process.execPath, ["--import", "tsx", runnerPath], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let childPid: number | undefined;
      try {
        await waitForFile(readyPath, 2_000);
        childPid = Number.parseInt(readFileSync(childPidPath, "utf8"), 10);
        const startedAt = Date.now();
        runner.kill("SIGTERM");
        const exit = await waitForExit(runner, 2_000);

        expect(exit).toEqual({ code: 143, signal: null });
        expect(Date.now() - startedAt).toBeLessThan(1_500);
        await waitForDead(childPid, 2_000);
      } finally {
        if (runner.exitCode === null && runner.signalCode === null) {
          runner.kill("SIGKILL");
        }
        if (childPid !== undefined && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps the forwarded signal force-kill armed while grandchildren survive",
    async () => {
      const dir = makeTempDir("openclaw-telegram-credential-grandchild-signal-");
      const runnerPath = path.join(dir, "runner.mjs");
      const readyPath = path.join(dir, "ready.txt");
      const grandchildPidPath = path.join(dir, "grandchild.pid");
      const ioModuleUrl = new URL(
        "../../scripts/e2e/telegram-user-credential-io.ts",
        import.meta.url,
      ).href;
      const grandchildScript = [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(process.pid));`,
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("");
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
        `fs.writeFileSync(${JSON.stringify(readyPath)}, String(grandchild.pid));`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("");
      writeFileSync(
        runnerPath,
        [
          `import { runCommand } from ${JSON.stringify(ioModuleUrl)};`,
          `await runCommand(process.execPath, ['-e', ${JSON.stringify(parentScript)}], undefined, { timeoutMs: 30_000 });`,
          "",
        ].join("\n"),
        "utf8",
      );
      const runner = spawn(process.execPath, ["--import", "tsx", runnerPath], {
        env: {
          ...process.env,
          OPENCLAW_QA_CREDENTIAL_KILL_GRACE_MS: "100",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let grandchildPid: number | undefined;
      try {
        await waitForFile(readyPath, 2_000);
        await waitForFile(grandchildPidPath, 2_000);
        grandchildPid = Number.parseInt(readFileSync(grandchildPidPath, "utf8"), 10);
        runner.kill("SIGTERM");
        const exit = await waitForExit(runner, 2_000);

        expect(exit).toEqual({ code: 143, signal: null });
        await waitForDead(grandchildPid, 2_000);
      } finally {
        if (runner.exitCode === null && runner.signalCode === null) {
          runner.kill("SIGKILL");
        }
        if (grandchildPid !== undefined && isProcessAlive(grandchildPid)) {
          process.kill(grandchildPid, "SIGKILL");
        }
      }
    },
  );

  it("aborts broker fetches that never return", async () => {
    let signal: AbortSignal | undefined;
    await expect(
      fetchJsonWithTimeout({
        url: "https://qa.example.invalid/qa-credentials/v1/acquire",
        label: "credential broker acquire",
        timeoutMs: 25,
        init: { method: "POST" },
        fetchImpl: async (_url, init) => {
          signal = init.signal as AbortSignal | undefined;
          return new Promise<Response>(() => {});
        },
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "credential broker acquire timed out after 25ms",
    });
    expect(signal?.aborted).toBe(true);
  });

  it("times out while waiting for broker JSON bodies", async () => {
    await expect(
      fetchJsonWithTimeout({
        url: "https://qa.example.invalid/qa-credentials/v1/payload-chunk",
        label: "credential broker payload-chunk",
        timeoutMs: 25,
        init: { method: "POST" },
        fetchImpl: async () =>
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            status: 200,
          }),
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "credential broker payload-chunk timed out after 25ms",
    });
  });

  it("bounds broker JSON response bodies", async () => {
    await expect(
      fetchJsonWithTimeout({
        url: "https://qa.example.invalid/qa-credentials/v1/acquire",
        label: "credential broker acquire",
        timeoutMs: 1000,
        maxBodyBytes: 16,
        init: { method: "POST" },
        fetchImpl: async () =>
          new Response(JSON.stringify({ status: "ok", padding: "x".repeat(64) }), {
            status: 200,
          }),
      }),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "credential broker acquire response body exceeded 16 bytes",
    });
  });
});
