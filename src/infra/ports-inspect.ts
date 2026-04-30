import { runCommandWithTimeout } from "../process/exec.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { isErrno } from "./errors.js";
import { buildPortHints } from "./ports-format.js";
import { resolveLsofCommand } from "./ports-lsof.js";
import { tryListenOnPort } from "./ports-probe.js";
import type { PortListener, PortUsage, PortUsageStatus } from "./ports-types.js";

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
  error?: string;
};

async function runCommandSafe(argv: string[], timeoutMs = 5_000): Promise<CommandResult> {
  try {
    const res = await runCommandWithTimeout(argv, { timeoutMs });
    return {
      stdout: res.stdout,
      stderr: res.stderr,
      code: res.code ?? 1,
    };
  } catch (err) {
    return {
      stdout: "",
      stderr: "",
      code: 1,
      error: String(err),
    };
  }
}

function parseLsofFieldOutput(output: string): PortListener[] {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const listeners: PortListener[] = [];
  let current: PortListener = {};
  for (const line of lines) {
    if (line.startsWith("p")) {
      if (current.pid || current.command) {
        listeners.push(current);
      }
      const pid = Number.parseInt(line.slice(1), 10);
      current = Number.isFinite(pid) ? { pid } : {};
    } else if (line.startsWith("c")) {
      current.command = line.slice(1);
    } else if (line.startsWith("n")) {
      // TCP 127.0.0.1:18789 (LISTEN)
      // TCP *:18789 (LISTEN)
      if (!current.address) {
        current.address = line.slice(1);
      }
    }
  }
  if (current.pid || current.command) {
    listeners.push(current);
  }
  return listeners;
}

async function enrichUnixListenerProcessInfo(listeners: PortListener[]): Promise<void> {
  await Promise.all(
    listeners.map(async (listener) => {
      if (!listener.pid) {
        return;
      }
      const [commandLine, user, parentPid] = await Promise.all([
        resolveUnixCommandLine(listener.pid),
        resolveUnixUser(listener.pid),
        resolveUnixParentPid(listener.pid),
      ]);
      if (commandLine) {
        listener.commandLine = commandLine;
      }
      if (user) {
        listener.user = user;
      }
      if (parentPid !== undefined) {
        listener.ppid = parentPid;
      }
    }),
  );
}

async function resolveUnixCommandLine(pid: number): Promise<string | undefined> {
  const res = await runCommandSafe(["ps", "-p", String(pid), "-o", "command="]);
  if (res.code !== 0) {
    return undefined;
  }
  const line = res.stdout.trim();
  return line || undefined;
}

async function resolveUnixUser(pid: number): Promise<string | undefined> {
  const res = await runCommandSafe(["ps", "-p", String(pid), "-o", "user="]);
  if (res.code !== 0) {
    return undefined;
  }
  const line = res.stdout.trim();
  return line || undefined;
}

async function resolveUnixParentPid(pid: number): Promise<number | undefined> {
  const res = await runCommandSafe(["ps", "-p", String(pid), "-o", "ppid="]);
  if (res.code !== 0) {
    return undefined;
  }
  const line = res.stdout.trim();
  const parentPid = Number.parseInt(line, 10);
  return Number.isFinite(parentPid) && parentPid > 0 ? parentPid : undefined;
}

function parseSsListeners(output: string, port: number): PortListener[] {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const listeners: PortListener[] = [];
  for (const line of lines) {
    if (!line || !line.includes("LISTEN")) {
      continue;
    }
    const parts = line.split(/\s+/);
    const localAddress = parts.find((part) => part.includes(`:${port}`));
    if (!localAddress) {
      continue;
    }
    const listener: PortListener = {
      address: localAddress,
    };
    const pidMatch = line.match(/pid=(\d+)/);
    if (pidMatch) {
      const pid = Number.parseInt(pidMatch[1], 10);
      if (Number.isFinite(pid)) {
        listener.pid = pid;
      }
    }
    const commandMatch = line.match(/users:\(\("([^"]+)"/);
    if (commandMatch?.[1]) {
      listener.command = commandMatch[1];
    }
    listeners.push(listener);
  }
  return listeners;
}

async function readUnixListenersFromSs(
  port: number,
): Promise<{ listeners: PortListener[]; detail?: string; errors: string[] }> {
  const errors: string[] = [];
  const res = await runCommandSafe(["ss", "-H", "-ltnp", `sport = :${port}`]);
  if (res.code === 0) {
    const listeners = parseSsListeners(res.stdout, port);
    await enrichUnixListenerProcessInfo(listeners);
    return { listeners, detail: res.stdout.trim() || undefined, errors };
  }
  const stderr = res.stderr.trim();
  if (res.code === 1 && !res.error && !stderr) {
    return { listeners: [], detail: undefined, errors };
  }
  if (res.error) {
    errors.push(res.error);
  }
  const detail = [stderr, res.stdout.trim()].filter(Boolean).join("\n");
  if (detail) {
    errors.push(detail);
  }
  return { listeners: [], detail: undefined, errors };
}

async function readUnixListeners(
  port: number,
): Promise<{ listeners: PortListener[]; detail?: string; errors: string[] }> {
  const lsof = await resolveLsofCommand();
  const res = await runCommandSafe([lsof, "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-FpFcn"]);
  if (res.code === 0) {
    const listeners = parseLsofFieldOutput(res.stdout);
    await enrichUnixListenerProcessInfo(listeners);
    return { listeners, detail: res.stdout.trim() || undefined, errors: [] };
  }
  const lsofErrors: string[] = [];
  const stderr = res.stderr.trim();
  if (res.code === 1 && !res.error && !stderr) {
    return { listeners: [], detail: undefined, errors: [] };
  }
  if (res.error) {
    lsofErrors.push(res.error);
  }
  const detail = [stderr, res.stdout.trim()].filter(Boolean).join("\n");
  if (detail) {
    lsofErrors.push(detail);
  }

  const ssFallback = await readUnixListenersFromSs(port);
  if (ssFallback.listeners.length > 0) {
    return ssFallback;
  }

  return {
    listeners: [],
    detail: undefined,
    errors: [...lsofErrors, ...ssFallback.errors],
  };
}

function parseNetstatListeners(output: string, port: number): PortListener[] {
  const listeners: PortListener[] = [];
  const portToken = `:${port}`;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (!normalizeLowercaseStringOrEmpty(line).includes("listen")) {
      continue;
    }
    if (!line.includes(portToken)) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 4) {
      continue;
    }
    const pidRaw = parts.at(-1);
    const pid = pidRaw ? Number.parseInt(pidRaw, 10) : Number.NaN;
    const localAddr = parts[1];
    const listener: PortListener = {};
    if (Number.isFinite(pid)) {
      listener.pid = pid;
    }
    if (localAddr?.includes(portToken)) {
      listener.address = localAddr;
    }
    listeners.push(listener);
  }
  return listeners;
}

async function resolveWindowsImageName(pid: number): Promise<string | undefined> {
  const res = await runCommandSafe(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "LIST"]);
  if (res.code !== 0) {
    return undefined;
  }
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!normalizeLowercaseStringOrEmpty(line).startsWith("image name:")) {
      continue;
    }
    const value = line.slice("image name:".length).trim();
    return value || undefined;
  }
  return undefined;
}

async function resolveWindowsCommandLine(pid: number): Promise<string | undefined> {
  const powershell = await runCommandSafe([
    "powershell",
    "-NoProfile",
    "-Command",
    `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine)`,
  ]);
  if (powershell.code === 0) {
    const value = powershell.stdout.trim();
    if (value) {
      return value;
    }
  }

  const wmic = await runCommandSafe([
    "wmic",
    "process",
    "where",
    `ProcessId=${pid}`,
    "get",
    "CommandLine",
    "/value",
  ]);
  if (wmic.code !== 0) {
    return undefined;
  }
  for (const rawLine of wmic.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!normalizeLowercaseStringOrEmpty(line).startsWith("commandline=")) {
      continue;
    }
    const value = line.slice("commandline=".length).trim();
    return value || undefined;
  }
  return undefined;
}

async function readWindowsListeners(
  port: number,
): Promise<{ listeners: PortListener[]; detail?: string; errors: string[] }> {
  const errors: string[] = [];
  const res = await runCommandSafe(["netstat", "-ano", "-p", "tcp"]);
  if (res.code !== 0) {
    if (res.error) {
      errors.push(res.error);
    }
    const detail = [res.stderr.trim(), res.stdout.trim()].filter(Boolean).join("\n");
    if (detail) {
      errors.push(detail);
    }
    return { listeners: [], errors };
  }
  const listeners = parseNetstatListeners(res.stdout, port);
  await Promise.all(
    listeners.map(async (listener) => {
      if (!listener.pid) {
        return;
      }
      const [imageName, commandLine] = await Promise.all([
        resolveWindowsImageName(listener.pid),
        resolveWindowsCommandLine(listener.pid),
      ]);
      if (imageName) {
        listener.command = imageName;
      }
      if (commandLine) {
        listener.commandLine = commandLine;
      }
    }),
  );
  return { listeners, detail: res.stdout.trim() || undefined, errors };
}

async function tryListenOnHost(port: number, host: string): Promise<PortUsageStatus | "skip"> {
  try {
    await tryListenOnPort({ port, host, exclusive: true });
    return "free";
  } catch (err) {
    if (isErrno(err) && err.code === "EADDRINUSE") {
      return "busy";
    }
    if (isErrno(err) && (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT")) {
      return "skip";
    }
    return "unknown";
  }
}

async function checkPortInUse(port: number): Promise<PortUsageStatus> {
  const hosts = ["127.0.0.1", "0.0.0.0", "::1", "::"];
  let sawUnknown = false;
  for (const host of hosts) {
    const result = await tryListenOnHost(port, host);
    if (result === "busy") {
      return "busy";
    }
    if (result === "unknown") {
      sawUnknown = true;
    }
  }
  return sawUnknown ? "unknown" : "free";
}

export async function inspectPortUsage(port: number): Promise<PortUsage> {
  const errors: string[] = [];
  const result =
    process.platform === "win32" ? await readWindowsListeners(port) : await readUnixListeners(port);
  errors.push(...result.errors);
  let listeners = result.listeners;
  let status: PortUsageStatus = listeners.length > 0 ? "busy" : "unknown";
  if (listeners.length === 0) {
    status = await checkPortInUse(port);
  }
  if (status !== "busy") {
    listeners = [];
  }
  const hints = buildPortHints(listeners, port);
  if (status === "busy" && listeners.length === 0) {
    hints.push(
      "Port is in use but process details are unavailable (install lsof or run as an admin user).",
    );
  }
  return {
    port,
    status,
    listeners,
    hints,
    detail: result.detail,
    errors: errors.length > 0 ? errors : undefined,
  };
}
