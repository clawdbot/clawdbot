import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import {
  GATEWAY_SYSTEMD_SERVICE_NAME,
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
} from "./constants.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";

const execFileAsync = promisify(execFile);

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

function resolveSystemdUnitPath(
  env: Record<string, string | undefined>,
): string {
  return resolveSystemdUnitPathForName(env, GATEWAY_SYSTEMD_SERVICE_NAME);
}

function resolveLoginctlUser(
  env: Record<string, string | undefined>,
): string | null {
  const fromEnv = env.USER?.trim() || env.LOGNAME?.trim();
  if (fromEnv) return fromEnv;
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

export type SystemdUserLingerStatus = {
  user: string;
  linger: "yes" | "no";
};

export async function readSystemdUserLingerStatus(
  env: Record<string, string | undefined>,
): Promise<SystemdUserLingerStatus | null> {
  const user = resolveLoginctlUser(env);
  if (!user) return null;
  try {
    const { stdout } = await runExec(
      "loginctl",
      ["show-user", user, "-p", "Linger"],
      { timeoutMs: 5_000 },
    );
    const line = stdout
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("Linger="));
    const value = line?.split("=")[1]?.trim().toLowerCase();
    if (value === "yes" || value === "no") {
      return { user, linger: value };
    }
  } catch {
    // ignore; loginctl may be unavailable
  }
  return null;
}

export async function enableSystemdUserLinger(params: {
  env: Record<string, string | undefined>;
  user?: string;
  sudoMode?: "prompt" | "non-interactive";
}): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  const user = params.user ?? resolveLoginctlUser(params.env);
  if (!user) {
    return { ok: false, stdout: "", stderr: "Missing user", code: 1 };
  }
  const needsSudo =
    typeof process.getuid === "function" ? process.getuid() !== 0 : true;
  const sudoArgs =
    needsSudo && params.sudoMode !== undefined
      ? ["sudo", ...(params.sudoMode === "non-interactive" ? ["-n"] : [])]
      : [];
  const argv = [...sudoArgs, "loginctl", "enable-linger", user];
  try {
    const result = await runCommandWithTimeout(argv, { timeoutMs: 30_000 });
    return {
      ok: result.code === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code ?? 1,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, stdout: "", stderr: message, code: 1 };
  }
}

function systemdEscapeArg(value: string): string {
  if (!/[\s"\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderEnvLines(
  env: Record<string, string | undefined> | undefined,
): string[] {
  if (!env) return [];
  const entries = Object.entries(env).filter(
    ([, value]) => typeof value === "string" && value.trim(),
  );
  if (entries.length === 0) return [];
  return entries.map(
    ([key, value]) =>
      `Environment=${systemdEscapeArg(`${key}=${value?.trim() ?? ""}`)}`,
  );
}

function buildSystemdUnit({
  programArguments,
  workingDirectory,
  environment,
}: {
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
}): string {
  const execStart = programArguments.map(systemdEscapeArg).join(" ");
  const workingDirLine = workingDirectory
    ? `WorkingDirectory=${systemdEscapeArg(workingDirectory)}`
    : null;
  const envLines = renderEnvLines(environment);
  return [
    "[Unit]",
    "Description=Clawdbot Gateway",
    "",
    "[Service]",
    `ExecStart=${execStart}`,
    "Restart=always",
    workingDirLine,
    ...envLines,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function parseSystemdExecStart(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let escapeNext = false;

  for (const char of value) {
    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

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

function parseSystemdEnvAssignment(
  raw: string,
): { key: string; value: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const unquoted = (() => {
    if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) return trimmed;
    let out = "";
    let escapeNext = false;
    for (const ch of trimmed.slice(1, -1)) {
      if (escapeNext) {
        out += ch;
        escapeNext = false;
        continue;
      }
      if (ch === "\\") {
        escapeNext = true;
        continue;
      }
      out += ch;
    }
    return out;
  })();

  const eq = unquoted.indexOf("=");
  if (eq <= 0) return null;
  const key = unquoted.slice(0, eq).trim();
  if (!key) return null;
  const value = unquoted.slice(eq + 1);
  return { key, value };
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
        typeof e.stderr === "string"
          ? e.stderr
          : typeof e.message === "string"
            ? e.message
            : "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

async function assertSystemdAvailable() {
  const res = await execSystemctl(["--user", "status"]);
  if (res.code === 0) return;
  const detail = res.stderr || res.stdout;
  if (detail.toLowerCase().includes("not found")) {
    throw new Error(
      "systemctl not available; systemd user services are required on Linux.",
    );
  }
  throw new Error(
    `systemctl --user unavailable: ${detail || "unknown error"}`.trim(),
  );
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
  const unit = buildSystemdUnit({
    programArguments,
    workingDirectory,
    environment,
  });
  await fs.writeFile(unitPath, unit, "utf8");

  const unitName = `${GATEWAY_SYSTEMD_SERVICE_NAME}.service`;
  const reload = await execSystemctl(["--user", "daemon-reload"]);
  if (reload.code !== 0) {
    throw new Error(
      `systemctl daemon-reload failed: ${reload.stderr || reload.stdout}`.trim(),
    );
  }

  const enable = await execSystemctl(["--user", "enable", unitName]);
  if (enable.code !== 0) {
    throw new Error(
      `systemctl enable failed: ${enable.stderr || enable.stdout}`.trim(),
    );
  }

  const restart = await execSystemctl(["--user", "restart", unitName]);
  if (restart.code !== 0) {
    throw new Error(
      `systemctl restart failed: ${restart.stderr || restart.stdout}`.trim(),
    );
  }

  stdout.write(`Installed systemd service: ${unitPath}\n`);
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
  const unitName = `${GATEWAY_SYSTEMD_SERVICE_NAME}.service`;
  await execSystemctl(["--user", "disable", "--now", unitName]);

  const unitPath = resolveSystemdUnitPath(env);
  try {
    await fs.unlink(unitPath);
    stdout.write(`Removed systemd service: ${unitPath}\n`);
  } catch {
    stdout.write(`Systemd service not found at ${unitPath}\n`);
  }
}

export async function stopSystemdService({
  stdout,
}: {
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  await assertSystemdAvailable();
  const unitName = `${GATEWAY_SYSTEMD_SERVICE_NAME}.service`;
  const res = await execSystemctl(["--user", "stop", unitName]);
  if (res.code !== 0) {
    throw new Error(
      `systemctl stop failed: ${res.stderr || res.stdout}`.trim(),
    );
  }
  stdout.write(`Stopped systemd service: ${unitName}\n`);
}

export async function restartSystemdService({
  stdout,
}: {
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  await assertSystemdAvailable();
  const unitName = `${GATEWAY_SYSTEMD_SERVICE_NAME}.service`;
  const res = await execSystemctl(["--user", "restart", unitName]);
  if (res.code !== 0) {
    throw new Error(
      `systemctl restart failed: ${res.stderr || res.stdout}`.trim(),
    );
  }
  stdout.write(`Restarted systemd service: ${unitName}\n`);
}

export async function isSystemdServiceEnabled(): Promise<boolean> {
  await assertSystemdAvailable();
  const unitName = `${GATEWAY_SYSTEMD_SERVICE_NAME}.service`;
  const res = await execSystemctl(["--user", "is-enabled", unitName]);
  return res.code === 0;
}

export async function readSystemdServiceRuntime(): Promise<GatewayServiceRuntime> {
  try {
    await assertSystemdAvailable();
  } catch (err) {
    return {
      status: "unknown",
      detail: String(err),
    };
  }
  const unitName = `${GATEWAY_SYSTEMD_SERVICE_NAME}.service`;
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
  const status =
    activeState === "active" ? "running" : activeState ? "stopped" : "unknown";
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
      const res = await execSystemctl([
        "--user",
        "is-enabled",
        `${name}.service`,
      ]);
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
      await execSystemctl([
        "--user",
        "disable",
        "--now",
        `${unit.name}.service`,
      ]);
    } else {
      stdout.write(
        `systemctl unavailable; removed legacy unit file only: ${unit.name}.service\n`,
      );
    }

    try {
      await fs.unlink(unit.unitPath);
      stdout.write(`Removed legacy systemd service: ${unit.unitPath}\n`);
    } catch {
      stdout.write(`Legacy systemd unit not found at ${unit.unitPath}\n`);
    }
  }

  return units;
}
