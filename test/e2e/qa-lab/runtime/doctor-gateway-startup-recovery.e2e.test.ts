// QA Lab host proof for real Linux gateway service diagnosis and recovery.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net, { type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

type CommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
};

type SystemdState = {
  activeState?: string;
  loadState?: string;
  nRestarts: number;
  result?: string;
  startLimitBurst: number;
  subState?: string;
};

type GatewayStatusJson = {
  rpc?: { ok?: boolean };
  service?: { runtime?: { status?: string } };
};

type GatewayHealthJson = {
  ok?: boolean;
};

const repoRoot = process.cwd();
const commandTimeoutMs = 120_000;

function commandEnv(profile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_PROFILE: profile,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
  };
  for (const key of [
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_SYSTEMD_UNIT",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
    "VITEST",
    "VITEST_WORKER_ID",
  ]) {
    delete env[key];
  }
  return env;
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = commandTimeoutMs,
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          return;
        }
        forceKillTimer = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            // The command exited after SIGTERM.
          }
        }, 5_000);
      }
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function runOpenClaw(
  profile: string,
  args: string[],
  env = commandEnv(profile),
): Promise<CommandResult> {
  return await runCommand(
    process.execPath,
    ["scripts/run-node.mjs", "--profile", profile, ...args],
    env,
  );
}

async function runSystemctl(
  profile: string,
  args: string[],
  env = commandEnv(profile),
): Promise<CommandResult> {
  return await runCommand("systemctl", ["--user", ...args], env, 30_000);
}

function outputOf(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate a TCP port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function listen(port: number): Promise<Server> {
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function parseSystemdState(stdout: string): SystemdState {
  const values = Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator === -1
          ? [line, ""]
          : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  return {
    activeState: values.ActiveState,
    loadState: values.LoadState,
    nRestarts: Number.parseInt(values.NRestarts ?? "0", 10),
    result: values.Result,
    startLimitBurst: Number.parseInt(values.StartLimitBurst ?? "0", 10),
    subState: values.SubState,
  };
}

async function readSystemdState(profile: string, unit: string): Promise<SystemdState> {
  const result = await runSystemctl(profile, [
    "show",
    unit,
    "--property=LoadState,ActiveState,SubState,Result,NRestarts,StartLimitBurst",
  ]);
  return parseSystemdState(result.stdout);
}

async function waitForStartLimit(profile: string, unit: string): Promise<SystemdState> {
  const deadline = Date.now() + 30_000;
  let latest: SystemdState = { nRestarts: 0, startLimitBurst: 0 };
  while (Date.now() < deadline) {
    latest = await readSystemdState(profile, unit);
    if (
      latest.activeState === "failed" &&
      (latest.result === "start-limit-hit" ||
        (latest.startLimitBurst > 0 && latest.nRestarts >= latest.startLimitBurst))
    ) {
      return latest;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error(`systemd did not reach its start limit: ${JSON.stringify(latest)}`);
}

async function waitForGatewayHealthy(
  profile: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  health: CommandResult;
  healthJson: GatewayHealthJson;
  status: CommandResult;
  statusJson: GatewayStatusJson;
}> {
  const deadline = Date.now() + 60_000;
  const statusArgs = ["gateway", "status", "--deep", "--require-rpc", "--json"];
  let status = await runOpenClaw(profile, statusArgs, env);
  let health = await runOpenClaw(profile, ["gateway", "health", "--json"], env);
  while (Date.now() < deadline) {
    try {
      const statusJson = JSON.parse(status.stdout) as GatewayStatusJson;
      const healthJson = JSON.parse(health.stdout) as GatewayHealthJson;
      if (
        status.code === 0 &&
        health.code === 0 &&
        statusJson.service?.runtime?.status === "running" &&
        statusJson.rpc?.ok === true &&
        healthJson.ok === true
      ) {
        return { health, healthJson, status, statusJson };
      }
    } catch {
      // The CLI may still be rebuilding or the gateway may still be starting.
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
    status = await runOpenClaw(profile, statusArgs, env);
    health = await runOpenClaw(profile, ["gateway", "health", "--json"], env);
  }
  throw new Error(
    `gateway did not become healthy\nstatus=${outputOf(status)}\nhealth=${outputOf(health)}`,
  );
}

describe.runIf(process.platform === "linux")("doctor gateway startup recovery", () => {
  it(
    "diagnoses foreign port ownership and repairs a systemd start-limit failure",
    { timeout: 420_000 },
    async () => {
      const profile = `qa-doctor-${randomUUID().slice(0, 8)}`;
      const env = commandEnv(profile);
      const home = os.homedir();
      const stateDir = path.join(home, `.openclaw-${profile}`);
      const configPath = path.join(stateDir, "openclaw.json");
      const unit = `openclaw-gateway-${profile}.service`;
      const unitPath = path.join(home, ".config", "systemd", "user", unit);
      const dropInDir = `${unitPath}.d`;
      const dropInPath = path.join(dropInDir, "qa-start-limit.conf");
      const crashWrapper = path.join(stateDir, "qa-start-limit.sh");
      const port = await getFreePort();
      let foreignListener: Server | undefined;
      let installed = false;

      const pid1 = await runCommand("ps", ["-p", "1", "-o", "comm="], env, 10_000);
      expect(pid1.code).toBe(0);
      expect(pid1.stdout.trim()).toBe("systemd");
      const userManager = await runSystemctl(profile, ["show-environment"], env);
      expect(userManager.code).toBe(0);

      try {
        await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
        await fs.writeFile(
          configPath,
          `${JSON.stringify(
            {
              gateway: {
                mode: "local",
                port,
                bind: "loopback",
                auth: {
                  mode: "token",
                  token: "qa-doctor-service-token",
                },
                controlUi: { enabled: false },
              },
            },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        );

        const install = await runOpenClaw(
          profile,
          ["gateway", "install", "--force", "--json"],
          env,
        );
        installed = await fs
          .access(unitPath)
          .then(() => true)
          .catch(() => false);
        expect(outputOf(install)).toContain('"ok": true');
        expect(install.code).toBe(0);
        expect(installed).toBe(true);
        await waitForGatewayHealthy(profile, env);

        const stop = await runOpenClaw(profile, ["gateway", "stop", "--force", "--json"], env);
        expect(stop.code).toBe(0);
        foreignListener = await listen(port);
        const portDoctor = await runOpenClaw(
          profile,
          ["doctor", "--non-interactive", "--no-workspace-suggestions"],
          env,
        );
        const portOutput = outputOf(portDoctor);
        expect(portDoctor.code).toBe(0);
        expect(portOutput).toContain(`Port ${port} is already in use.`);
        await closeServer(foreignListener);
        foreignListener = undefined;

        await fs.writeFile(crashWrapper, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
        await fs.mkdir(dropInDir, { recursive: true });
        await fs.writeFile(
          dropInPath,
          [
            "[Unit]",
            "StartLimitIntervalSec=10",
            "StartLimitBurst=3",
            "",
            "[Service]",
            "ExecStart=",
            `ExecStart=/bin/sh ${JSON.stringify(crashWrapper)}`,
            "Restart=on-failure",
            "RestartSec=100ms",
            "",
          ].join("\n"),
        );
        expect((await runSystemctl(profile, ["daemon-reload"], env)).code).toBe(0);
        await runSystemctl(profile, ["reset-failed", unit], env);
        await runSystemctl(profile, ["start", unit], env);
        const startLimit = await waitForStartLimit(profile, unit);
        expect(startLimit.activeState).toBe("failed");
        expect(
          startLimit.result === "start-limit-hit" ||
            startLimit.nRestarts >= startLimit.startLimitBurst,
        ).toBe(true);

        const failedDoctor = await runOpenClaw(
          profile,
          ["doctor", "--non-interactive", "--no-workspace-suggestions"],
          env,
        );
        const failedOutput = outputOf(failedDoctor);
        expect(failedDoctor.code).toBe(0);
        expect(failedOutput).toContain(
          "systemd stopped restarting the gateway after repeated crashes.",
        );
        expect(failedOutput).toContain("gateway restart");

        await fs.rm(dropInPath, { force: true });
        await fs.rmdir(dropInDir).catch(() => undefined);
        expect((await runSystemctl(profile, ["daemon-reload"], env)).code).toBe(0);

        const repair = await runOpenClaw(
          profile,
          ["doctor", "--repair", "--yes", "--non-interactive", "--no-workspace-suggestions"],
          env,
        );
        expect(repair.code).toBe(0);
        const recovered = await waitForGatewayHealthy(profile, env);
        expect(recovered.statusJson.service?.runtime?.status).toBe("running");
        expect(recovered.statusJson.rpc?.ok).toBe(true);
        expect(recovered.healthJson.ok).toBe(true);

        console.log(
          `[qa-doctor-gateway-startup-recovery] ${JSON.stringify({
            foreignPortDiagnosed: true,
            startLimitObserved: true,
            startLimitResult: startLimit.result ?? "unknown",
            restartCount: startLimit.nRestarts,
            restartGuidanceObserved: true,
            independentStatusHealthy: true,
            independentHealthHealthy: true,
          })}`,
        );
      } finally {
        await closeServer(foreignListener);
        await fs.rm(dropInPath, { force: true });
        await fs.rmdir(dropInDir).catch(() => undefined);
        await runSystemctl(profile, ["daemon-reload"], env);
        await runSystemctl(profile, ["stop", unit], env);
        await runSystemctl(profile, ["reset-failed", unit], env);
        if (installed) {
          await runOpenClaw(profile, ["gateway", "uninstall", "--json"], env);
        }
        await runSystemctl(profile, ["daemon-reload"], env);
        await fs.rm(stateDir, { recursive: true, force: true });

        const finalState = await readSystemdState(profile, unit);
        const unitRemoved = await fs
          .access(unitPath)
          .then(() => false)
          .catch(() => true);
        const stateRemoved = await fs
          .access(stateDir)
          .then(() => false)
          .catch(() => true);
        const cleanupVerified =
          unitRemoved &&
          stateRemoved &&
          (finalState.loadState === "not-found" || finalState.loadState === undefined);
        expect(cleanupVerified).toBe(true);
        console.log(
          `[qa-doctor-gateway-startup-cleanup] ${JSON.stringify({
            cleanupVerified,
            listenerClosed: !foreignListener?.listening,
            profileStateRemoved: stateRemoved,
            serviceUnitRemoved: unitRemoved,
          })}`,
        );
      }
    },
  );
});
