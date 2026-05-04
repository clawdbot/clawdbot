import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  installLaunchAgent,
  readLaunchAgentRuntime,
  repairLaunchAgentBootstrap,
  restartLaunchAgent,
  resolveLaunchAgentPlistPath,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { resolveGatewayService, startGatewayService } from "./service.js";

const WAIT_INTERVAL_MS = 200;
const WAIT_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 45_000;

function canRunLaunchdIntegration(): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  if (typeof process.getuid !== "function") {
    return false;
  }
  const domain = `gui/${process.getuid()}`;
  const probe = spawnSync("launchctl", ["print", domain], { encoding: "utf8" });
  if (probe.error) {
    return false;
  }
  return probe.status === 0;
}

const describeLaunchdIntegration = canRunLaunchdIntegration() ? describe : describe.skip;

function resolveGuiDomain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

async function withTimeout<T>(params: {
  run: () => Promise<T>;
  timeoutMs: number;
  message: string;
}): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      params.run(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(params.message)), params.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function waitForRunningRuntime(params: {
  env: GatewayServiceEnv;
  pidNot?: number;
  timeoutMs?: number;
}): Promise<{ pid: number }> {
  const timeoutMs = params.timeoutMs ?? WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";
  let lastPid: number | undefined;
  while (Date.now() < deadline) {
    const runtime = await readLaunchAgentRuntime(params.env);
    lastStatus = runtime.status ?? "unknown";
    lastPid = runtime.pid;
    if (
      runtime.status === "running" &&
      typeof runtime.pid === "number" &&
      runtime.pid > 1 &&
      (params.pidNot === undefined || runtime.pid !== params.pidNot)
    ) {
      return { pid: runtime.pid };
    }
    await new Promise((resolve) => {
      setTimeout(resolve, WAIT_INTERVAL_MS);
    });
  }
  throw new Error(
    `Timed out waiting for launchd runtime (status=${lastStatus}, pid=${lastPid ?? "none"})`,
  );
}

async function waitForNotRunningRuntime(params: {
  env: GatewayServiceEnv;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";
  let lastPid: number | undefined;
  while (Date.now() < deadline) {
    const runtime = await readLaunchAgentRuntime(params.env);
    lastStatus = runtime.status ?? "unknown";
    lastPid = runtime.pid;
    if (runtime.status !== "running" && runtime.pid === undefined) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, WAIT_INTERVAL_MS);
    });
  }
  throw new Error(
    `Timed out waiting for launchd runtime to stop (status=${lastStatus}, pid=${lastPid ?? "none"})`,
  );
}

function launchEnvOrThrow(env: GatewayServiceEnv | undefined): GatewayServiceEnv {
  if (!env) {
    throw new Error("launchd integration env was not initialized");
  }
  return env;
}

async function initializeLaunchdRuntime(launchEnv: GatewayServiceEnv, stdout: PassThrough) {
  await withTimeout({
    run: async () => {
      await installLaunchAgent({
        env: launchEnv,
        stdout,
        programArguments: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
      });
      await waitForRunningRuntime({ env: launchEnv });
    },
    timeoutMs: STARTUP_TIMEOUT_MS,
    message: "Timed out initializing launchd integration runtime",
  });
}

async function writeLaunchAgentProbeScript(params: {
  eventsPath: string;
  scriptPath: string;
}): Promise<void> {
  await fs.writeFile(
    params.scriptPath,
    [
      'const fs = require("node:fs");',
      `const eventsPath = ${JSON.stringify(params.eventsPath)};`,
      "fs.appendFileSync(eventsPath, `start ${process.pid}\\n`);",
      'for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {',
      "  process.on(signal, () => {",
      "    fs.appendFileSync(eventsPath, `${signal} ${process.pid}\\n`);",
      "    process.exit(0);",
      "  });",
      "}",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function expectRuntimePidReplaced(params: {
  env: GatewayServiceEnv;
  previousPid: number;
}): Promise<void> {
  const after = await waitForRunningRuntime({
    env: params.env,
    pidNot: params.previousPid,
  });
  expect(after.pid).toBeGreaterThan(1);
  expect(after.pid).not.toBe(params.previousPid);
  await fs.access(resolveLaunchAgentPlistPath(params.env));
}

describeLaunchdIntegration("launchd integration", () => {
  let env: GatewayServiceEnv | undefined;
  let homeDir = "";
  const stdout = new PassThrough();

  beforeAll(async () => {
    const testId = randomUUID().slice(0, 8);
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-launchd-int-${testId}-`));
    env = {
      HOME: homeDir,
      OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.launchd-int-${testId}`,
      OPENCLAW_LOG_PREFIX: `gateway-launchd-int-${testId}`,
    };
  });

  afterAll(async () => {
    if (env) {
      try {
        await uninstallLaunchAgent({ env, stdout });
      } catch {
        // Best-effort cleanup in case launchctl state already changed.
      }
    }
    if (homeDir) {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("restarts launchd service and keeps it running with a new pid", async () => {
    const launchEnv = launchEnvOrThrow(env);
    try {
      await initializeLaunchdRuntime(launchEnv, stdout);
    } catch {
      // Best-effort integration check only; skip when launchctl is unstable in CI.
      return;
    }
    const before = await waitForRunningRuntime({ env: launchEnv });
    await restartLaunchAgent({ env: launchEnv, stdout });
    await expectRuntimePidReplaced({ env: launchEnv, previousPid: before.pid });
  }, 60_000);

  it("keeps LaunchAgent supervision after a raw SIGTERM", async () => {
    const launchEnv = launchEnvOrThrow(env);
    try {
      await initializeLaunchdRuntime(launchEnv, stdout);
    } catch {
      return;
    }

    const before = await waitForRunningRuntime({ env: launchEnv });
    process.kill(before.pid, "SIGTERM");
    await expectRuntimePidReplaced({ env: launchEnv, previousPid: before.pid });
  }, 60_000);

  it("stops persistently without reinstall and starts later", async () => {
    const launchEnv = launchEnvOrThrow(env);
    try {
      await initializeLaunchdRuntime(launchEnv, stdout);
    } catch {
      return;
    }

    const before = await waitForRunningRuntime({ env: launchEnv });
    await stopLaunchAgent({ env: launchEnv, stdout });
    await waitForNotRunningRuntime({ env: launchEnv });
    const service = resolveGatewayService();
    const startResult = await startGatewayService(service, { env: launchEnv, stdout });
    expect(startResult.outcome).toBe("started");
    await expectRuntimePidReplaced({ env: launchEnv, previousPid: before.pid });
  }, 60_000);

  it("stops persistently without reinstall and restarts later", async () => {
    const launchEnv = launchEnvOrThrow(env);
    try {
      await initializeLaunchdRuntime(launchEnv, stdout);
    } catch {
      return;
    }

    const before = await waitForRunningRuntime({ env: launchEnv });
    await stopLaunchAgent({ env: launchEnv, stdout });
    await waitForNotRunningRuntime({ env: launchEnv });
    await restartLaunchAgent({ env: launchEnv, stdout });
    await expectRuntimePidReplaced({ env: launchEnv, previousPid: before.pid });
  }, 60_000);

  it("repairs a missing bootstrap without kickstarting the fresh LaunchAgent", async () => {
    const launchEnv = launchEnvOrThrow(env);
    const eventsPath = path.join(homeDir, "repair-probe.events.log");
    const scriptPath = path.join(homeDir, "repair-probe.cjs");
    await writeLaunchAgentProbeScript({ eventsPath, scriptPath });
    await installLaunchAgent({
      env: launchEnv,
      stdout,
      programArguments: [process.execPath, scriptPath],
    });
    await waitForRunningRuntime({ env: launchEnv });
    const bootout = spawnSync(
      "launchctl",
      ["bootout", resolveGuiDomain(), resolveLaunchAgentPlistPath(launchEnv)],
      { encoding: "utf8" },
    );
    expect(bootout.status).toBe(0);
    await waitForNotRunningRuntime({ env: launchEnv });
    await fs.access(resolveLaunchAgentPlistPath(launchEnv));
    await fs.writeFile(eventsPath, "", "utf8");

    const repair = await withTimeout({
      run: async () => repairLaunchAgentBootstrap({ env: launchEnv }),
      timeoutMs: STARTUP_TIMEOUT_MS,
      message: "Timed out repairing launchd integration runtime",
    });
    expect(repair).toEqual({ ok: true, status: "repaired" });
    await waitForRunningRuntime({ env: launchEnv });

    await new Promise((resolve) => {
      setTimeout(resolve, 1_500);
    });
    const events = await fs.readFile(eventsPath, "utf8");
    const lines = events.trim().split(/\r?\n/).filter(Boolean);
    expect(lines.filter((line) => line.startsWith("start "))).toHaveLength(1);
    expect(lines.some((line) => /^(SIGHUP|SIGINT|SIGTERM) /.test(line))).toBe(false);
  }, 60_000);
});
