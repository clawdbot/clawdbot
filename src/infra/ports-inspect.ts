// Inspects gateway port listeners and connection state.
import net from "node:net";
import os from "node:os";
import { expectDefined } from "@openclaw/normalization-core";
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import pMap from "p-map";
import { runCommandWithTimeout } from "../process/exec.js";
import { buildPortHints } from "./ports-format.js";
import {
  parseLsofListenerRecordsByPort,
  readLsofListenersForPort,
  type LsofListenerRecord,
} from "./ports-lsof-listeners.js";
import { resolveLsofCommand } from "./ports-lsof.js";
import {
  parseTcpEndpoint,
  parseTcpListenerEndpoint,
  parseWindowsNetstatListeners,
} from "./ports-netstat.js";
import { probePortUsage } from "./ports-probe.js";
import type {
  PortConnection,
  PortConnectionDirection,
  PortConnections,
  PortListener,
  PortUsage,
  PortUsageStatus,
} from "./ports-types.js";
import { resolveDiagnosticProcessEnv } from "./process-env.js";
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

type ListenerReadResult = {
  listeners: PortListener[];
  detail?: string;
  errors: string[];
};

type UnixListenerSnapshot = {
  recordsByPort: Map<number, LsofListenerRecord[]>;
  errors: string[];
  lsofUnavailable: boolean;
};

// Each enrichment batch bounds its native process-metadata subprocesses.
const PORT_PROCESS_ENRICHMENT_CONCURRENCY = 20;

async function runCommandSafe(argv: string[], timeoutMs = 5_000): Promise<CommandResult> {
  try {
    // env overrides alone would merge the ambient application environment back in.
    const res = await runCommandWithTimeout(argv, {
      timeoutMs,
      baseEnv: resolveDiagnosticProcessEnv(),
    });
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

function resolveGatewayConnectionDirection(
  address: string | undefined,
  port: number,
  localAddresses: Set<string>,
): PortConnectionDirection | undefined {
  const parsed = parseLsofTcpConnectionAddress(address);
  if (!parsed) {
    return undefined;
  }
  if (parsed.local.port === port) {
    return "server";
  }
  return parsed.remote.port === port && localAddresses.has(parsed.remote.host)
    ? "client"
    : undefined;
}

function parseLsofConnectionFieldOutput(output: string, port: number): PortConnection[] {
  const connections: PortConnection[] = [];
  const localAddresses = resolveLocalNetworkAddresses();
  for (const entry of parseLsofFieldOutput(output)) {
    const direction = resolveGatewayConnectionDirection(entry.address, port, localAddresses);
    if (direction) {
      connections.push({ ...entry, direction });
    }
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
    const direction = resolveGatewayConnectionDirection(address, port, localAddresses);
    if (!direction) {
      continue;
    }
    const connection: PortConnection = {
      address,
      direction,
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
  const pids = [...new Set(listeners.flatMap(({ pid }) => (pid ? [pid] : [])))];
  const metadata = new Map(
    await pMap(pids, async (pid) => [pid, await resolveUnixProcessInfo(pid)] as const, {
      concurrency: PORT_PROCESS_ENRICHMENT_CONCURRENCY,
    }),
  );
  for (const listener of listeners) {
    if (listener.pid) {
      Object.assign(listener, metadata.get(listener.pid));
    }
  }
}

async function readUnixSocketOutput(argv: string[]): Promise<{
  stdout?: string;
  errors: string[];
  unavailable: boolean;
}> {
  const res = await runCommandSafe(argv);
  if (res.code === 0) {
    return { stdout: res.stdout, errors: [], unavailable: false };
  }
  const stderr = res.stderr.trim();
  // lsof/ss use a quiet exit 1 for no matches; it must not trigger another collector.
  if (res.code === 1 && !res.error && !stderr) {
    return { errors: [], unavailable: false };
  }
  const detail = [stderr, res.stdout.trim()].filter(Boolean).join("\n");
  return {
    errors: [...(res.error ? [res.error] : []), ...(detail ? [detail] : [])],
    unavailable: true,
  };
}

async function readUnixSocketEntries<T extends PortListener>(
  argv: string[],
  parse: (output: string) => T[],
) {
  const result = await readUnixSocketOutput(argv);
  const entries = result.stdout === undefined ? [] : parse(result.stdout);
  return {
    entries,
    detail: result.stdout?.trim() || undefined,
    errors: result.errors,
    unavailable: result.unavailable,
  };
}

async function readUnixEstablishedConnections(
  port: number,
): Promise<{ connections: PortConnection[]; detail?: string; errors: string[] }> {
  const lsof = await resolveLsofCommand();
  const primary = await readUnixSocketEntries(
    [lsof, "-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-FpFcn"],
    (output) => parseLsofConnectionFieldOutput(output, port),
  );
  if (!primary.unavailable) {
    return { connections: primary.entries, detail: primary.detail, errors: primary.errors };
  }
  const fallback = await readUnixSocketEntries(
    ["ss", "-H", "-tnp", "state", "established", `( sport = :${port} or dport = :${port} )`],
    (output) => parseSsConnections(output, port),
  );
  return {
    connections: fallback.entries,
    detail: fallback.entries.length > 0 ? fallback.detail : undefined,
    errors: fallback.entries.length > 0 ? fallback.errors : [...primary.errors, ...fallback.errors],
  };
}

async function resolveUnixProcessInfo(
  pid: number,
): Promise<Pick<PortListener, "commandLine" | "user" | "ppid">> {
  // Keep usernames separate: native ps pads them by bytes on macOS and display
  // columns on Linux, and directory-service names can themselves contain spaces.
  const res = await runCommandSafe([
    "ps",
    "-p",
    String(pid),
    "-ww",
    "-o",
    "ppid=",
    "-o",
    "command=",
  ]);
  const userResult = await runCommandSafe(["ps", "-p", String(pid), "-o", "user="]);
  const fields = res.code === 0 ? /^\s*(\S+)(?:\s+([\s\S]*))?$/.exec(res.stdout) : null;
  const parentPid = Number.parseInt(fields?.[1] ?? "", 10);
  const commandLine = fields?.[2]?.trim();
  const user = userResult.code === 0 ? userResult.stdout.trim() : "";
  return {
    ...(user ? { user } : {}),
    ...(commandLine ? { commandLine } : {}),
    ...(Number.isFinite(parentPid) && parentPid > 0 ? { ppid: parentPid } : {}),
  };
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

async function readUnixListenerSnapshot(port?: number): Promise<UnixListenerSnapshot> {
  const lsof = await resolveLsofCommand();
  // Keep single-port lifecycle checks targeted; batches share one all-port scan.
  const tcpSelector = port === undefined ? "-iTCP" : `-iTCP:${port}`;
  const result = await readUnixSocketOutput([lsof, "-nP", tcpSelector, "-sTCP:LISTEN", "-FpFcn"]);
  return {
    recordsByPort:
      result.stdout === undefined ? new Map() : parseLsofListenerRecordsByPort(result.stdout),
    errors: result.errors,
    lsofUnavailable: result.unavailable,
  };
}

async function readUnixListeners(
  port: number,
  snapshot?: UnixListenerSnapshot,
): Promise<ListenerReadResult> {
  const listenerSnapshot = snapshot ?? (await readUnixListenerSnapshot(port));
  if (!listenerSnapshot.lsofUnavailable) {
    const result = readLsofListenersForPort(listenerSnapshot.recordsByPort, port);
    return { ...result, errors: listenerSnapshot.errors };
  }
  const fallback = await readUnixSocketEntries(
    ["ss", "-H", "-ltnp", `sport = :${port}`],
    (output) => parseSsListeners(output, port),
  );
  return {
    listeners: fallback.entries,
    detail: fallback.entries.length > 0 ? fallback.detail : undefined,
    errors:
      fallback.entries.length > 0
        ? fallback.errors
        : [...listenerSnapshot.errors, ...fallback.errors],
  };
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
    const direction = resolveGatewayConnectionDirection(address, port, localAddresses);
    if (!direction) {
      continue;
    }
    const connection: PortConnection = {
      address,
      direction,
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
    "CSV",
    "/NH",
  ]);
  if (res.code !== 0) {
    return undefined;
  }
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^"([^"]+)","(\d+)",/);
    if (match?.[1] && match[2] === String(pid)) {
      return match[1];
    }
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
  await pMap(
    entries,
    async (entry) => {
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
    },
    { concurrency: PORT_PROCESS_ENRICHMENT_CONCURRENCY },
  );
  return { entries, detail: res.stdout.trim() || undefined, errors };
}

async function readWindowsListeners(port: number): Promise<ListenerReadResult> {
  const result = await readWindowsNetstatEntries(port, parseWindowsNetstatListeners);
  return { listeners: result.entries, detail: result.detail, errors: result.errors };
}

async function readWindowsEstablishedConnections(
  port: number,
): Promise<{ connections: PortConnection[]; detail?: string; errors: string[] }> {
  const result = await readWindowsNetstatEntries(port, parseNetstatConnections);
  return { connections: result.entries, detail: result.detail, errors: result.errors };
}

export async function inspectPortUsage(
  port: number,
  options?: { probeHosts?: readonly string[] },
): Promise<PortUsage> {
  const result =
    process.platform === "win32" ? await readWindowsListeners(port) : await readUnixListeners(port);
  if (process.platform !== "win32") {
    await enrichUnixListenerProcessInfo(result.listeners);
  }
  return buildPortUsage(port, result, options?.probeHosts);
}

async function buildPortUsage(
  port: number,
  result: ListenerReadResult,
  probeHosts?: readonly string[],
): Promise<PortUsage> {
  const errors: string[] = [];
  errors.push(...result.errors);
  let listeners = result.listeners;
  const status: PortUsageStatus = probeHosts
    ? await probePortUsage(port, probeHosts)
    : listeners.length > 0
      ? "busy"
      : await probePortUsage(port);
  if (status !== "busy") {
    listeners = [];
  } else if (probeHosts) {
    listeners = listeners.filter((listener) =>
      isListenerRelevantToProbeHosts(listener, port, probeHosts),
    );
  }
  const hints = buildPortHints(listeners, port);
  if (status === "busy" && listeners.length === 0) {
    // The bind probe is authoritative; filtered diagnostics must never turn busy into free.
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

function isWildcardTcpHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "*";
}

function isSameTcpAddressFamily(leftHost: string, rightHost: string): boolean {
  const leftFamily = net.isIP(leftHost);
  const rightFamily = net.isIP(rightHost);
  return leftFamily === 0 || rightFamily === 0 || leftFamily === rightFamily;
}

function isListenerRelevantToProbeHosts(
  listener: PortListener,
  port: number,
  probeHosts: readonly string[],
): boolean {
  const endpoint = parseTcpListenerEndpoint(listener.address);
  if (!endpoint || endpoint.port !== port) {
    return false;
  }
  return probeHosts.some((probeHost) => {
    const normalizedProbeHost = normalizeLowercaseStringOrEmpty(probeHost);
    if (isWildcardTcpHost(endpoint.host)) {
      return isSameTcpAddressFamily(endpoint.host, normalizedProbeHost);
    }
    if (isWildcardTcpHost(normalizedProbeHost)) {
      return isSameTcpAddressFamily(normalizedProbeHost, endpoint.host);
    }
    return normalizedProbeHost === endpoint.host;
  });
}

export async function inspectPortUsages(
  ports: readonly number[],
  options?: { probeHostsByPort?: ReadonlyMap<number, readonly string[]> },
): Promise<Map<number, PortUsage>> {
  const uniquePorts = Array.from(new Set(ports));
  if (process.platform === "win32") {
    const entries = await Promise.all(
      uniquePorts.map(async (port) => {
        const probeHosts = options?.probeHostsByPort?.get(port);
        return [
          port,
          await inspectPortUsage(port, probeHosts ? { probeHosts } : undefined),
        ] as const;
      }),
    );
    return new Map(entries);
  }

  const snapshot = await readUnixListenerSnapshot();
  const results = await Promise.all(uniquePorts.map((port) => readUnixListeners(port, snapshot)));
  await enrichUnixListenerProcessInfo(results.flatMap(({ listeners }) => listeners));
  const entries = await Promise.all(
    uniquePorts.map(
      async (port, index) =>
        [
          port,
          await buildPortUsage(port, results[index]!, options?.probeHostsByPort?.get(port)),
        ] as const,
    ),
  );
  return new Map(entries);
}

export async function inspectPortConnections(port: number): Promise<PortConnections> {
  const result =
    process.platform === "win32"
      ? await readWindowsEstablishedConnections(port)
      : await readUnixEstablishedConnections(port);
  if (process.platform !== "win32") {
    await enrichUnixListenerProcessInfo(result.connections);
  }
  return {
    port,
    connections: result.connections,
    detail: result.detail,
    errors: result.errors.length > 0 ? result.errors : undefined,
  };
}
