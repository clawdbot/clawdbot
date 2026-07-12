// Inspects gateway port listeners and connection state.
import os from "node:os";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { runCommandWithTimeout } from "../process/exec.js";
import { parseStrictPositiveInteger } from "./parse-finite-number.js";
import { buildPortHints } from "./ports-format.js";
import { resolveLsofCommand } from "./ports-lsof.js";
import { parseTcpEndpoint, parseWindowsNetstatListeners } from "./ports-netstat.js";
import { probePortUsage } from "./ports-probe.js";
import type {
  PortConnection,
  PortConnectionDirection,
  PortConnections,
  PortListener,
  PortUsage,
  PortUsageStatus,
} from "./ports-types.js";
import {
  getWindowsPowerShellExePath,
  getWindowsSystem32ExePath,
  getWindowsWmicExePath,
} from "./windows-install-roots.js";

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
  let processFields: Pick<PortListener, "pid" | "command"> = {};
  for (const line of lines) {
    if (line.startsWith("p")) {
      const pid = parseStrictPositiveInteger(line.slice(1));
      processFields = pid !== undefined ? { pid } : {};
    } else if (line.startsWith("c")) {
      processFields.command = line.slice(1);
    } else if (line.startsWith("n")) {
      // TCP 127.0.0.1:18789 (LISTEN)
      // TCP *:18789 (LISTEN)
      listeners.push({ ...processFields, address: line.slice(1) });
    }
  }
  return listeners;
}

function dedupePortListeners(listeners: PortListener[]): PortListener[] {
  const seen = new Set<string>();
  return listeners.filter((listener) => {
    const key = `${listener.pid ?? ""}\0${listener.command ?? ""}\0${listener.address ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function parseLsofTcpConnectionAddress(
  address: string | undefined,
): { local: { host: string; port: number }; remote: { host: string; port: number } } | null {
  const normalized = address
    ?.replace(/^tcp\s+/i, "")
    .replace(/\s*\([^)]*\)\s*$/i, "")
    .trim();
  if (!normalized?.includes("->")) {
    return null;
  }
  const [localRaw, remoteRaw] = normalized.split("->", 2);
  const local = parseTcpEndpoint(localRaw ?? "");
  const remote = parseTcpEndpoint(remoteRaw ?? "");
  return local && remote ? { local, remote } : null;
}

function resolveLocalNetworkAddresses(): Set<string> {
  const addresses = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0", "::"]);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      addresses.add(entry.address.toLowerCase());
    }
  }
  return addresses;
}

function isGatewayConnectionAddress(
  address: string | undefined,
  port: number,
  localAddresses: Set<string>,
): boolean {
  const parsed = parseLsofTcpConnectionAddress(address);
  if (!parsed) {
    return false;
  }
  if (parsed.local.port === port) {
    return true;
  }
  return parsed.remote.port === port && localAddresses.has(parsed.remote.host);
}

function resolveLsofTcpDirection(
  address: string | undefined,
  port: number,
): PortConnectionDirection {
  const parsed = parseLsofTcpConnectionAddress(address);
  if (!parsed) {
    return "unknown";
  }
  if (parsed.local.port === port) {
    return "server";
  }
  return parsed.remote.port === port ? "client" : "unknown";
}

function parseLsofConnectionFieldOutput(output: string, port: number): PortConnection[] {
  const connections: PortConnection[] = [];
  const localAddresses = resolveLocalNetworkAddresses();
  for (const entry of parseLsofFieldOutput(output)) {
    if (!isGatewayConnectionAddress(entry.address, port, localAddresses)) {
      continue;
    }
    const connection = entry as PortConnection;
    connection.direction = resolveLsofTcpDirection(entry.address, port);
    connections.push(connection);
  }
  return connections;
}

function parseSsConnectionEndpoint(raw: string): string | null {
  if (raw.startsWith("users:")) {
    return null;
  }
  if (raw.includes(":")) {
    return raw;
  }
  return null;
}

function parseSsConnections(output: string, port: number): PortConnection[] {
  const connections: PortConnection[] = [];
  const localAddresses = resolveLocalNetworkAddresses();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const endpoints = line
      .split(/\s+/)
      .map(parseSsConnectionEndpoint)
      .filter((endpoint): endpoint is string => Boolean(endpoint));
    if (endpoints.length < 2) {
      continue;
    }
    const [local, remote] = endpoints.slice(-2);
    const address = `TCP ${local}->${remote} (ESTABLISHED)`;
    if (!isGatewayConnectionAddress(address, port, localAddresses)) {
      continue;
    }
    const connection: PortConnection = {
      address,
      direction: resolveLsofTcpDirection(address, port),
    };
    const pidMatch = line.match(/pid=(\d+)/);
    if (pidMatch) {
      const pid = Number.parseInt(expectDefined(pidMatch[1], "pid match capture group 1"), 10);
      if (Number.isFinite(pid)) {
        connection.pid = pid;
      }
    }
    const commandMatch = line.match(/users:\(\("([^"]+)"/);
    if (commandMatch?.[1]) {
      connection.command = commandMatch[1];
    }
    connections.push(connection);
  }
  return connections;
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

async function readUnixEstablishedConnectionsFromSs(
  port: number,
): Promise<{ connections: PortConnection[]; detail?: string; errors: string[] }> {
  const errors: string[] = [];
  const res = await runCommandSafe([
    "ss",
    "-H",
    "-tnp",
    "state",
    "established",
    `( sport = :${port} or dport = :${port} )`,
  ]);
  if (res.code === 0) {
    const connections = parseSsConnections(res.stdout, port);
    await enrichUnixListenerProcessInfo(connections);
    return { connections, detail: res.stdout.trim() || undefined, errors };
  }
  const stderr = res.stderr.trim();
  if (res.code === 1 && !res.error && !stderr) {
    return { connections: [], detail: undefined, errors };
  }
  if (res.error) {
    errors.push(res.error);
  }
  const detail = [stderr, res.stdout.trim()].filter(Boolean).join("\n");
  if (detail) {
    errors.push(detail);
  }
  return { connections: [], detail: undefined, errors };
}

async function readUnixEstablishedConnections(
  port: number,
): Promise<{ connections: PortConnection[]; detail?: string; errors: string[] }> {
  const lsof = await resolveLsofCommand();
  const res = await runCommandSafe([lsof, "-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-FpFcn"]);
  if (res.code === 0) {
    const connections = parseLsofConnectionFieldOutput(res.stdout, port);
    await enrichUnixListenerProcessInfo(connections);
    return { connections, detail: res.stdout.trim() || undefined, errors: [] };
  }
  const stderr = res.stderr.trim();
  if (res.code === 1 && !res.error && !stderr) {
    return { connections: [], detail: undefined, errors: [] };
  }
  const errors: string[] = [];
  if (res.error) {
    errors.push(res.error);
  }
  const detail = [stderr, res.stdout.trim()].filter(Boolean).join("\n");
  if (detail) {
    errors.push(detail);
  }

  const ssFallback = await readUnixEstablishedConnectionsFromSs(port);
  if (ssFallback.connections.length > 0) {
    return ssFallback;
  }
  return {
    connections: [],
    detail: undefined,
    errors: [...errors, ...ssFallback.errors],
  };
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
    const localAddress = parts.find((part) => parseTcpEndpoint(part)?.port === port);
    if (!localAddress) {
      continue;
    }
    const listener: PortListener = {
      address: localAddress,
    };
    const pidMatch = line.match(/pid=(\d+)/);
    if (pidMatch) {
      const pid = Number.parseInt(expectDefined(pidMatch[1], "pid match capture group 1"), 10);
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
    const listeners = dedupePortListeners(parseLsofFieldOutput(res.stdout));
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
  return parseWindowsNetstatListeners(output, port);
}

function parseNetstatConnections(output: string, port: number): PortConnection[] {
  const connections: PortConnection[] = [];
  const localAddresses = resolveLocalNetworkAddresses();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !normalizeLowercaseStringOrEmpty(line).includes("established")) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 5) {
      continue;
    }
    const local = parts[1];
    const remote = parts[2];
    const pidRaw = parts.at(-1);
    if (!local || !remote || !pidRaw) {
      continue;
    }
    const address = `TCP ${local}->${remote} (ESTABLISHED)`;
    if (!isGatewayConnectionAddress(address, port, localAddresses)) {
      continue;
    }
    const connection: PortConnection = {
      address,
      direction: resolveLsofTcpDirection(address, port),
    };
    const pid = parseStrictPositiveInteger(pidRaw);
    if (pid !== undefined) {
      connection.pid = pid;
    }
    connections.push(connection);
  }
  return connections;
}

async function resolveWindowsImageName(pid: number): Promise<string | undefined> {
  const res = await runCommandSafe([
    getWindowsSystem32ExePath("tasklist.exe"),
    "/FI",
    `PID eq ${pid}`,
    "/FO",
    "LIST",
  ]);
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
    getWindowsPowerShellExePath(),
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
    getWindowsWmicExePath(),
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

async function readWindowsNetstatEntries<T extends PortListener>(
  port: number,
  parse: (output: string, port: number) => T[],
): Promise<{ entries: T[]; detail?: string; errors: string[] }> {
  const errors: string[] = [];
  const res = await runCommandSafe([getWindowsSystem32ExePath("netstat.exe"), "-ano"]);
  if (res.code !== 0) {
    if (res.error) {
      errors.push(res.error);
    }
    const detail = [res.stderr.trim(), res.stdout.trim()].filter(Boolean).join("\n");
    if (detail) {
      errors.push(detail);
    }
    return { entries: [], errors };
  }

  const entries = parse(res.stdout, port);
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.pid) {
        return;
      }
      const [imageName, commandLine] = await Promise.all([
        resolveWindowsImageName(entry.pid),
        resolveWindowsCommandLine(entry.pid),
      ]);
      if (imageName) {
        entry.command = imageName;
      }
      if (commandLine) {
        entry.commandLine = commandLine;
      }
    }),
  );
  return { entries, detail: res.stdout.trim() || undefined, errors };
}

async function readWindowsListeners(
  port: number,
): Promise<{ listeners: PortListener[]; detail?: string; errors: string[] }> {
  const result = await readWindowsNetstatEntries(port, parseNetstatListeners);
  return { listeners: result.entries, detail: result.detail, errors: result.errors };
}

async function readWindowsEstablishedConnections(
  port: number,
): Promise<{ connections: PortConnection[]; detail?: string; errors: string[] }> {
  const result = await readWindowsNetstatEntries(port, parseNetstatConnections);
  return { connections: result.entries, detail: result.detail, errors: result.errors };
}

export async function inspectPortUsage(port: number): Promise<PortUsage> {
  const errors: string[] = [];
  const result =
    process.platform === "win32" ? await readWindowsListeners(port) : await readUnixListeners(port);
  errors.push(...result.errors);
  let listeners = result.listeners;
  let status: PortUsageStatus = listeners.length > 0 ? "busy" : "unknown";
  if (listeners.length === 0) {
    status = await probePortUsage(port);
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

export async function inspectPortConnections(port: number): Promise<PortConnections> {
  const result =
    process.platform === "win32"
      ? await readWindowsEstablishedConnections(port)
      : await readUnixEstablishedConnections(port);
  return {
    port,
    connections: result.connections,
    detail: result.detail,
    errors: result.errors.length > 0 ? result.errors : undefined,
  };
}
