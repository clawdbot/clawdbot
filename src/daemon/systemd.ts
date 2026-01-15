import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { colorize, isRich, theme } from "../terminal/theme.js";
import {
  formatGatewayServiceDescription,
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  resolveGatewaySystemdServiceName,
} from "./constants.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import {
  enableSystemdUserLinger,
  readSystemdUserLingerStatus,
  type SystemdUserLingerStatus,
} from "./systemd-linger.js";
import {
  buildSystemdUnit,
  parseSystemdEnvAssignment,
  parseSystemdExecStart,
} from "./systemd-unit.js";

const execFileAsync = promisify(execFile);

const formatLine = (label: string, value: string) => {
  const rich = isRich();
  return `${colorize(rich, theme.muted, `${label}:`)} ${colorize(rich, theme.command, value)}`;
};

function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) throw new Error("Missing HOME");
  return home;
}

function resolveSystemdUnitPathForName(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const home = resolveHomeDir(env);
  return path.join(home, ".config", "systemd", "user", `${name}.service`);
}

function resolveSystemdServiceName(env: Record<string, string | undefined>): string {
  const override = env.CLAWDBOT_SYSTEMD_UNIT?.trim();
  if (override) {
    return override.endsWith(".service") ? override.slice(0, -".service".length) : override;
  }
  return resolveGatewaySystemdServiceName(env.CLAWDBOT_PROFILE);
}

function resolveSystemdUnitPath(env: Record<string, string | undefined>): string {
  return resolveSystemdUnitPathForName(env, resolveSystemdServiceName(env));
}

export function resolveSystemdUserUnitPath(env: Record<string, string | undefined>): string {
  return resolveSystemdUnitPath(env);
}

export { enableSystemdUserLinger, readSystemdUserLingerStatus };
export type { SystemdUserLingerStatus };

// Unit file parsing/rendering: see systemd-unit.ts

export async function readSystemdServiceExecStart(
  env: Record<string, string | undefined>,
): Promise<{
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  sourcePath?: string;
} | null> {
  const unitPath = resolveSystemdUnitPath(env);
  try {
    const content = await fs.readFile(unitPath, "utf8");
    let execStart = "";
    let workingDirectory = "";
    const environment: Record<string, string> = {};
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith("ExecStart=")) {
        execStart = line.slice("ExecStart=".length).trim();
      } else if (line.startsWith("WorkingDirectory=")) {
        workingDirectory = line.slice("WorkingDirectory=".length).trim();
      } else if (line.startsWith("Environment=")) {
        const raw = line.slice("Environment=".length).trim();
        const parsed = parseSystemdEnvAssignment(raw);
        if (parsed) environment[parsed.key] = parsed.value;
      }
    }
    if (!execStart) return null;
    const programArguments = parseSystemdExecStart(execStart);
    return {
      programArguments,
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
      sourcePath: unitPath,
    };
  } catch {
    return null;
  }
}

export type SystemdServiceInfo = {
  activeState?: string;
  subState?: string;
  mainPid?: number;
  execMainStatus?: number;
  execMainCode?: string;
};

export function parseSystemdShow(output: string): SystemdServiceInfo {
  const entries = parseKeyValueOutput(output, "=");
  const info: SystemdServiceInfo = {};
  const activeState = entries.activestate;
  if (activeState) info.activeState = activeState;
  const subState = entries.substate;
  if (subState) info.subState = subState;
  const mainPidValue = entries.mainpid;
  if (mainPidValue) {
    const pid = Number.parseInt(mainPidValue, 10);
    if (Number.isFinite(pid) && pid > 0) info.mainPid = pid;
  }
  const execMainStatusValue = entries.execmainstatus;
  if (execMainStatusValue) {
    const status = Number.parseInt(execMainStatusValue, 10);
    if (Number.isFinite(status)) info.execMainStatus = status;
  }
  const execMainCode = entries.execmaincode;
  if (execMainCode) info.execMainCode = execMainCode;
  return info;
}

async function execSystemctl(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("systemctl", args, {
      encoding: "utf8",
    });
    return {
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      code: 0,
    };
  } catch (error) {
    const e = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
      message?: unknown;
    };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string" ? e.stderr : typeof e.message === "string" ? e.message : "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

export async function isSystemdUserServiceAvailable(): Promise<boolean> {
  const res = await execSystemctl(["--user", "status"]);
  if (res.code === 0) return true;
  const detail = `${res.stderr} ${res.stdout}`.toLowerCase();
  if (!detail) return false;
  if (detail.includes("not found")) return false;
  if (detail.includes("failed to connect")) return false;
  if (detail.includes("not been booted")) return false;
  if (detail.includes("no such file or directory")) return false;
  if (detail.includes("not supported")) return false;
  return false;
}

async function assertSystemdAvailable() {
  const res = await execSystemctl(["--user", "status"]);
  if (res.code === 0) return;
  const detail = res.stderr || res.stdout;
  if (detail.toLowerCase().includes("not found")) {
    throw new Error("systemctl not available; systemd user services are required on Linux.");
  }
  throw new Error(`systemctl --user unavailable: ${detail || "unknown error"}`.trim());
}

export async function installSystemdService({
  env,
  stdout,
  programArguments,
  workingDirectory,
  environment,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
}): Promise<{ unitPath: string }> {
  await assertSystemdAvailable();

  const unitPath = resolveSystemdUnitPath(env);
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  const description = formatGatewayServiceDescription({
    profile: env.CLAWDBOT_PROFILE,
    version: environment?.CLAWDBOT_SERVICE_VERSION ?? env.CLAWDBOT_SERVICE_VERSION,
  });
  const unit = buildSystemdUnit({
    description,
    programArguments,
    workingDirectory,
    environment,
  });
  await fs.writeFile(unitPath, unit, "utf8");

  const serviceName = resolveGatewaySystemdServiceName(env.CLAWDBOT_PROFILE);
  const unitName = `${serviceName}.service`;
  const reload = await execSystemctl(["--user", "daemon-reload"]);
  if (reload.code !== 0) {
    throw new Error(`systemctl daemon-reload failed: ${reload.stderr || reload.stdout}`.trim());
  }

  const enable = await execSystemctl(["--user", "enable", unitName]);
  if (enable.code !== 0) {
    throw new Error(`systemctl enable failed: ${enable.stderr || enable.stdout}`.trim());
  }

  const restart = await execSystemctl(["--user", "restart", unitName]);
  if (restart.code !== 0) {
    throw new Error(`systemctl restart failed: ${restart.stderr || restart.stdout}`.trim());
  }

  // Ensure we don't end up writing to a clack spinner line (wizards show progress without a newline).
  stdout.write("\n");
  stdout.write(`${formatLine("Installed systemd service", unitPath)}\n`);
  return { unitPath };
}

export async function uninstallSystemdService({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  await assertSystemdAvailable();
  const serviceName = resolveGatewaySystemdServiceName(env.CLAWDBOT_PROFILE);
  const unitName = `${serviceName}.service`;
  await execSystemctl(["--user", "disable", "--now", unitName]);

  const unitPath = resolveSystemdUnitPath(env);
  try {
    await fs.unlink(unitPath);
    stdout.write(`${formatLine("Removed systemd service", unitPath)}\n`);
  } catch {
    stdout.write(`Systemd service not found at ${unitPath}\n`);
  }
}

export async function stopSystemdService({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  await assertSystemdAvailable();
  const serviceName = resolveSystemdServiceName(env ?? {});
  const unitName = `${serviceName}.service`;
  const res = await execSystemctl(["--user", "stop", unitName]);
  if (res.code !== 0) {
    throw new Error(`systemctl stop failed: ${res.stderr || res.stdout}`.trim());
  }
  stdout.write(`${formatLine("Stopped systemd service", unitName)}\n`);
}

export async function restartSystemdService({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  await assertSystemdAvailable();
  const serviceName = resolveSystemdServiceName(env ?? {});
  const unitName = `${serviceName}.service`;
  const res = await execSystemctl(["--user", "restart", unitName]);
  if (res.code !== 0) {
    throw new Error(`systemctl restart failed: ${res.stderr || res.stdout}`.trim());
  }
  stdout.write(`${formatLine("Restarted systemd service", unitName)}\n`);
}

export async function isSystemdServiceEnabled(args: {
  env?: Record<string, string | undefined>;
}): Promise<boolean> {
  await assertSystemdAvailable();
  const serviceName = resolveSystemdServiceName(args.env ?? {});
  const unitName = `${serviceName}.service`;
  const res = await execSystemctl(["--user", "is-enabled", unitName]);
  return res.code === 0;
}

export async function readSystemdServiceRuntime(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Promise<GatewayServiceRuntime> {
  try {
    await assertSystemdAvailable();
  } catch (err) {
    return {
      status: "unknown",
      detail: String(err),
    };
  }
  const serviceName = resolveSystemdServiceName(env);
  const unitName = `${serviceName}.service`;
  const res = await execSystemctl([
    "--user",
    "show",
    unitName,
    "--no-page",
    "--property",
    "ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode",
  ]);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    const missing = detail.toLowerCase().includes("not found");
    return {
      status: missing ? "stopped" : "unknown",
      detail: detail || undefined,
      missingUnit: missing,
    };
  }
  const parsed = parseSystemdShow(res.stdout || "");
  const activeState = parsed.activeState?.toLowerCase();
  const status = activeState === "active" ? "running" : activeState ? "stopped" : "unknown";
  return {
    status,
    state: parsed.activeState,
    subState: parsed.subState,
    pid: parsed.mainPid,
    lastExitStatus: parsed.execMainStatus,
    lastExitReason: parsed.execMainCode,
  };
}
export type LegacySystemdUnit = {
  name: string;
  unitPath: string;
  enabled: boolean;
  exists: boolean;
};

async function isSystemctlAvailable(): Promise<boolean> {
  const res = await execSystemctl(["--user", "status"]);
  if (res.code === 0) return true;
  const detail = `${res.stderr || res.stdout}`.toLowerCase();
  return !detail.includes("not found");
}

export async function findLegacySystemdUnits(
  env: Record<string, string | undefined>,
): Promise<LegacySystemdUnit[]> {
  const results: LegacySystemdUnit[] = [];
  const systemctlAvailable = await isSystemctlAvailable();
  for (const name of LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES) {
    const unitPath = resolveSystemdUnitPathForName(env, name);
    let exists = false;
    try {
      await fs.access(unitPath);
      exists = true;
    } catch {
      // ignore
    }
    let enabled = false;
    if (systemctlAvailable) {
      const res = await execSystemctl(["--user", "is-enabled", `${name}.service`]);
      enabled = res.code === 0;
    }
    if (exists || enabled) {
      results.push({ name, unitPath, enabled, exists });
    }
  }
  return results;
}

export async function uninstallLegacySystemdUnits({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<LegacySystemdUnit[]> {
  const units = await findLegacySystemdUnits(env);
  if (units.length === 0) return units;

  const systemctlAvailable = await isSystemctlAvailable();
  for (const unit of units) {
    if (systemctlAvailable) {
      await execSystemctl(["--user", "disable", "--now", `${unit.name}.service`]);
    } else {
      stdout.write(`systemctl unavailable; removed legacy unit file only: ${unit.name}.service\n`);
    }

    try {
      await fs.unlink(unit.unitPath);
      stdout.write(`${formatLine("Removed legacy systemd service", unit.unitPath)}\n`);
    } catch {
      stdout.write(`Legacy systemd unit not found at ${unit.unitPath}\n`);
    }
  }

  return units;
}
