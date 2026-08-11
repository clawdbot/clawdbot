// Voice Call process tests exercise real tunnel child shutdown behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startTunnel } from "./tunnel.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(pidPath: string): Promise<number> {
  let pid = Number.NaN;
  await expect
    .poll(
      async () => {
        try {
          pid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
          return Number.isInteger(pid) && pid > 0;
        } catch {
          return false;
        }
      },
      { timeout: 2_000, interval: 20 },
    )
    .toBe(true);
  return pid;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  try {
    await expect.poll(() => isProcessAlive(pid), { timeout: timeoutMs, interval: 20 }).toBe(false);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("voice-call tunnel child shutdown", () => {
  it("force-kills ngrok when it ignores graceful shutdown", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ngrok-stop-"));
    const pidPath = path.join(tempDir, "ngrok.pid");
    const ngrokPath = path.join(tempDir, "ngrok");
    const previousPath = process.env.PATH;
    const previousPidPath = process.env.OPENCLAW_NGROK_PID_FILE;
    let childPid: number | undefined;

    await fs.writeFile(
      ngrokPath,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'process.on("SIGTERM", () => {});',
        "fs.writeFileSync(process.env.OPENCLAW_NGROK_PID_FILE, String(process.pid));",
        'process.stdout.write(JSON.stringify({ msg: "started tunnel", url: "https://bounded.ngrok.test" }) + "\\n");',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${tempDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.OPENCLAW_NGROK_PID_FILE = pidPath;

    try {
      const tunnel = await startTunnel({
        provider: "ngrok",
        port: 3334,
        path: "/voice/webhook",
      });
      if (!tunnel) {
        throw new Error("Expected ngrok tunnel to start");
      }
      childPid = await readPid(pidPath);

      await tunnel.stop();

      expect(await waitForProcessExit(childPid, 1_000)).toBe(true);
    } finally {
      process.env.PATH = previousPath;
      if (previousPidPath === undefined) {
        delete process.env.OPENCLAW_NGROK_PID_FILE;
      } else {
        process.env.OPENCLAW_NGROK_PID_FILE = previousPidPath;
      }
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
        await waitForProcessExit(childPid, 1_000);
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("force-kills ngrok before rejecting a startup timeout", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ngrok-timeout-"));
    const pidPath = path.join(tempDir, "ngrok.pid");
    const signalPath = path.join(tempDir, "ngrok.signal");
    const ngrokPath = path.join(tempDir, "ngrok");
    const previousPath = process.env.PATH;
    const previousPidPath = process.env.OPENCLAW_NGROK_PID_FILE;
    const previousSignalPath = process.env.OPENCLAW_NGROK_SIGNAL_FILE;
    let childPid: number | undefined;

    await fs.writeFile(
      ngrokPath,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'process.on("SIGTERM", () => fs.writeFileSync(process.env.OPENCLAW_NGROK_SIGNAL_FILE, "SIGTERM"));',
        "fs.writeFileSync(process.env.OPENCLAW_NGROK_PID_FILE, String(process.pid));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.PATH = `${tempDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.OPENCLAW_NGROK_PID_FILE = pidPath;
    process.env.OPENCLAW_NGROK_SIGNAL_FILE = signalPath;

    try {
      const result = startTunnel({
        provider: "ngrok",
        port: 3334,
        path: "/voice/webhook",
      });
      childPid = await readPid(pidPath);

      await expect(result).rejects.toThrow("ngrok startup timed out (30s)");

      await expect
        .poll(
          async () => {
            try {
              return await fs.readFile(signalPath, "utf8");
            } catch {
              return "";
            }
          },
          { timeout: 1_000, interval: 20 },
        )
        .toBe("SIGTERM");
      expect(await waitForProcessExit(childPid, 1_000)).toBe(true);
    } finally {
      process.env.PATH = previousPath;
      if (previousPidPath === undefined) {
        delete process.env.OPENCLAW_NGROK_PID_FILE;
      } else {
        process.env.OPENCLAW_NGROK_PID_FILE = previousPidPath;
      }
      if (previousSignalPath === undefined) {
        delete process.env.OPENCLAW_NGROK_SIGNAL_FILE;
      } else {
        process.env.OPENCLAW_NGROK_SIGNAL_FILE = previousSignalPath;
      }
      if (childPid && isProcessAlive(childPid)) {
        process.kill(childPid, "SIGKILL");
        await waitForProcessExit(childPid, 1_000);
      }
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 40_000);
});
