// QA Lab host proof for real Linux gateway service diagnosis and recovery.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const ALLOW_ENV = "OPENCLAW_QA_ALLOW_SYSTEMD_RECOVERY";
const SCENARIO_ID = "doctor-gateway-startup-recovery";
const SOURCE_PATH = "test/e2e/qa-lab/runtime/doctor-gateway-startup-recovery.ts";
const commandTimeoutMs = 120_000;
const gatewayRecoveryArgs = ["gateway", "restart", "--json"] as const;

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
  [key: string]: unknown;
  rpc?: { [key: string]: unknown; ok?: boolean };
  service?: {
    [key: string]: unknown;
    runtime?: { [key: string]: unknown; status?: string };
  };
};

type GatewayHealthJson = {
  [key: string]: unknown;
  ok?: boolean;
};

type ForeignListener = {
  previousProcessTitle: string;
  server: Server;
  sockets: Set<Socket>;
  listening: boolean;
};

type ProducerOptions = {
  artifactBase: string;
  repoRoot: string;
};

type SystemdRecoveryCapability = { available: true } | { available: false; reason: string };

type RecoverySummary = {
  cleanupVerified: boolean;
  foreignPortDiagnosed: boolean;
  independentHealthHealthy: boolean;
  independentStatusHealthy: boolean;
  restartCount: number;
  restartGuidanceObserved: boolean;
  startLimitObserved: boolean;
  startLimitResult: string;
};

type RecoveryResult = {
  healthJson: GatewayHealthJson;
  statusJson: GatewayStatusJson;
  summary: RecoverySummary;
};

function formatErrorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = [...error.errors].map((cause) => formatErrorMessage(cause)).filter(Boolean);
    return causes.length > 0 ? `${error.message}: ${causes.join("; ")}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function parseDoctorGatewayStartupRecoveryOptions(args: string[]): ProducerOptions {
  if (args.length !== 2 || args[0] !== "--artifact-base" || !args[1]) {
    throw new Error("usage: --artifact-base <output-directory>");
  }
  return {
    artifactBase: path.resolve(args[1]),
    repoRoot: process.cwd(),
  };
}

export function resolveSystemdRecoveryPermission(
  env: NodeJS.ProcessEnv = process.env,
): SystemdRecoveryCapability {
  if (env[ALLOW_ENV] === "1") {
    return { available: true };
  }
  return {
    available: false,
    reason: `blocked native systemd recovery proof; set ${ALLOW_ENV}=1 on a prepared host`,
  };
}

function commandEnv(
  profile: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  accountHome: string = os.userInfo().homedir,
  accountUid: number | undefined = typeof process.geteuid === "function"
    ? process.geteuid()
    : undefined,
): NodeJS.ProcessEnv {
  const stateDir = path.join(accountHome, `.openclaw-${profile}`);
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOME: accountHome,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_PROFILE: profile,
    OPENCLAW_STATE_DIR: stateDir,
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
    "OPENCLAW_SYSTEMD_UNIT",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_GATEWAY_URL",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
    "OPENCLAW_SERVICE_REPAIR_POLICY",
    "OPENCLAW_SUPERVISOR_MODE",
    "DBUS_SESSION_BUS_ADDRESS",
    "SUDO_COMMAND",
    "SUDO_GID",
    "SUDO_UID",
    "SUDO_USER",
    "VITEST",
    "VITEST_WORKER_ID",
    "XDG_RUNTIME_DIR",
  ]) {
    delete env[key];
  }
  if (accountUid !== undefined) {
    const runtimeDir = `/run/user/${accountUid}`;
    env.XDG_RUNTIME_DIR = runtimeDir;
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtimeDir}/bus`;
  }
  return env;
}

async function runCommand(
  repoRoot: string,
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
      if (!child.pid) {
        return;
      }
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
  options: ProducerOptions,
  profile: string,
  args: string[],
  env = commandEnv(profile),
): Promise<CommandResult> {
  const invocation = resolveOpenClawInvocation(options, profile, args);
  return await runCommand(options.repoRoot, invocation.command, invocation.args, env);
}

function resolveOpenClawInvocation(
  options: ProducerOptions,
  profile: string,
  args: string[],
): { args: string[]; command: string } {
  // QA Suite builds once before this producer starts. Keep every client command on that
  // immutable dist tree so a rebuild cannot remove chunks beneath the installed gateway.
  return {
    args: [path.join(options.repoRoot, "openclaw.mjs"), "--profile", profile, ...args],
    command: process.execPath,
  };
}

async function runSystemctl(
  options: ProducerOptions,
  profile: string,
  args: string[],
  env = commandEnv(profile),
): Promise<CommandResult> {
  return await runCommand(options.repoRoot, "systemctl", ["--user", ...args], env, 30_000);
}

function outputOf(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function assertCommandSucceeded(result: CommandResult, label: string): void {
  assert.equal(
    result.code,
    0,
    `${label} failed: code=${String(result.code)} signal=${String(result.signal)}\n${outputOf(result)}`,
  );
}

async function resolveSystemdRecoveryCapability(
  options: ProducerOptions,
  permissionEnv: NodeJS.ProcessEnv,
): Promise<SystemdRecoveryCapability> {
  const permission = resolveSystemdRecoveryPermission(permissionEnv);
  if (!permission.available) {
    return permission;
  }
  if (process.platform !== "linux") {
    return { available: false, reason: "blocked native systemd recovery proof: Linux required" };
  }
  const env = commandEnv("qa-doctor-preflight");
  try {
    const pid1 = await runCommand(options.repoRoot, "ps", ["-p", "1", "-o", "comm="], env, 10_000);
    if (pid1.code !== 0 || pid1.stdout.trim() !== "systemd") {
      return {
        available: false,
        reason: "blocked native systemd recovery proof: PID 1 is not systemd",
      };
    }
    const userManager = await runSystemctl(options, "qa-doctor-preflight", ["show-environment"]);
    if (userManager.code !== 0) {
      return {
        available: false,
        reason: "blocked native systemd recovery proof: systemctl --user is unavailable",
      };
    }
  } catch (error) {
    return {
      available: false,
      reason: `blocked native systemd recovery proof: ${formatErrorMessage(error)}`,
    };
  }
  return { available: true };
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

async function listen(port: number): Promise<ForeignListener> {
  const previousProcessTitle = process.title;
  process.title = "qa-port-listener";
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.destroy();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    process.title = previousProcessTitle;
    throw error;
  }
  return { previousProcessTitle, server, sockets, listening: true };
}

async function closeServer(listener: ForeignListener | undefined): Promise<void> {
  if (!listener?.listening) {
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      listener.server.close((error) => (error ? reject(error) : resolve()));
      for (const socket of listener.sockets) {
        socket.destroy();
      }
    });
    listener.listening = false;
  } finally {
    process.title = listener.previousProcessTitle;
  }
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

async function readSystemdState(
  options: ProducerOptions,
  profile: string,
  unit: string,
): Promise<SystemdState> {
  const result = await runSystemctl(options, profile, [
    "show",
    unit,
    "--property=LoadState,ActiveState,SubState,Result,NRestarts,StartLimitBurst",
  ]);
  assertCommandSucceeded(result, `systemctl show ${unit}`);
  return parseSystemdState(result.stdout);
}

async function waitForStartLimit(
  options: ProducerOptions,
  profile: string,
  unit: string,
): Promise<SystemdState> {
  const deadline = Date.now() + 30_000;
  let latest: SystemdState = { nRestarts: 0, startLimitBurst: 0 };
  while (Date.now() < deadline) {
    latest = await readSystemdState(options, profile, unit);
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
  options: ProducerOptions,
  profile: string,
  env: NodeJS.ProcessEnv,
): Promise<{
  healthJson: GatewayHealthJson;
  statusJson: GatewayStatusJson;
}> {
  const deadline = Date.now() + 60_000;
  const statusArgs = ["gateway", "status", "--deep", "--require-rpc", "--json"];
  let status = await runOpenClaw(options, profile, statusArgs, env);
  let health = await runOpenClaw(options, profile, ["gateway", "health", "--json"], env);
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
        return { healthJson, statusJson };
      }
    } catch {
      // The CLI may still be rebuilding or the gateway may still be starting.
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
    status = await runOpenClaw(options, profile, statusArgs, env);
    health = await runOpenClaw(options, profile, ["gateway", "health", "--json"], env);
  }
  throw new Error(
    `gateway did not become healthy\nstatus=${outputOf(status)}\nhealth=${outputOf(health)}`,
  );
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runCleanup(actions: Array<() => Promise<unknown>>): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

async function runSystemdRecovery(
  options: ProducerOptions,
  appendLog: (chunk: unknown) => void,
): Promise<RecoveryResult> {
  const profile = `qa-doctor-${randomUUID().slice(0, 8)}`;
  const home = os.userInfo().homedir;
  const env = commandEnv(profile, process.env, home);
  const stateDir = path.join(home, `.openclaw-${profile}`);
  const configPath = path.join(stateDir, "openclaw.json");
  const unit = `openclaw-gateway-${profile}.service`;
  const unitPath = path.join(home, ".config", "systemd", "user", unit);
  const dropInDir = `${unitPath}.d`;
  const dropInPath = path.join(dropInDir, "qa-start-limit.conf");
  const crashWrapper = path.join(stateDir, "qa-start-limit.sh");
  const port = await getFreePort();
  let foreignListener: ForeignListener | undefined;
  let installed = false;
  let startLimit: SystemdState | undefined;
  let recovered: Awaited<ReturnType<typeof waitForGatewayHealthy>> | undefined;
  let failure: unknown;

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
      options,
      profile,
      ["gateway", "install", "--force", "--json"],
      env,
    );
    appendLog(outputOf(install));
    installed = await fs
      .access(unitPath)
      .then(() => true)
      .catch(() => false);
    assertCommandSucceeded(install, "gateway install");
    assert.match(outputOf(install), /"ok": true/);
    assert.equal(installed, true, `service unit not installed: ${unit}`);
    await waitForGatewayHealthy(options, profile, env);

    const stop = await runOpenClaw(options, profile, ["gateway", "stop", "--force", "--json"], env);
    appendLog(outputOf(stop));
    assertCommandSucceeded(stop, "gateway stop");
    foreignListener = await listen(port);
    const portDoctor = await runOpenClaw(
      options,
      profile,
      ["doctor", "--non-interactive", "--no-workspace-suggestions"],
      env,
    );
    appendLog(outputOf(portDoctor));
    assertCommandSucceeded(portDoctor, "doctor port diagnosis");
    assert.match(outputOf(portDoctor), new RegExp(`Port ${port} is already in use\\.`));
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
    assertCommandSucceeded(
      await runSystemctl(options, profile, ["daemon-reload"], env),
      "systemctl daemon-reload",
    );
    assertCommandSucceeded(
      await runSystemctl(options, profile, ["reset-failed", unit], env),
      `systemctl reset-failed ${unit}`,
    );
    assertCommandSucceeded(
      await runSystemctl(options, profile, ["start", unit], env),
      `systemctl start ${unit}`,
    );
    startLimit = await waitForStartLimit(options, profile, unit);
    assert.equal(startLimit.activeState, "failed");
    assert.equal(
      startLimit.result === "start-limit-hit" || startLimit.nRestarts >= startLimit.startLimitBurst,
      true,
    );

    const failedDoctor = await runOpenClaw(
      options,
      profile,
      ["doctor", "--non-interactive", "--no-workspace-suggestions"],
      env,
    );
    appendLog(outputOf(failedDoctor));
    assertCommandSucceeded(failedDoctor, "doctor start-limit diagnosis");
    assert.match(
      outputOf(failedDoctor),
      /systemd stopped restarting the gateway after repeated crashes\./,
    );
    assert.match(outputOf(failedDoctor), /gateway restart/);

    await fs.rm(dropInPath, { force: true });
    await fs.rmdir(dropInDir).catch(() => undefined);
    assertCommandSucceeded(
      await runSystemctl(options, profile, ["daemon-reload"], env),
      "systemctl daemon-reload after override removal",
    );

    const restart = await runOpenClaw(options, profile, [...gatewayRecoveryArgs], env);
    appendLog(outputOf(restart));
    assertCommandSucceeded(restart, "gateway restart");
    const restartJson = JSON.parse(restart.stdout) as {
      action?: string;
      ok?: boolean;
      result?: string;
      service?: { label?: string; loaded?: boolean };
    };
    assert.equal(restartJson.action, "restart");
    assert.equal(restartJson.ok, true);
    assert.equal(restartJson.result, "restarted");
    assert.equal(restartJson.service?.loaded, true);
    recovered = await waitForGatewayHealthy(options, profile, env);
    assert.equal(recovered.statusJson.service?.runtime?.status, "running");
    assert.equal(recovered.statusJson.rpc?.ok, true);
    assert.equal(recovered.healthJson.ok, true);
  } catch (error) {
    failure = error;
  }

  const cleanupErrors = await runCleanup([
    async () => await closeServer(foreignListener),
    async () => await fs.rm(dropInPath, { force: true }),
    async () => await fs.rmdir(dropInDir).catch(() => undefined),
    async () => {
      const result = await runSystemctl(options, profile, ["daemon-reload"], env);
      assertCommandSucceeded(result, "cleanup systemctl daemon-reload");
    },
    async () => {
      if (!installed) {
        return;
      }
      const result = await runSystemctl(options, profile, ["stop", unit], env);
      assertCommandSucceeded(result, `cleanup systemctl stop ${unit}`);
    },
    async () => {
      if (!installed) {
        return;
      }
      const result = await runSystemctl(options, profile, ["reset-failed", unit], env);
      assertCommandSucceeded(result, `cleanup systemctl reset-failed ${unit}`);
    },
    async () => {
      if (installed) {
        const uninstall = await runOpenClaw(
          options,
          profile,
          ["gateway", "uninstall", "--json"],
          env,
        );
        assertCommandSucceeded(uninstall, "gateway uninstall");
      }
    },
    async () => {
      const result = await runSystemctl(options, profile, ["daemon-reload"], env);
      assertCommandSucceeded(result, "cleanup systemctl final daemon-reload");
    },
    async () => await fs.rm(stateDir, { recursive: true, force: true }),
  ]);

  let finalState: SystemdState | undefined;
  try {
    finalState = await readSystemdState(options, profile, unit);
  } catch (error) {
    cleanupErrors.push(error);
  }
  const unitRemoved = await fs
    .access(unitPath)
    .then(() => false)
    .catch(() => true);
  const stateRemoved = await fs
    .access(stateDir)
    .then(() => false)
    .catch(() => true);
  const cleanupVerified =
    cleanupErrors.length === 0 &&
    unitRemoved &&
    stateRemoved &&
    finalState?.loadState === "not-found";
  appendLog(
    `[qa-doctor-gateway-startup-cleanup] ${JSON.stringify({
      cleanupVerified,
      listenerClosed: !foreignListener?.listening,
      profileStateRemoved: stateRemoved,
      serviceUnitRemoved: unitRemoved,
    })}\n`,
  );
  if (failure || cleanupErrors.length > 0 || !cleanupVerified) {
    throw new AggregateError(
      [failure, ...cleanupErrors].filter((error) => error !== undefined),
      `doctor gateway recovery failed; cleanupVerified=${cleanupVerified}`,
    );
  }

  assert.ok(startLimit);
  assert.ok(recovered);
  return {
    healthJson: recovered.healthJson,
    statusJson: recovered.statusJson,
    summary: {
      cleanupVerified,
      foreignPortDiagnosed: true,
      independentHealthHealthy: recovered.healthJson.ok === true,
      independentStatusHealthy:
        recovered.statusJson.service?.runtime?.status === "running" &&
        recovered.statusJson.rpc?.ok === true,
      restartCount: startLimit.nRestarts,
      restartGuidanceObserved: true,
      startLimitObserved: true,
      startLimitResult: startLimit.result ?? "unknown",
    },
  };
}

function createEvidenceWriter(options: ProducerOptions) {
  return createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "doctor-gateway-startup-recovery.log",
    primaryModel: "gateway/doctor",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      codeRefs: [
        SOURCE_PATH,
        "src/commands/doctor-gateway-daemon-flow.ts",
        "src/commands/doctor-format.ts",
        "src/daemon/service-runtime.ts",
      ],
      docsRefs: [
        "docs/cli/doctor.md",
        "docs/gateway/troubleshooting.md",
        "docs/platforms/linux.md",
      ],
      id: SCENARIO_ID,
      sourcePath: SOURCE_PATH,
      title: "Doctor gateway startup recovery",
    },
  });
}

async function writeRecoveryArtifacts(options: ProducerOptions, recovery: RecoveryResult) {
  const summaryPath = path.join(options.artifactBase, "doctor-gateway-startup-summary.json");
  const statusPath = path.join(options.artifactBase, "gateway-status.json");
  const healthPath = path.join(options.artifactBase, "gateway-health.json");
  await Promise.all([
    writeJson(summaryPath, recovery.summary),
    writeJson(statusPath, recovery.statusJson),
    writeJson(healthPath, recovery.healthJson),
  ]);
  return { healthPath, statusPath, summaryPath };
}

async function runProducer(
  options: ProducerOptions,
  permissionEnv: NodeJS.ProcessEnv = process.env,
): Promise<QaEvidenceSummaryJson> {
  const startedAt = Date.now();
  const writer = createEvidenceWriter(options);
  const capability = await resolveSystemdRecoveryCapability(options, permissionEnv);
  if (!capability.available) {
    writer.appendLog(`${capability.reason}\n`);
    return await writer.write({
      details: capability.reason,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "blocked",
    });
  }

  try {
    const recovery = await runSystemdRecovery(options, (chunk) => writer.appendLog(chunk));
    const { healthPath, statusPath, summaryPath } = await writeRecoveryArtifacts(options, recovery);
    const { summary } = recovery;
    writer.appendLog(`[qa-doctor-gateway-startup-recovery] ${JSON.stringify(summary)}\n`);
    return await writer.write({
      artifacts: [
        { kind: "summary", filePath: path.basename(summaryPath) },
        { kind: "rpc", filePath: path.basename(statusPath) },
        { kind: "health", filePath: path.basename(healthPath) },
      ],
      details: `foreign-port=diagnosed; systemd-start-limit=${summary.startLimitResult}; restart-guidance=observed; status=running/rpc-ok; health=ok; cleanup=verified`,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = formatErrorMessage(error);
    writer.appendLog(`fail: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  }
}

async function main(args: string[]): Promise<number> {
  const evidence = await runProducer(parseDoctorGatewayStartupRecoveryOptions(args));
  const status = evidence.entries[0]?.result.status;
  console.log(`Doctor gateway startup recovery evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Doctor gateway startup recovery status: ${status}`);
  return status === "pass" || status === "blocked" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}

export const testing = {
  commandEnv,
  gatewayRecoveryArgs,
  main,
  resolveOpenClawInvocation,
  runProducer,
  writeRecoveryArtifacts,
};
