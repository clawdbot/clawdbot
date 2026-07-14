// Qa Matrix tests cover scenario runtime cli plugin behavior.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { describe, expect, it, vi } from "vitest";
import {
  formatMatrixQaCliCommand,
  redactMatrixQaCliOutput,
  resolveMatrixQaOpenClawCliEntryPath,
  runMatrixQaOpenClawCli,
  startMatrixQaOpenClawCli,
  testing,
} from "./scenario-runtime-cli.js";

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidFile(pathToCheck: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = (await readFile(pathToCheck, "utf8")).trim();
      const pid = Number(value);
      if (/^[1-9]\d*$/u.test(value) && Number.isSafeInteger(pid)) {
        return pid;
      }
    } catch {}
    await sleep(25);
  }
  throw new Error(`Timed out waiting for a PID in ${pathToCheck}`);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

describe("Matrix QA CLI runtime", () => {
  it("redacts secret CLI arguments in diagnostic command text", () => {
    expect(
      formatMatrixQaCliCommand([
        "matrix",
        "verify",
        "backup",
        "restore",
        "--recovery-key",
        "abcdef1234567890ghij",
      ]),
    ).toBe("openclaw matrix verify backup restore --recovery-key [REDACTED]");
    expect(formatMatrixQaCliCommand(["matrix", "account", "add", "--access-token=token-123"])).toBe(
      "openclaw matrix account add --access-token=[REDACTED]",
    );
    expect(
      formatMatrixQaCliCommand(["matrix", "verify", "device", "abcdef1234567890ghij", "--json"]),
    ).toBe("openclaw matrix verify device [REDACTED] --json");
  });

  it("redacts Matrix token output before diagnostics and artifacts", () => {
    expect(
      redactMatrixQaCliOutput("GET /_matrix/client/v3/sync?access_token=abcdef1234567890ghij"),
    ).toBe("GET /_matrix/client/v3/sync?access_token=abcdef…ghij");
  });

  it("force-kills Windows CLI process trees when graceful taskkill fails", () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    const originalSystemRoot = process.env.SystemRoot;
    const originalWindir = process.env.WINDIR;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    process.env.SystemRoot = "C:\\Windows";
    delete process.env.WINDIR;
    try {
      const killMock = vi.fn();
      const child = {
        pid: 12345,
        kill: killMock,
      } as unknown as Parameters<typeof testing.killMatrixQaCliChild>[0];
      const runTaskkill = vi
        .fn()
        .mockReturnValueOnce({ status: 1 })
        .mockReturnValueOnce({ status: 0 });

      testing.killMatrixQaCliChild(child, "SIGTERM", runTaskkill);

      const taskkillPath = path.win32.join("C:\\Windows", "System32", "taskkill.exe");
      expect(runTaskkill).toHaveBeenNthCalledWith(1, taskkillPath, ["/PID", "12345", "/T"], {
        stdio: "ignore",
        windowsHide: true,
      });
      expect(runTaskkill).toHaveBeenNthCalledWith(2, taskkillPath, ["/PID", "12345", "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      expect(killMock).not.toHaveBeenCalled();
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, "platform", platformDescriptor);
      }
      if (originalSystemRoot === undefined) {
        delete process.env.SystemRoot;
      } else {
        process.env.SystemRoot = originalSystemRoot;
      }
      if (originalWindir === undefined) {
        delete process.env.WINDIR;
      } else {
        process.env.WINDIR = originalWindir;
      }
    }
  });

  it("prefers the ESM OpenClaw CLI entrypoint when present", async () => {
    const root = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-entry-"));
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(path.join(root, "dist", "index.mjs"), "");
      expect(resolveMatrixQaOpenClawCliEntryPath(root)).toBe(path.join(root, "dist", "index.mjs"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("can preserve expected non-zero CLI output for negative scenarios", async () => {
    const root = await mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-nonzero-"),
    );
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(
        path.join(root, "dist", "index.mjs"),
        [
          "process.stdout.write(JSON.stringify({ success: false, error: 'expected failure' }));",
          "process.exit(7);",
        ].join("\n"),
      );
      const result = await runMatrixQaOpenClawCli({
        allowNonZero: true,
        args: ["matrix", "verify", "backup", "restore", "--json"],
        cwd: root,
        env: process.env,
        timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toContain('"success":false');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("can pass stdin to CLI commands", async () => {
    const root = await mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-stdin-"));
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(
        path.join(root, "dist", "index.mjs"),
        [
          "let input = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (chunk) => { input += chunk; });",
          "process.stdin.on('end', () => {",
          "  process.stdout.write(JSON.stringify({ input: input.trim() }));",
          "});",
        ].join("\n"),
      );
      const result = await runMatrixQaOpenClawCli({
        args: ["matrix", "verify", "backup", "restore", "--recovery-key-stdin", "--json"],
        cwd: root,
        env: process.env,
        stdin: "stdin-recovery-key\n",
        timeoutMs: 5_000,
      });
      expect(result.stdout).toContain('"input":"stdin-recovery-key"');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("can close stdin after interactive CLI prompts", async () => {
    const root = await mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-interactive-"),
    );
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(
        path.join(root, "dist", "index.mjs"),
        [
          "let input = '';",
          "process.stdin.setEncoding('utf8');",
          "process.stdin.on('data', (chunk) => { input += chunk; process.stdout.write('prompt answered\\n'); });",
          "process.stdin.on('end', () => {",
          "  process.stdout.write(JSON.stringify({ input: input.trim(), ended: true }));",
          "});",
        ].join("\n"),
      );
      const session = startMatrixQaOpenClawCli({
        args: ["matrix", "verify", "self"],
        cwd: root,
        env: process.env,
        timeoutMs: 5_000,
      });
      await session.writeStdin("yes\n");
      await session.waitForOutput(
        (output) => output.text.includes("prompt answered"),
        "interactive prompt acknowledgement",
        5_000,
      );
      session.endStdin();
      const result = await session.wait();

      expect(result.stdout).toContain('"input":"yes"');
      expect(result.stdout).toContain('"ended":true');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("includes timed-out CLI output in diagnostics", async () => {
    const root = await mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-timeout-"),
    );
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(
        path.join(root, "dist", "index.mjs"),
        [
          "process.stdout.write('waiting for verification\\n');",
          "process.stderr.write('matrix sdk still syncing\\n');",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );

      await expect(
        runMatrixQaOpenClawCli({
          args: ["matrix", "verify", "self"],
          cwd: root,
          env: process.env,
          timeoutMs: 250,
        }),
      ).rejects.toThrow(
        /stderr:\nmatrix sdk still syncing[\s\S]*stdout:\nwaiting for verification/u,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("kills CLI commands that ignore graceful timeout termination", async () => {
    const root = await mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-timeout-kill-"),
    );
    const pidPath = path.join(root, "cli.pid");
    let childPid: number | undefined;
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(
        path.join(root, "dist", "index.mjs"),
        [
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
          "process.stdout.write('waiting despite graceful shutdown\\n');",
          "process.on('SIGTERM', () => { process.stdout.write('ignored sigterm\\n'); });",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );

      await expect(
        runMatrixQaOpenClawCli({
          args: ["matrix", "verify", "self"],
          cwd: root,
          env: process.env,
          timeoutMs: 500,
        }),
      ).rejects.toThrow(/timed out after 500ms/u);

      childPid = Number(await readFile(pidPath, "utf8"));
      expect(isProcessRunning(childPid)).toBe(false);
    } finally {
      if (childPid && isProcessRunning(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      await rm(root, { force: true, recursive: true });
    }
  });

  it("preserves timeout diagnostics when wait attaches after timeout", async () => {
    const root = await mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-late-wait-timeout-"),
    );
    const pidPath = path.join(root, "cli.pid");
    let childPid: number | undefined;
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(
        path.join(root, "dist", "index.mjs"),
        [
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
          "process.stdout.write('late wait timeout marker\\n');",
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );

      const session = startMatrixQaOpenClawCli({
        args: ["matrix", "verify", "self"],
        cwd: root,
        env: process.env,
        timeoutMs: 500,
      });
      childPid = await waitForPidFile(pidPath, 2_000);
      await waitForProcessExit(childPid, 2_000);

      await expect(session.wait()).rejects.toThrow(/timed out after 500ms/u);
      await expect(session.wait()).rejects.toThrow(/late wait timeout marker/u);

      expect(isProcessRunning(childPid)).toBe(false);
    } finally {
      if (childPid && isProcessRunning(childPid)) {
        process.kill(childPid, "SIGKILL");
      }
      await rm(root, { force: true, recursive: true });
    }
  });

  it("settles and kills descendants that keep timed-out CLI stdio open", async () => {
    const root = await mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-timeout-tree-"),
    );
    const childPidPath = path.join(root, "child.pid");
    const grandchildPidPath = path.join(root, "grandchild.pid");
    let childPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(
        path.join(root, "dist", "index.mjs"),
        [
          "import { spawn } from 'node:child_process';",
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
          "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: ['ignore', 'inherit', 'inherit'] });",
          `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));`,
          "process.stdout.write('spawned persistent descendant\\n');",
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );

      await expect(
        runMatrixQaOpenClawCli({
          args: ["matrix", "verify", "self"],
          cwd: root,
          env: process.env,
          timeoutMs: 500,
        }),
      ).rejects.toThrow(/timed out after 500ms/u);

      childPid = Number(await readFile(childPidPath, "utf8"));
      grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));
      expect(isProcessRunning(childPid)).toBe(false);
      if (process.platform !== "win32") {
        expect(isProcessRunning(grandchildPid)).toBe(false);
      }
    } finally {
      for (const pid of [grandchildPid, childPid]) {
        if (pid && isProcessRunning(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
      await rm(root, { force: true, recursive: true });
    }
  });

  it("kills ignored-stdio descendants after a timed-out CLI exits gracefully", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-timeout-ignored-stdio-"),
    );
    const childPidPath = path.join(root, "child.pid");
    const grandchildPidPath = path.join(root, "grandchild.pid");
    let childPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(
        path.join(root, "dist", "index.mjs"),
        [
          "import { spawn } from 'node:child_process';",
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
          "const grandchild = spawn(process.execPath, ['-e', 'process.on(\\'SIGTERM\\', () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });",
          "grandchild.unref();",
          `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );

      const run = runMatrixQaOpenClawCli({
        args: ["matrix", "verify", "self"],
        cwd: root,
        env: process.env,
        timeoutMs: 500,
      });
      grandchildPid = await waitForPidFile(grandchildPidPath, 2_000);

      await expect(run).rejects.toThrow(/timed out after 500ms/u);

      childPid = await waitForPidFile(childPidPath, 2_000);
      expect(isProcessRunning(childPid)).toBe(false);
      expect(isProcessRunning(grandchildPid)).toBe(false);
    } finally {
      for (const pid of [grandchildPid, childPid]) {
        if (pid && isProcessRunning(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
      await rm(root, { force: true, recursive: true });
    }
  });

  it("kills ignored-stdio descendants after manual CLI session kill", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "matrix-qa-cli-session-kill-ignored-stdio-"),
    );
    const childPidPath = path.join(root, "child.pid");
    const grandchildPidPath = path.join(root, "grandchild.pid");
    let childPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      await mkdir(path.join(root, "dist"));
      await writeFile(
        path.join(root, "dist", "index.mjs"),
        [
          "import { spawn } from 'node:child_process';",
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
          "const grandchild = spawn(process.execPath, ['-e', 'process.on(\\'SIGTERM\\', () => {}); setInterval(() => {}, 1000);'], { stdio: 'ignore' });",
          "grandchild.unref();",
          `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );

      const session = startMatrixQaOpenClawCli({
        args: ["matrix", "verify", "self"],
        cwd: root,
        env: process.env,
        timeoutMs: 10_000,
      });
      childPid = await waitForPidFile(childPidPath, 2_000);
      grandchildPid = await waitForPidFile(grandchildPidPath, 2_000);

      const sessionExit = session.wait().catch(() => undefined);
      session.kill();

      await Promise.all([
        waitForProcessExit(childPid, 2_000),
        waitForProcessExit(grandchildPid, 2_000),
      ]);
      await sessionExit;
      expect(isProcessRunning(childPid)).toBe(false);
      expect(isProcessRunning(grandchildPid)).toBe(false);
    } finally {
      for (const pid of [grandchildPid, childPid]) {
        if (pid && isProcessRunning(pid)) {
          process.kill(pid, "SIGKILL");
        }
      }
      await rm(root, { force: true, recursive: true });
    }
  });
});
