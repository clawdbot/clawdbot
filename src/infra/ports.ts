import net from "node:net";
import { danger, info, shouldLogVerbose, warn } from "../globals.js";
import { logDebug } from "../logger.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

class PortInUseError extends Error {
  port: number;
  details?: string;

  constructor(port: number, details?: string) {
    super(`Port ${port} is already in use.`);
    this.name = "PortInUseError";
    this.port = port;
    this.details = details;
  }
}

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err && typeof err === "object" && "code" in err);
}

export async function describePortOwner(
  port: number,
): Promise<string | undefined> {
  const diagnostics = await inspectPortUsage(port);
  if (diagnostics.listeners.length === 0) return undefined;
  return formatPortDiagnostics(diagnostics).join("\n");
}

export async function ensurePortAvailable(port: number): Promise<void> {
  // Detect EADDRINUSE early with a friendly message.
  try {
    await new Promise<void>((resolve, reject) => {
      const tester = net
        .createServer()
        .once("error", (err) => reject(err))
        .once("listening", () => {
          tester.close(() => resolve());
        })
        .listen(port);
    });
  } catch (err) {
    if (isErrno(err) && err.code === "EADDRINUSE") {
      const details = await describePortOwner(port);
      throw new PortInUseError(port, details);
    }
    throw err;
  }
}

export async function handlePortError(
  err: unknown,
  port: number,
  context: string,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<never> {
  // Uniform messaging for EADDRINUSE with optional owner details.
  if (
    err instanceof PortInUseError ||
    (isErrno(err) && err.code === "EADDRINUSE")
  ) {
    const details =
      err instanceof PortInUseError
        ? err.details
        : await describePortOwner(port);
    runtime.error(danger(`${context} failed: port ${port} is already in use.`));
    if (details) {
      runtime.error(info("Port listener details:"));
      runtime.error(details);
      if (/clawdbot|src\/index\.ts|dist\/index\.js/.test(details)) {
        runtime.error(
          warn(
            "It looks like another clawdbot instance is already running. Stop it or pick a different port.",
          ),
        );
      }
    }
    runtime.error(
      info(
        "Resolve by stopping the process using the port or passing --port <free-port>.",
      ),
    );
    runtime.exit(1);
  }
  runtime.error(danger(`${context} failed: ${String(err)}`));
  if (shouldLogVerbose()) {
    const stdout = (err as { stdout?: string })?.stdout;
    const stderr = (err as { stderr?: string })?.stderr;
    if (stdout?.trim()) logDebug(`stdout: ${stdout.trim()}`);
    if (stderr?.trim()) logDebug(`stderr: ${stderr.trim()}`);
  }
  return runtime.exit(1);
}

export { PortInUseError };

export type PortListener = {
  pid?: number;
  command?: string;
  commandLine?: string;
  user?: string;
  address?: string;
};

export type PortUsageStatus = "free" | "busy" | "unknown";

export type PortUsage = {
  port: number;
  status: PortUsageStatus;
  listeners: PortListener[];
  hints: string[];
  detail?: string;
  errors?: string[];
};

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
  error?: string;
};

async function runCommandSafe(
  argv: string[],
  timeoutMs = 5_000,
): Promise<CommandResult> {
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
      if (current.pid || current.command) listeners.push(current);
      const pid = Number.parseInt(line.slice(1), 10);
      current = Number.isFinite(pid) ? { pid } : {};
    } else if (line.startsWith("c")) {
      current.command = line.slice(1);
    }
  }
  if (current.pid || current.command) listeners.push(current);
  return listeners;
}

async function resolveUnixCommandLine(
  pid: number,
): Promise<string | undefined> {
  const res = await runCommandSafe(["ps", "-p", String(pid), "-o", "command="]);
  if (res.code !== 0) return undefined;
  const line = res.stdout.trim();
  return line || undefined;
}

async function resolveUnixUser(pid: number): Promise<string | undefined> {
  const res = await runCommandSafe(["ps", "-p", String(pid), "-o", "user="]);
  if (res.code !== 0) return undefined;
  const line = res.stdout.trim();
  return line || undefined;
}

async function readUnixListeners(
  port: number,
): Promise<{ listeners: PortListener[]; detail?: string; errors: string[] }> {
  const errors: string[] = [];
  const res = await runCommandSafe([
    "lsof",
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-FpFc",
  ]);
  if (res.code === 0) {
    const listeners = parseLsofFieldOutput(res.stdout);
    await Promise.all(
      listeners.map(async (listener) => {
        if (!listener.pid) return;
        const [commandLine, user] = await Promise.all([
          resolveUnixCommandLine(listener.pid),
          resolveUnixUser(listener.pid),
        ]);
        if (commandLine) listener.commandLine = commandLine;
        if (user) listener.user = user;
      }),
    );
    return { listeners, detail: res.stdout.trim() || undefined, errors };
  }
  if (res.code === 1) {
    return { listeners: [], detail: undefined, errors };
  }
  if (res.error) errors.push(res.error);
  const detail = [res.stderr.trim(), res.stdout.trim()]
    .filter(Boolean)
    .join("\n");
  if (detail) errors.push(detail);
  return { listeners: [], detail: undefined, errors };
}

function parseNetstatListeners(output: string, port: number): PortListener[] {
  const listeners: PortListener[] = [];
  const portToken = `:${port}`;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!line.toLowerCase().includes("listen")) continue;
    if (!line.includes(portToken)) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const pidRaw = parts.at(-1);
    const pid = pidRaw ? Number.parseInt(pidRaw, 10) : NaN;
    const localAddr = parts[1];
    const listener: PortListener = {};
    if (Number.isFinite(pid)) listener.pid = pid;
    if (localAddr?.includes(portToken)) listener.address = localAddr;
    listeners.push(listener);
  }
  return listeners;
}

async function resolveWindowsImageName(
  pid: number,
): Promise<string | undefined> {
  const res = await runCommandSafe([
    "tasklist",
    "/FI",
    `PID eq ${pid}`,
    "/FO",
    "LIST",
  ]);
  if (res.code !== 0) return undefined;
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.toLowerCase().startsWith("image name:")) continue;
    const value = line.slice("image name:".length).trim();
    return value || undefined;
  }
  return undefined;
}

async function resolveWindowsCommandLine(
  pid: number,
): Promise<string | undefined> {
  const res = await runCommandSafe([
    "wmic",
    "process",
    "where",
    `ProcessId=${pid}`,
    "get",
    "CommandLine",
    "/value",
  ]);
  if (res.code !== 0) return undefined;
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.toLowerCase().startsWith("commandline=")) continue;
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
    if (res.error) errors.push(res.error);
    const detail = [res.stderr.trim(), res.stdout.trim()]
      .filter(Boolean)
      .join("\n");
    if (detail) errors.push(detail);
    return { listeners: [], errors };
  }
  const listeners = parseNetstatListeners(res.stdout, port);
  await Promise.all(
    listeners.map(async (listener) => {
      if (!listener.pid) return;
      const [imageName, commandLine] = await Promise.all([
        resolveWindowsImageName(listener.pid),
        resolveWindowsCommandLine(listener.pid),
      ]);
      if (imageName) listener.command = imageName;
      if (commandLine) listener.commandLine = commandLine;
    }),
  );
  return { listeners, detail: res.stdout.trim() || undefined, errors };
}

async function checkPortInUse(port: number): Promise<PortUsageStatus> {
  try {
    await new Promise<void>((resolve, reject) => {
      const tester = net
        .createServer()
        .once("error", (err) => reject(err))
        .once("listening", () => {
          tester.close(() => resolve());
        })
        .listen(port);
    });
    return "free";
  } catch (err) {
    if (err instanceof PortInUseError) return "busy";
    if (isErrno(err) && err.code === "EADDRINUSE") return "busy";
    return "unknown";
  }
}

export type PortListenerKind = "gateway" | "ssh" | "unknown";

export function classifyPortListener(
  listener: PortListener,
  port: number,
): PortListenerKind {
  const raw = `${listener.commandLine ?? ""} ${listener.command ?? ""}`
    .trim()
    .toLowerCase();
  if (raw.includes("clawdbot") || raw.includes("clawdis")) return "gateway";
  if (raw.includes("ssh")) {
    const portToken = String(port);
    const tunnelPattern = new RegExp(
      `-(l|r)\\s*${portToken}\\b|-(l|r)${portToken}\\b|:${portToken}\\b`,
    );
    if (!raw || tunnelPattern.test(raw)) return "ssh";
    return "ssh";
  }
  return "unknown";
}

export function buildPortHints(
  listeners: PortListener[],
  port: number,
): string[] {
  if (listeners.length === 0) return [];
  const kinds = new Set(
    listeners.map((listener) => classifyPortListener(listener, port)),
  );
  const hints: string[] = [];
  if (kinds.has("gateway")) {
    hints.push(
      "Gateway already running locally. Stop it (clawdbot gateway stop) or use a different port.",
    );
  }
  if (kinds.has("ssh")) {
    hints.push(
      "SSH tunnel already bound to this port. Close the tunnel or use a different local port in -L.",
    );
  }
  if (kinds.has("unknown")) {
    hints.push("Another process is listening on this port.");
  }
  if (listeners.length > 1) {
    hints.push("Multiple listeners detected; ensure only one gateway/tunnel.");
  }
  return hints;
}

export function formatPortListener(listener: PortListener): string {
  const pid = listener.pid ? `pid ${listener.pid}` : "pid ?";
  const user = listener.user ? ` ${listener.user}` : "";
  const command = listener.commandLine || listener.command || "unknown";
  const address = listener.address ? ` (${listener.address})` : "";
  return `${pid}${user}: ${command}${address}`;
}

export function formatPortDiagnostics(diagnostics: PortUsage): string[] {
  if (diagnostics.status !== "busy") {
    return [`Port ${diagnostics.port} is free.`];
  }
  const lines = [`Port ${diagnostics.port} is already in use.`];
  for (const listener of diagnostics.listeners) {
    lines.push(`- ${formatPortListener(listener)}`);
  }
  for (const hint of diagnostics.hints) {
    lines.push(`- ${hint}`);
  }
  return lines;
}

export async function inspectPortUsage(port: number): Promise<PortUsage> {
  const errors: string[] = [];
  const result =
    process.platform === "win32"
      ? await readWindowsListeners(port)
      : await readUnixListeners(port);
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
