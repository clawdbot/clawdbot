/**
 * Chrome MCP existing-session adapter.
 *
 * Manages chrome-devtools-mcp processes and sessions, maps Browser actions to
 * MCP tools, and exposes tab/snapshot/action helpers for logged-in browsers.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleepTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { createAsyncLock } from "openclaw/plugin-sdk/async-lock-runtime";
import {
  addTimerTimeoutGraceMs,
  resolveNonNegativeIntegerOption,
} from "openclaw/plugin-sdk/number-runtime";
import {
  normalizeOptionalString,
  readStringValue,
  uniqueStrings,
  uniqueValues,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { asRecord } from "../record-shared.js";
import { createBoundedUtf8Tail, decodeBoundedUtf8Tail } from "./bounded-utf8-tail.js";
import { redactCdpErrorText, redactCdpUrl } from "./cdp.helpers.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";
import type { BrowserTab } from "./client.types.js";
import { BrowserProfileUnavailableError, BrowserTabNotFoundError } from "./errors.js";

const log = createSubsystemLogger("browser").child("chrome-mcp");

type ChromeMcpStructuredPage = {
  id: number;
  url?: string;
  selected?: boolean;
};

type ChromeMcpToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
};

type ChromeMcpSession = {
  client: Client;
  transport: StdioClientTransport;
  ready: Promise<void>;
  ownsProcessTree?: boolean;
  routing?: ChromeMcpRoutingState;
};

type ChromeMcpRoutingState = {
  sessionNonce: string;
  withOperationLock: ReturnType<typeof createAsyncLock>;
  targetIdByPageId: Map<number, string>;
  nextTargetHandleId: number;
  snapshotRefById: Map<string, { targetId: string; uid: string }>;
  nextSnapshotRefId: number;
};

export type ChromeMcpOperationOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

type ChromeMcpTargetOperation = ChromeMcpOperationOptions & {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
};

type ChromeMcpCallOptions = ChromeMcpOperationOptions & {
  ephemeral?: boolean;
};

const MCP_REQUEST_TIMEOUT_CODE: number = ErrorCode.RequestTimeout;

/** Browser profile options used to connect or launch chrome-devtools-mcp. */
export type ChromeMcpProfileOptions = {
  userDataDir?: string;
  cdpUrl?: string;
  mcpCommand?: string;
  mcpArgs?: string[];
};

type NormalizedChromeMcpProfileOptions = {
  userDataDir?: string;
  browserUrl?: string;
  command: string;
  extraArgs: string[];
};
type ChromeMcpOptionsInput = string | ChromeMcpProfileOptions | NormalizedChromeMcpProfileOptions;

type ChromeMcpSessionLease = {
  session: ChromeMcpSession;
  cacheKey: string;
  temporary: boolean;
};

type ChromeMcpSessionFactory = (
  profileName: string,
  options?: NormalizedChromeMcpProfileOptions,
) => Promise<ChromeMcpSession>;

type PendingChromeMcpSession = {
  cacheKey: string;
  id: symbol;
  promise: Promise<ChromeMcpSession>;
  abortController: AbortController;
  state: {
    waiters: number;
    settled: boolean;
  };
};

type PendingChromeMcpSessionLease = {
  session: ChromeMcpSession;
  release: (closeIfLastWaiter: boolean) => Promise<boolean>;
};

/** Minimal process info used when cleaning up MCP child process trees. */
type ChromeMcpProcessInfo = {
  pid: number;
  ppid: number;
};

/** Injectable process cleanup dependencies for platform-specific tests. */
type ChromeMcpProcessCleanupDeps = {
  listProcesses?: () => Promise<ChromeMcpProcessInfo[]>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
  taskkillProcessTree?: (pid: number) => Promise<void>;
};

const DEFAULT_CHROME_MCP_COMMAND = "npx";
const DEFAULT_CHROME_MCP_PACKAGE_ARGS = ["-y", "chrome-devtools-mcp@latest"];
const DEFAULT_CHROME_MCP_FEATURE_ARGS = [
  "--no-usage-statistics",
  // Direct chrome-devtools-mcp launches do not enable structuredContent by default.
  "--experimentalStructuredContent",
  "--experimental-page-id-routing",
];
const CHROME_MCP_USAGE_STATISTICS_FLAG_RE = /^--(?:no-)?usage-?statistics(?:=.*)?$/i;
const CHROME_MCP_CONNECTION_FLAGS = new Set([
  "--autoConnect",
  "--auto-connect",
  "--browserUrl",
  "--browser-url",
  "--wsEndpoint",
  "--ws-endpoint",
  "-w",
]);
const CHROME_MCP_USER_DATA_DIR_FLAGS = new Set(["--userDataDir", "--user-data-dir"]);
const CHROME_MCP_NEW_PAGE_TIMEOUT_MS = 5_000;
const CHROME_MCP_NAVIGATE_TIMEOUT_MS = 20_000;
const CHROME_MCP_HANDSHAKE_TIMEOUT_MS = 30_000;
const CHROME_MCP_STDERR_MAX_BYTES = 8 * 1024;
const CHROME_MCP_PROCESS_EXIT_GRACE_MS = 250;
const DEVTOOLS_ACTIVE_PORT_RE = /\bDevToolsActivePort\b/i;
const CHROME_CONNECTION_TOOL_ERROR_RE =
  /(?:Could not connect to Chrome|DevToolsActivePort|ECONNREFUSED|ECONNRESET|websocket|timed out)/i;
const STALE_SELECTED_PAGE_ERROR =
  "The selected page has been closed. Call list_pages to see open pages.";
const CHROME_MCP_SESSION_TARGET_PREFIX = "chrome-mcp:";
const CHROME_MCP_SNAPSHOT_REF_PREFIX = "mcp-ref:";

class ChromeMcpReconnectRequiredError extends Error {}

const execFileAsync = promisify(execFile);
const sessions = new Map<string, ChromeMcpSession>();
const pendingSessions = new Map<string, PendingChromeMcpSession>();
let sessionFactory: ChromeMcpSessionFactory | null = null;
let chromeMcpProcessCleanupDepsForTest: ChromeMcpProcessCleanupDeps | null = null;

/** Decode a bounded UTF-8-safe stderr tail for Chrome MCP diagnostics. */
export function decodeChromeMcpStderrTail(buffer: Buffer): string {
  return decodeBoundedUtf8Tail(buffer, CHROME_MCP_STDERR_MAX_BYTES).trim();
}

function asPages(value: unknown): ChromeMcpStructuredPage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ChromeMcpStructuredPage[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record || typeof record.id !== "number") {
      continue;
    }
    out.push({
      id: record.id,
      url: readStringValue(record.url),
      selected: record.selected === true,
    });
  }
  return out;
}

function getChromeMcpRoutingState(session: ChromeMcpSession): ChromeMcpRoutingState {
  // Routing state lives exactly as long as one stdio subprocess. The compact
  // nonce expires old handles/refs; the lock keeps remote actions aligned with
  // local mappings and snapshot refs.
  session.routing ??= {
    sessionNonce: randomUUID().replaceAll("-", "").slice(0, 12),
    withOperationLock: createAsyncLock(),
    targetIdByPageId: new Map(),
    nextTargetHandleId: 1,
    snapshotRefById: new Map(),
    nextSnapshotRefId: 1,
  };
  return session.routing;
}

async function withChromeMcpOperationLock<T>(
  session: ChromeMcpSession,
  options: ChromeMcpOperationOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const signal = options.signal;
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }

  let started = false;
  let cancelled = false;
  let cancelReason: Error | undefined;
  const queued = getChromeMcpRoutingState(session).withOperationLock(async () => {
    if (cancelled) {
      throw cancelReason ?? new Error("Chrome MCP operation cancelled before it started.");
    }
    started = true;
    if (signal?.aborted) {
      throw signal.reason ?? new Error("aborted");
    }
    return await operation();
  });

  const timeoutMs = options.timeoutMs;
  if (!signal && !(timeoutMs !== undefined && timeoutMs > 0)) {
    return await queued;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const cancelBeforeStart = new Promise<never>((_resolve, reject) => {
    const cancel = (reason: unknown) => {
      if (started || cancelled) {
        return;
      }
      cancelled = true;
      cancelReason = toLintErrorObject(reason, "Chrome MCP operation cancelled");
      reject(cancelReason);
    };
    if (signal) {
      abortListener = () => cancel(signal.reason ?? new Error("aborted"));
      signal.addEventListener("abort", abortListener, { once: true });
    }
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(
        () =>
          cancel(
            new Error(
              `Chrome MCP operation timed out after ${timeoutMs}ms while waiting for another operation.`,
            ),
          ),
        timeoutMs,
      );
      timer.unref?.();
    }
  });

  try {
    return await Promise.race([queued, cancelBeforeStart]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
    if (cancelled) {
      void queued.catch(() => {});
    }
  }
}

function clearChromeMcpSnapshotRefsForTarget(
  routing: ChromeMcpRoutingState,
  targetId: string,
): void {
  for (const [refId, ref] of routing.snapshotRefById) {
    if (ref.targetId === targetId) {
      routing.snapshotRefById.delete(refId);
    }
  }
}

function updateChromeMcpTargetMappings(
  routing: ChromeMcpRoutingState,
  targetIdByPageId: Map<number, string>,
): void {
  for (const [pageId, targetId] of routing.targetIdByPageId) {
    if (!targetIdByPageId.has(pageId)) {
      clearChromeMcpSnapshotRefsForTarget(routing, targetId);
    }
  }
  routing.targetIdByPageId = targetIdByPageId;
}

function wrapChromeMcpSnapshotRefs(
  session: ChromeMcpSession,
  targetId: string,
  root: ChromeMcpSnapshotNode,
): ChromeMcpSnapshotNode {
  const routing = getChromeMcpRoutingState(session);
  clearChromeMcpSnapshotRefsForTarget(routing, targetId);
  const wrappedByUid = new Map<string, string>();

  const visit = (node: ChromeMcpSnapshotNode): ChromeMcpSnapshotNode => {
    const rawUid = normalizeOptionalString(node.id);
    let id: string | undefined;
    if (rawUid) {
      id = wrappedByUid.get(rawUid);
      if (!id) {
        id = `${CHROME_MCP_SNAPSHOT_REF_PREFIX}${routing.sessionNonce}:${routing.nextSnapshotRefId}`;
        routing.nextSnapshotRefId += 1;
        wrappedByUid.set(rawUid, id);
        routing.snapshotRefById.set(id, { targetId, uid: rawUid });
      }
    }
    return {
      ...node,
      ...(id ? { id } : {}),
      ...(node.children ? { children: node.children.map(visit) } : {}),
    };
  };

  return visit(root);
}

function resolveChromeMcpSnapshotRef(
  session: ChromeMcpSession,
  targetId: string,
  refId: string,
): string {
  const resolved = getChromeMcpRoutingState(session).snapshotRefById.get(refId);
  if (!resolved || resolved.targetId !== targetId) {
    throw new Error(`Unknown ref "${refId}". Run a new snapshot and use a ref from that snapshot.`);
  }
  return resolved.uid;
}

function extractStructuredContent(result: ChromeMcpToolResult): Record<string, unknown> {
  return asRecord(result.structuredContent) ?? {};
}

function extractTextContent(result: ChromeMcpToolResult): string[] {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((entry) => {
      const record = asRecord(entry);
      return record && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean);
}

function extractTextPages(result: ChromeMcpToolResult): ChromeMcpStructuredPage[] {
  const pages: ChromeMcpStructuredPage[] = [];
  for (const block of extractTextContent(result)) {
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+):\s+(.+?)(?:\s+\[(selected)\])?\s*$/i);
      if (!match) {
        continue;
      }
      pages.push({
        id: Number.parseInt(match[1] ?? "", 10),
        url: normalizeOptionalString(match[2]),
        selected: Boolean(match[3]),
      });
    }
  }
  return pages;
}

function extractStructuredPages(result: ChromeMcpToolResult): ChromeMcpStructuredPage[] {
  const structured = asPages(extractStructuredContent(result).pages);
  return structured.length > 0 ? structured : extractTextPages(result);
}

function extractSnapshot(result: ChromeMcpToolResult): ChromeMcpSnapshotNode {
  const structured = extractStructuredContent(result);
  const snapshot = asRecord(structured.snapshot);
  if (!snapshot) {
    throw new Error("Chrome MCP snapshot response was missing structured snapshot data.");
  }
  return snapshot as unknown as ChromeMcpSnapshotNode;
}

function extractJsonBlock(text: string): unknown {
  const match = text.match(/```json\s*([\s\S]*?)\s*```/i);
  const raw = match?.[1]?.trim() || text.trim();
  return raw ? JSON.parse(raw) : null;
}

function extractMessageText(result: ChromeMcpToolResult): string {
  const message = extractStructuredContent(result).message;
  if (typeof message === "string" && message.trim()) {
    return message;
  }
  const blocks = extractTextContent(result);
  return blocks.find((block) => block.trim()) ?? "";
}

function extractToolErrorMessage(result: ChromeMcpToolResult, name: string): string {
  const message = extractMessageText(result).trim();
  return message || `Chrome MCP tool "${name}" failed.`;
}

function formatChromeMcpEndpointForDiagnostic(browserUrl: string): string {
  return redactToolPayloadText(redactCdpUrl(browserUrl) ?? browserUrl);
}

function formatChromeMcpToolErrorMessage(params: {
  profileName: string;
  options: NormalizedChromeMcpProfileOptions;
  toolName: string;
  message: string;
}): string {
  const detail = redactChromeMcpDiagnosticTextWithLocalPaths(params.message);
  const profileLabel = redactChromeMcpProfileLabelForDiagnostic(params.profileName);
  if (params.options.browserUrl && CHROME_CONNECTION_TOOL_ERROR_RE.test(params.message)) {
    return (
      `Chrome MCP tool "${params.toolName}" failed for profile "${profileLabel}" while using ` +
      `the configured Chrome endpoint (${formatChromeMcpEndpointForDiagnostic(params.options.browserUrl)}). ` +
      `Details: ${detail}`
    );
  }
  if (
    !params.options.browserUrl &&
    params.options.userDataDir &&
    DEVTOOLS_ACTIVE_PORT_RE.test(params.message)
  ) {
    const cdpUrlPath = path.isAbsolute(params.profileName)
      ? "this existing-session profile's cdpUrl"
      : `browser.profiles.${params.profileName}.cdpUrl`;
    return (
      `${detail} If this browser was started with --remote-debugging-port, set ${cdpUrlPath} ` +
      "to that DevTools endpoint instead of relying on Chrome MCP auto-connect."
    );
  }
  return detail;
}

function shouldReconnectForToolError(name: string, message: string): boolean {
  return name === "list_pages" && message.includes(STALE_SELECTED_PAGE_ERROR);
}

function extractJsonMessage(result: ChromeMcpToolResult): unknown {
  const candidates = [extractMessageText(result), ...extractTextContent(result)].filter((text) =>
    text.trim(),
  );
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return extractJsonBlock(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) {
    throw toLintErrorObject(lastError, "Non-Error thrown");
  }
  return null;
}

function normalizeChromeMcpUserDataDir(userDataDir?: string): string | undefined {
  const trimmed = userDataDir?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeChromeMcpStringList(values?: string[]): string[] {
  return Array.isArray(values)
    ? values.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
}

function normalizeChromeMcpOptions(
  input?: ChromeMcpOptionsInput,
): NormalizedChromeMcpProfileOptions {
  if (typeof input === "object" && input && "command" in input && "extraArgs" in input) {
    return input;
  }
  const options = typeof input === "string" ? { userDataDir: input } : (input ?? {});
  const command = normalizeOptionalString(options.mcpCommand) ?? DEFAULT_CHROME_MCP_COMMAND;
  return {
    command,
    userDataDir: normalizeChromeMcpUserDataDir(options.userDataDir),
    browserUrl: normalizeOptionalString(options.cdpUrl),
    extraArgs: normalizeChromeMcpStringList(options.mcpArgs),
  };
}

function hasFlag(args: string[], flags: Set<string>): boolean {
  return args.some((arg) => {
    const [name] = arg.split("=", 1);
    return flags.has(name ?? arg);
  });
}

function isChromeMcpWebSocketEndpoint(url: string): boolean {
  return /^wss?:\/\//i.test(url);
}

function buildChromeMcpConnectionArgs(options: NormalizedChromeMcpProfileOptions): string[] {
  if (hasFlag(options.extraArgs, CHROME_MCP_CONNECTION_FLAGS)) {
    return [];
  }
  if (options.browserUrl) {
    return isChromeMcpWebSocketEndpoint(options.browserUrl)
      ? ["--wsEndpoint", options.browserUrl]
      : ["--browserUrl", options.browserUrl];
  }
  return ["--autoConnect"];
}

function buildChromeMcpUserDataDirArgs(options: NormalizedChromeMcpProfileOptions): string[] {
  if (
    !options.userDataDir ||
    options.browserUrl ||
    hasFlag(options.extraArgs, CHROME_MCP_CONNECTION_FLAGS) ||
    hasFlag(options.extraArgs, CHROME_MCP_USER_DATA_DIR_FLAGS)
  ) {
    return [];
  }
  return ["--userDataDir", options.userDataDir];
}

function buildChromeMcpSessionCacheKey(
  profileName: string,
  options: NormalizedChromeMcpProfileOptions,
): string {
  return JSON.stringify([
    profileName,
    options.userDataDir ?? "",
    options.browserUrl ?? "",
    options.command,
    options.extraArgs,
  ]);
}

function chromeMcpProfileOptionsFromParams(params: {
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
}): string | ChromeMcpProfileOptions | undefined {
  return params.profile ?? params.userDataDir;
}

function cacheKeyMatchesProfileName(cacheKey: string, profileName: string): boolean {
  try {
    const parsed = JSON.parse(cacheKey);
    return Array.isArray(parsed) && parsed[0] === profileName;
  } catch {
    return false;
  }
}

async function closeChromeMcpSessionsForProfile(
  profileName: string,
  keepKey?: string,
): Promise<boolean> {
  let closed = false;

  for (const [key, pending] of Array.from(pendingSessions.entries())) {
    if (key !== keepKey && cacheKeyMatchesProfileName(key, profileName)) {
      pendingSessions.delete(key);
      abortPendingChromeMcpSession(pending, new Error("Chrome MCP profile session was replaced"));
      closed = true;
    }
  }

  for (const [key, session] of Array.from(sessions.entries())) {
    if (key !== keepKey && cacheKeyMatchesProfileName(key, profileName)) {
      sessions.delete(key);
      closed = true;
      await closeChromeMcpSessionHandle(session);
    }
  }

  return closed;
}

function buildChromeMcpArgsFromOptions(options: NormalizedChromeMcpProfileOptions): string[] {
  const commandPrefix =
    options.command === DEFAULT_CHROME_MCP_COMMAND ? DEFAULT_CHROME_MCP_PACKAGE_ARGS : [];
  const defaultFeatureArgs = options.extraArgs.some((arg) =>
    CHROME_MCP_USAGE_STATISTICS_FLAG_RE.test(arg),
  )
    ? DEFAULT_CHROME_MCP_FEATURE_ARGS.filter((arg) => arg !== "--no-usage-statistics")
    : DEFAULT_CHROME_MCP_FEATURE_ARGS;
  return [
    ...commandPrefix,
    ...buildChromeMcpConnectionArgs(options),
    ...defaultFeatureArgs,
    ...buildChromeMcpUserDataDirArgs(options),
    ...options.extraArgs,
  ];
}

function drainStderr(transport: StdioClientTransport): () => string {
  const stream = transport.stderr;
  if (!stream) {
    return () => "";
  }
  const tail = createBoundedUtf8Tail(CHROME_MCP_STDERR_MAX_BYTES);
  stream.on("data", (chunk: Buffer | string) => {
    tail.append(chunk);
  });
  stream.on("error", () => {});
  return () => tail.text().trim();
}

function redactChromeMcpDiagnosticText(text: string): string {
  return redactCdpErrorText(text);
}

function redactChromeMcpDiagnosticTextWithLocalPaths(text: string): string {
  const homeDir = normalizeOptionalString(os.homedir());
  const homePath = homeDir ? path.resolve(homeDir) : undefined;
  const withHomeRedacted = homePath ? text.split(homePath).join("~") : text;
  return redactChromeMcpDiagnosticText(withHomeRedacted);
}

function redactChromeMcpLocalPathForDiagnostic(filePath: string): string {
  const homeDir = normalizeOptionalString(os.homedir());
  if (!homeDir || !path.isAbsolute(filePath)) {
    return redactChromeMcpDiagnosticText(filePath);
  }

  const relative = path.relative(path.resolve(homeDir), path.resolve(filePath));
  if (relative === "") {
    return "~";
  }
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return redactChromeMcpDiagnosticText(`~/${relative.split(path.sep).join("/")}`);
  }
  return redactChromeMcpDiagnosticText(filePath);
}

function redactChromeMcpProfileLabelForDiagnostic(profileName: string): string {
  return path.isAbsolute(profileName)
    ? redactChromeMcpLocalPathForDiagnostic(profileName)
    : redactChromeMcpDiagnosticText(profileName);
}

function readChromeMcpTransportPid(transport: StdioClientTransport): number | undefined {
  const pid = transport.pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid !== process.pid
    ? pid
    : undefined;
}

function parseChromeMcpProcessList(stdout: string): ChromeMcpProcessInfo[] {
  const processes: ChromeMcpProcessInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(?<pid>\d+)\s+(?<ppid>\d+)\s*$/.exec(line);
    if (!match?.groups) {
      continue;
    }
    processes.push({
      pid: Number.parseInt(match.groups.pid, 10),
      ppid: Number.parseInt(match.groups.ppid, 10),
    });
  }
  return processes;
}

async function listChromeMcpPlatformProcesses(
  deps: ChromeMcpProcessCleanupDeps | null,
): Promise<ChromeMcpProcessInfo[]> {
  if (deps?.listProcesses) {
    return await deps.listProcesses();
  }
  if ((deps?.platform ?? process.platform) === "win32") {
    return [];
  }
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid="], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return parseChromeMcpProcessList(stdout);
}

function collectChromeMcpProcessTreePids(
  rootPid: number,
  processes: ChromeMcpProcessInfo[],
): number[] {
  const childrenByParent = new Map<number, ChromeMcpProcessInfo[]>();
  for (const processInfo of processes) {
    const children = childrenByParent.get(processInfo.ppid) ?? [];
    children.push(processInfo);
    childrenByParent.set(processInfo.ppid, children);
  }

  const collected: number[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || next.pid === process.pid || next.pid === rootPid || collected.includes(next.pid)) {
      continue;
    }
    collected.push(next.pid);
    queue.push(...(childrenByParent.get(next.pid) ?? []));
  }
  return collected;
}

async function collectChromeMcpDescendantPids(
  rootPid: number,
  deps: ChromeMcpProcessCleanupDeps | null,
): Promise<number[]> {
  try {
    return collectChromeMcpProcessTreePids(rootPid, await listChromeMcpPlatformProcesses(deps));
  } catch (err) {
    log.trace(
      `Unable to inspect Chrome MCP subprocess tree for pid ${rootPid}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

function isChromeMcpProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function taskkillChromeMcpProcessTree(
  rootPid: number,
  deps: ChromeMcpProcessCleanupDeps | null,
): Promise<void> {
  if (deps?.taskkillProcessTree) {
    await deps.taskkillProcessTree(rootPid);
    return;
  }
  await execFileAsync("taskkill", ["/pid", String(rootPid), "/t", "/f"], {
    windowsHide: true,
  });
}

async function terminateChromeMcpProcessTree(
  rootPid: number | undefined,
  descendantPids: number[],
): Promise<void> {
  if (!rootPid) {
    return;
  }

  const deps = chromeMcpProcessCleanupDepsForTest;
  if ((deps?.platform ?? process.platform) === "win32") {
    await taskkillChromeMcpProcessTree(rootPid, deps);
    return;
  }

  const killProcess = deps?.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = deps?.sleep ?? sleepTimeout;
  const pids = uniqueValues([...descendantPids.toReversed(), rootPid]).filter(
    (pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid,
  );
  const signaled: number[] = [];

  for (const pid of pids) {
    try {
      killProcess(pid, "SIGTERM");
      signaled.push(pid);
    } catch {
      // The process may already have exited as part of client.close().
    }
  }
  if (signaled.length === 0) {
    return;
  }

  await sleep(CHROME_MCP_PROCESS_EXIT_GRACE_MS);
  for (const pid of signaled) {
    if (deps?.killProcess || isChromeMcpProcessAlive(pid)) {
      try {
        killProcess(pid, "SIGKILL");
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

async function closeChromeMcpClientAndProcess(params: {
  client: Client;
  transport: StdioClientTransport;
  ownsProcessTree?: boolean;
}): Promise<void> {
  const deps = chromeMcpProcessCleanupDepsForTest;
  const rootPid = params.ownsProcessTree ? readChromeMcpTransportPid(params.transport) : undefined;
  const descendantPids = rootPid ? await collectChromeMcpDescendantPids(rootPid, deps) : [];
  const terminateBeforeClientClose = Boolean(
    rootPid && (deps?.platform ?? process.platform) === "win32",
  );
  if (terminateBeforeClientClose) {
    try {
      await terminateChromeMcpProcessTree(rootPid, descendantPids);
    } catch (err) {
      log.trace(
        `Unable to pre-terminate Chrome MCP subprocess tree for pid ${rootPid}: ${err instanceof Error ? err.message : String(err)}`,
      );
      await params.client.close().catch(() => {});
    }
    return;
  }
  await params.client.close().catch(() => {});
  await terminateChromeMcpProcessTree(rootPid, descendantPids).catch((err: unknown) => {
    log.trace(
      `Unable to fully terminate Chrome MCP subprocess tree for pid ${rootPid}: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

async function closeChromeMcpSessionHandle(session: ChromeMcpSession): Promise<void> {
  await closeChromeMcpClientAndProcess({
    client: session.client,
    transport: session.transport,
    ownsProcessTree: session.ownsProcessTree,
  });
}

async function withChromeMcpHandshakeTimeout<T>(task: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Chrome MCP handshake timed out"));
        }, CHROME_MCP_HANDSHAKE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function createRealSession(
  profileName: string,
  options: NormalizedChromeMcpProfileOptions = normalizeChromeMcpOptions(),
): Promise<ChromeMcpSession> {
  const transport = new StdioClientTransport({
    command: options.command,
    args: buildChromeMcpArgsFromOptions(options),
    stderr: "pipe",
  });
  const client = new Client(
    {
      name: "openclaw-browser",
      version: "0.0.0",
    },
    {},
  );
  let getStderr = () => "";
  const ready = (async () => {
    try {
      await withChromeMcpHandshakeTimeout(
        (async () => {
          await client.connect(transport);
          getStderr = drainStderr(transport);
          const tools = await client.listTools();
          if (!tools.tools.some((tool) => tool.name === "list_pages")) {
            throw new Error("Chrome MCP server did not expose the expected navigation tools.");
          }
        })(),
      );
    } catch (err) {
      await closeChromeMcpClientAndProcess({ client, transport, ownsProcessTree: true });
      const stderr = getStderr();
      if (stderr) {
        log.warn(
          `Chrome MCP attach failed for profile "${redactChromeMcpProfileLabelForDiagnostic(profileName)}". Subprocess stderr:\n${redactChromeMcpDiagnosticTextWithLocalPaths(stderr)}`,
        );
      }
      const targetLabel = options.browserUrl
        ? `the configured Chrome endpoint (${redactToolPayloadText(redactCdpUrl(options.browserUrl) ?? options.browserUrl)})`
        : options.userDataDir
          ? `the configured Chromium user data dir (${redactChromeMcpLocalPathForDiagnostic(options.userDataDir)})`
          : "Google Chrome's default profile";
      const detail = redactChromeMcpDiagnosticTextWithLocalPaths(
        err instanceof Error ? err.message : String(err),
      );
      throw new BrowserProfileUnavailableError(
        `Chrome MCP existing-session attach failed for profile "${redactChromeMcpProfileLabelForDiagnostic(profileName)}". ` +
          `Make sure ${targetLabel} is running locally with remote debugging enabled. ` +
          `Details: ${detail}`,
      );
    }
  })();
  ready.catch(() => {});

  return {
    client,
    transport,
    ready,
    ownsProcessTree: true,
  };
}

async function waitForChromeMcpReady(
  session: ChromeMcpSession,
  profileName: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }
  if ((!timeoutMs || timeoutMs <= 0) && !signal) {
    await session.ready;
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const racers: Array<Promise<void> | Promise<never>> = [session.ready];
    if (timeoutMs && timeoutMs > 0) {
      racers.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new BrowserProfileUnavailableError(
                `Chrome MCP existing-session attach for profile "${redactChromeMcpProfileLabelForDiagnostic(profileName)}" timed out after ${timeoutMs}ms.`,
              ),
            );
          }, timeoutMs);
        }),
      );
    }
    if (signal) {
      racers.push(
        new Promise<never>((_, reject) => {
          abortListener = () =>
            reject(toLintErrorObject(signal.reason ?? new Error("aborted"), "Non-Error rejection"));
          signal.addEventListener("abort", abortListener, { once: true });
        }),
      );
    }
    await Promise.race(racers);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

async function waitForChromeMcpPendingSession(
  pending: Promise<ChromeMcpSession>,
  signal?: AbortSignal,
): Promise<ChromeMcpSession> {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }
  if (!signal) {
    return await pending;
  }

  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        abortListener = () =>
          reject(toLintErrorObject(signal.reason ?? new Error("aborted"), "Non-Error rejection"));
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

async function createChromeMcpSession(
  profileName: string,
  options: NormalizedChromeMcpProfileOptions,
  signal?: AbortSignal,
): Promise<ChromeMcpSession> {
  const created = (sessionFactory ?? createRealSession)(profileName, options);
  let closedAfterAbort = false;
  try {
    const session = await waitForChromeMcpPendingSession(created, signal);
    if (signal?.aborted) {
      closedAfterAbort = true;
      await closeChromeMcpSessionHandle(session);
      throw signal.reason ?? new Error("aborted");
    }
    return session;
  } catch (err) {
    if (signal?.aborted && !closedAfterAbort) {
      void created.then((session) => closeChromeMcpSessionHandle(session)).catch(() => {});
    }
    throw err;
  }
}

function abortPendingChromeMcpSession(
  pending: PendingChromeMcpSession,
  reason: unknown = new Error("Chrome MCP session attach no longer has active waiters"),
): void {
  if (!pending.state.settled && !pending.abortController.signal.aborted) {
    pending.abortController.abort(reason);
  }
}

function forgetCachedChromeMcpSessionIfCurrent(
  cacheKey: string,
  session: ChromeMcpSession,
): boolean {
  const current = sessions.get(cacheKey);
  if (current?.transport !== session.transport) {
    return false;
  }
  sessions.delete(cacheKey);
  return true;
}

function forgetPendingChromeMcpSessionIfCurrent(
  cacheKey: string,
  pending: PendingChromeMcpSession,
): boolean {
  if (pendingSessions.get(cacheKey) !== pending) {
    return false;
  }
  pendingSessions.delete(cacheKey);
  return true;
}

function createSharedPendingChromeMcpSession(
  cacheKey: string,
  profileName: string,
  options: NormalizedChromeMcpProfileOptions,
): PendingChromeMcpSession {
  const id = Symbol(cacheKey);
  const abortController = new AbortController();
  const state = {
    waiters: 0,
    settled: false,
  };
  const promise = (async () => {
    try {
      const created = await createChromeMcpSession(profileName, options, abortController.signal);
      if (pendingSessions.get(cacheKey)?.id === id) {
        sessions.set(cacheKey, created);
      } else {
        await closeChromeMcpSessionHandle(created);
      }
      return created;
    } finally {
      state.settled = true;
      if (state.waiters === 0 && pendingSessions.get(cacheKey)?.id === id) {
        pendingSessions.delete(cacheKey);
      }
    }
  })();
  const pending: PendingChromeMcpSession = {
    cacheKey,
    id,
    promise,
    abortController,
    state,
  };
  void promise.catch(() => {});
  return pending;
}

async function waitForSharedPendingChromeMcpSession(
  pending: PendingChromeMcpSession,
  signal?: AbortSignal,
): Promise<PendingChromeMcpSessionLease> {
  pending.state.waiters += 1;
  let released = false;
  let leasedSession: ChromeMcpSession | undefined;
  const release = async (closeIfLastWaiter: boolean) => {
    if (released) {
      return false;
    }
    released = true;
    pending.state.waiters = Math.max(0, pending.state.waiters - 1);
    if (pending.state.waiters !== 0) {
      return false;
    }
    if (pendingSessions.get(pending.cacheKey) === pending) {
      pendingSessions.delete(pending.cacheKey);
    }
    if (!pending.state.settled) {
      abortPendingChromeMcpSession(pending, signal?.reason);
    } else if (closeIfLastWaiter && leasedSession) {
      forgetCachedChromeMcpSessionIfCurrent(pending.cacheKey, leasedSession);
      await closeChromeMcpSessionHandle(leasedSession);
    }
    return true;
  };
  try {
    leasedSession = await waitForChromeMcpPendingSession(pending.promise, signal);
    return {
      session: leasedSession,
      release,
    };
  } catch (err) {
    await release(signal?.aborted === true);
    throw err;
  }
}

async function getSession(
  profileName: string,
  profileOptions?: ChromeMcpOptionsInput,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<ChromeMcpSession> {
  const options = normalizeChromeMcpOptions(profileOptions);
  const cacheKey = buildChromeMcpSessionCacheKey(profileName, options);
  await closeChromeMcpSessionsForProfile(profileName, cacheKey);
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }

  let staleReadySessionRetries = 0;
  for (;;) {
    let session = sessions.get(cacheKey);
    if (session && session.transport.pid === null) {
      sessions.delete(cacheKey);
      session = undefined;
    }

    let pendingLease: PendingChromeMcpSessionLease | undefined;
    let leasedPending: PendingChromeMcpSession | undefined;
    const pending = pendingSessions.get(cacheKey);
    if (pending) {
      leasedPending = pending;
      pendingLease = await waitForSharedPendingChromeMcpSession(pending, signal);
      session = pendingLease.session;
    }

    if (!session) {
      const createdPending = createSharedPendingChromeMcpSession(cacheKey, profileName, options);
      pendingSessions.set(cacheKey, createdPending);
      leasedPending = createdPending;
      pendingLease = await waitForSharedPendingChromeMcpSession(createdPending, signal);
      session = pendingLease.session;
    }

    try {
      await waitForChromeMcpReady(session, profileName, timeoutMs, signal);
      if (session.transport.pid === null) {
        forgetCachedChromeMcpSessionIfCurrent(cacheKey, session);
        if (leasedPending) {
          forgetPendingChromeMcpSessionIfCurrent(cacheKey, leasedPending);
        }
        if (pendingLease) {
          await pendingLease.release(true);
          pendingLease = undefined;
        }
        staleReadySessionRetries += 1;
        if (staleReadySessionRetries > 1) {
          throw new BrowserProfileUnavailableError(
            `Chrome MCP existing-session attach failed for profile "${redactChromeMcpProfileLabelForDiagnostic(profileName)}". ` +
              "The Chrome MCP subprocess exited before it became usable.",
          );
        }
        continue;
      }
      return session;
    } catch (err) {
      if (signal?.aborted && pendingLease) {
        await pendingLease.release(true);
        pendingLease = undefined;
      } else if (pendingLease && leasedPending && leasedPending.state.waiters > 1) {
        await pendingLease.release(false);
        pendingLease = undefined;
      } else {
        forgetCachedChromeMcpSessionIfCurrent(cacheKey, session);
        if (leasedPending) {
          forgetPendingChromeMcpSessionIfCurrent(cacheKey, leasedPending);
        }
        if (pendingLease) {
          await pendingLease.release(true);
          pendingLease = undefined;
        } else {
          await closeChromeMcpSessionHandle(session);
        }
      }
      throw err;
    } finally {
      await pendingLease?.release(false);
    }
  }
}

async function getExistingSession(
  cacheKey: string,
  profileName: string,
  timeoutMs?: number,
  signal?: AbortSignal,
  includePending = true,
): Promise<ChromeMcpSession | null> {
  if (!includePending && pendingSessions.has(cacheKey)) {
    return null;
  }

  let session = sessions.get(cacheKey);
  if (session && session.transport.pid === null) {
    sessions.delete(cacheKey);
    session = undefined;
  }

  const pending = pendingSessions.get(cacheKey);
  if (includePending && pending) {
    const pendingLease = await waitForSharedPendingChromeMcpSession(pending, signal);
    let pendingLeaseReleased = false;
    session = pendingLease.session;
    try {
      await waitForChromeMcpReady(session, profileName, timeoutMs, signal);
      if (session.transport.pid === null) {
        forgetCachedChromeMcpSessionIfCurrent(cacheKey, session);
        forgetPendingChromeMcpSessionIfCurrent(cacheKey, pending);
        await pendingLease.release(true);
        pendingLeaseReleased = true;
        return null;
      }
      return session;
    } catch (err) {
      if (signal?.aborted) {
        await pendingLease.release(true);
        pendingLeaseReleased = true;
      } else if (pending.state.waiters > 1) {
        await pendingLease.release(false);
        pendingLeaseReleased = true;
      } else {
        forgetCachedChromeMcpSessionIfCurrent(cacheKey, session);
        forgetPendingChromeMcpSessionIfCurrent(cacheKey, pending);
        await pendingLease.release(true);
        pendingLeaseReleased = true;
      }
      throw err;
    } finally {
      if (!pendingLeaseReleased) {
        await pendingLease.release(false);
      }
    }
  }

  if (session) {
    try {
      await waitForChromeMcpReady(session, profileName, timeoutMs, signal);
      return session;
    } catch (err) {
      forgetCachedChromeMcpSessionIfCurrent(cacheKey, session);
      throw err;
    }
  }

  return null;
}

async function createEphemeralSession(
  profileName: string,
  profileOptions?: ChromeMcpOptionsInput,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<ChromeMcpSession> {
  const options = normalizeChromeMcpOptions(profileOptions);
  const session = await createChromeMcpSession(profileName, options, signal);
  try {
    await waitForChromeMcpReady(session, profileName, timeoutMs, signal);
    return session;
  } catch (err) {
    await closeChromeMcpSessionHandle(session);
    throw err;
  }
}

async function leaseSession(
  profileName: string,
  profileOptions?: ChromeMcpOptionsInput,
  options: ChromeMcpCallOptions = {},
): Promise<ChromeMcpSessionLease> {
  const normalizedProfileOptions = normalizeChromeMcpOptions(profileOptions);
  const cacheKey = buildChromeMcpSessionCacheKey(profileName, normalizedProfileOptions);
  if (!options.ephemeral) {
    return {
      session: await getSession(
        profileName,
        normalizedProfileOptions,
        options.timeoutMs,
        options.signal,
      ),
      cacheKey,
      temporary: false,
    };
  }

  // Status probes should avoid seeding the shared attach session cache, but they can safely
  // reuse a real cached session if one already exists.
  const existingSession = await getExistingSession(
    cacheKey,
    profileName,
    options.timeoutMs,
    options.signal,
    false,
  );
  if (existingSession) {
    return {
      session: existingSession,
      cacheKey,
      temporary: false,
    };
  }

  return {
    session: await createEphemeralSession(
      profileName,
      normalizedProfileOptions,
      options.timeoutMs,
      options.signal,
    ),
    cacheKey,
    temporary: true,
  };
}

async function callTool(
  profileName: string,
  profileOptions: NormalizedChromeMcpProfileOptions,
  name: string,
  args: Record<string, unknown>,
  options: ChromeMcpCallOptions,
  lease: ChromeMcpSessionLease,
): Promise<ChromeMcpToolResult> {
  const timeoutMs = options.timeoutMs;
  const signal = options.signal;
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }
  // SDK-owned cancellation removes its request correlation entry. An outer race would return
  // early while leaving the underlying MCP request pending after a target-browser crash.
  const request = { name, arguments: args };
  const rawCall = (
    (timeoutMs !== undefined && timeoutMs > 0) || signal
      ? lease.session.client.callTool(request, undefined, {
          ...(timeoutMs !== undefined && timeoutMs > 0 ? { timeout: timeoutMs } : {}),
          ...(signal ? { signal } : {}),
        })
      : lease.session.client.callTool(request)
  ) as Promise<ChromeMcpToolResult>;

  let result: ChromeMcpToolResult;
  try {
    result = await rawCall;
  } catch (err) {
    // Transport/connection error, timeout, or abort: tear down the cached session.
    if (!lease.temporary) {
      const current = sessions.get(lease.cacheKey);
      if (current?.transport === lease.session.transport) {
        sessions.delete(lease.cacheKey);
        await closeChromeMcpSessionHandle(lease.session);
      }
    }
    if (signal?.aborted) {
      throw toLintErrorObject(signal.reason ?? err, "Non-Error abort reason");
    }
    if (timeoutMs && err instanceof McpError && err.code === MCP_REQUEST_TIMEOUT_CODE) {
      throw new Error(
        `Chrome MCP "${name}" timed out after ${timeoutMs}ms. Session reset for reconnect.`,
        { cause: err },
      );
    }
    throw err;
  }
  // Ordinary tool errors leave the session usable. A stale selected-page list
  // poisons it, so the outer pre-operation list may reconnect once.
  if (result.isError) {
    const message = extractToolErrorMessage(result, name);
    if (shouldReconnectForToolError(name, message)) {
      if (!lease.temporary) {
        const current = sessions.get(lease.cacheKey);
        if (current?.transport === lease.session.transport) {
          sessions.delete(lease.cacheKey);
          await closeChromeMcpSessionHandle(lease.session);
        }
      }
      throw new ChromeMcpReconnectRequiredError(message);
    }
    throw new Error(
      formatChromeMcpToolErrorMessage({
        profileName,
        options: profileOptions,
        toolName: name,
        message,
      }),
    );
  }
  return result;
}

async function callTargetTool(
  params: ChromeMcpTargetOperation,
  name: string,
  args: Record<string, unknown> | ((session: ChromeMcpSession) => Record<string, unknown>),
): Promise<ChromeMcpToolResult> {
  return await withChromeMcpTarget(params, async (target) => {
    const resolvedArgs = typeof args === "function" ? args(target.lease.session) : args;
    return await callTool(
      params.profileName,
      target.profileOptions,
      name,
      { ...resolvedArgs, pageId: target.pageId },
      params,
      target.lease,
    );
  });
}

type ChromeMcpPinnedTarget = {
  lease: ChromeMcpSessionLease;
  profileOptions: NormalizedChromeMcpProfileOptions;
  pageId: number;
};

async function withChromeMcpLease<T>(
  profileName: string,
  profileOptions: ChromeMcpOptionsInput | undefined,
  options: ChromeMcpCallOptions,
  operation: (
    lease: ChromeMcpSessionLease,
    normalizedProfileOptions: NormalizedChromeMcpProfileOptions,
  ) => Promise<T>,
): Promise<T> {
  const normalizedProfileOptions = normalizeChromeMcpOptions(profileOptions);
  const lease = await leaseSession(profileName, normalizedProfileOptions, options);
  try {
    return await withChromeMcpOperationLock(lease.session, options, async () => {
      if (!lease.temporary) {
        const current = sessions.get(lease.cacheKey);
        if (
          current?.transport !== lease.session.transport ||
          lease.session.transport.pid === null
        ) {
          forgetCachedChromeMcpSessionIfCurrent(lease.cacheKey, lease.session);
          throw new BrowserProfileUnavailableError(
            `Chrome MCP session for profile "${redactChromeMcpProfileLabelForDiagnostic(profileName)}" changed before the operation could start. Run the browser command again to reconnect.`,
          );
        }
      }
      return await operation(lease, normalizedProfileOptions);
    });
  } finally {
    if (lease.temporary) {
      await closeChromeMcpSessionHandle(lease.session);
    }
  }
}

async function listChromeMcpTargetsWithLease(params: {
  profileName: string;
  profileOptions: NormalizedChromeMcpProfileOptions;
  lease: ChromeMcpSessionLease;
  options: ChromeMcpCallOptions;
}): Promise<Array<{ page: ChromeMcpStructuredPage; targetId: string }>> {
  const result = await callTool(
    params.profileName,
    params.profileOptions,
    "list_pages",
    {},
    params.options,
    params.lease,
  );
  return registerChromeMcpTargets(params.lease.session, extractStructuredPages(result));
}

function registerChromeMcpTargets(
  session: ChromeMcpSession,
  pages: ChromeMcpStructuredPage[],
  options: { authoritative?: boolean } = {},
): Array<{ page: ChromeMcpStructuredPage; targetId: string }> {
  const routing = getChromeMcpRoutingState(session);
  const targetIdByPageId =
    options.authoritative === false ? new Map(routing.targetIdByPageId) : new Map<number, string>();
  const returnedPageIds = new Set<number>();
  const targets: Array<{ page: ChromeMcpStructuredPage; targetId: string }> = [];

  for (const page of pages) {
    if (returnedPageIds.has(page.id)) {
      throw new Error(`Chrome MCP returned duplicate numeric page id ${page.id}.`);
    }
    returnedPageIds.add(page.id);
    let targetId = routing.targetIdByPageId.get(page.id);
    if (!targetId) {
      targetId = `${CHROME_MCP_SESSION_TARGET_PREFIX}${routing.sessionNonce}:${routing.nextTargetHandleId}`;
      routing.nextTargetHandleId += 1;
    }
    targetIdByPageId.set(page.id, targetId);
    targets.push({ page, targetId });
  }
  updateChromeMcpTargetMappings(routing, targetIdByPageId);
  return targets;
}

async function withChromeMcpTarget<T>(
  params: ChromeMcpTargetOperation,
  operation: (target: ChromeMcpPinnedTarget) => Promise<T>,
): Promise<T> {
  const profileOptions = chromeMcpProfileOptionsFromParams(params);
  return await withChromeMcpLease(
    params.profileName,
    profileOptions,
    params,
    async (lease, normalizedProfileOptions) => {
      const routing = getChromeMcpRoutingState(lease.session);
      const pageId = [...routing.targetIdByPageId].find(
        ([, targetId]) => targetId === params.targetId,
      )?.[0];
      if (pageId === undefined) {
        throw new BrowserTabNotFoundError({ input: params.targetId });
      }
      return await operation({
        lease,
        profileOptions: normalizedProfileOptions,
        pageId,
      });
    },
  );
}

async function withTempFile<T>(fn: (filePath: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-chrome-mcp-"));
  const filePath = path.join(dir, randomUUID());
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Ensure a Chrome MCP session can be started for the profile. */
export async function ensureChromeMcpAvailable(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpCallOptions = {},
): Promise<void> {
  await withChromeMcpLease(profileName, profileOptions, options, async () => {});
}

/** Return the cached Chrome MCP process pid for a profile, when present. */
export function getChromeMcpPid(profileName: string): number | null {
  for (const [key, session] of sessions.entries()) {
    if (cacheKeyMatchesProfileName(key, profileName)) {
      return session.transport.pid ?? null;
    }
  }
  return null;
}

/** Close cached Chrome MCP sessions for one profile. */
export async function closeChromeMcpSession(profileName: string): Promise<boolean> {
  return await closeChromeMcpSessionsForProfile(profileName);
}

/** Close every cached Chrome MCP session. */
async function stopAllChromeMcpSessions(): Promise<void> {
  const names = uniqueStrings([...sessions.keys()].map((key) => JSON.parse(key)[0] as string));
  for (const name of names) {
    await closeChromeMcpSession(name).catch(() => {});
  }
}

async function readChromeMcpTabs(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpCallOptions = {},
): Promise<BrowserTab[]> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await withChromeMcpLease(
        profileName,
        profileOptions,
        options,
        async (lease, normalizedProfileOptions) =>
          (
            await listChromeMcpTargetsWithLease({
              profileName,
              profileOptions: normalizedProfileOptions,
              lease,
              options,
            })
          ).map(({ page, targetId }) => ({
            targetId,
            title: "",
            url: page.url ?? "",
            type: "page",
          })),
      );
    } catch (err) {
      if (err instanceof ChromeMcpReconnectRequiredError && attempt === 0) {
        continue;
      }
      throw err;
    }
  }
  return [];
}

/** List Chrome MCP pages converted to persistent BrowserTab handles. */
export async function listChromeMcpTabs(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpOperationOptions = {},
): Promise<BrowserTab[]> {
  return await readChromeMcpTabs(profileName, profileOptions, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
}

/** Count Chrome MCP pages without returning handles from an ephemeral session. */
export async function countChromeMcpTabs(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpCallOptions = {},
): Promise<number> {
  return (await readChromeMcpTabs(profileName, profileOptions, options)).length;
}

/** Open a new Chrome MCP tab and navigate it to the requested URL. */
export async function openChromeMcpTab(
  profileName: string,
  url: string,
  profileOptions?: string | ChromeMcpProfileOptions,
): Promise<BrowserTab> {
  const targetUrl = url.trim() || "about:blank";
  return await withChromeMcpLease(
    profileName,
    profileOptions,
    {},
    async (lease, normalizedProfileOptions) => {
      const result = await callTool(
        profileName,
        normalizedProfileOptions,
        "new_page",
        { url: "about:blank", timeout: CHROME_MCP_NEW_PAGE_TIMEOUT_MS },
        {},
        lease,
      );
      // new_page may return only its created page. Merge that partial response;
      // only list_pages may prune unrelated live target and ref mappings.
      const createdPages = registerChromeMcpTargets(lease.session, extractStructuredPages(result), {
        authoritative: false,
      });
      const created = createdPages.find(({ page }) => page.selected) ?? createdPages.at(-1);
      if (!created) {
        throw new Error("Chrome MCP did not return the created page.");
      }
      if (targetUrl === "about:blank") {
        return {
          targetId: created.targetId,
          title: "",
          url: created.page.url ?? targetUrl,
          type: "page",
        };
      }
      const navigateCallTimeoutMs = resolveChromeMcpNavigateCallTimeoutMs(
        CHROME_MCP_NAVIGATE_TIMEOUT_MS,
      );
      await callTool(
        profileName,
        normalizedProfileOptions,
        "navigate_page",
        {
          pageId: created.page.id,
          type: "url",
          url: targetUrl,
          timeout: CHROME_MCP_NAVIGATE_TIMEOUT_MS,
        },
        { timeoutMs: navigateCallTimeoutMs },
        lease,
      );
      const verified = await listChromeMcpTargetsWithLease({
        profileName,
        profileOptions: normalizedProfileOptions,
        lease,
        options: { timeoutMs: navigateCallTimeoutMs },
      });
      const finalPage = verified.find((entry) => entry.targetId === created.targetId);
      if (!finalPage) {
        throw new Error("Chrome MCP created page identity changed before navigation completed.");
      }
      return {
        targetId: created.targetId,
        title: "",
        url: finalPage.page.url ?? targetUrl,
        type: "page",
      };
    },
  );
}

/** Bring a Chrome MCP page to the foreground. */
export async function focusChromeMcpTab(
  profileName: string,
  targetId: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpOperationOptions = {},
): Promise<void> {
  await callTargetTool(
    {
      profileName,
      profile: typeof profileOptions === "string" ? undefined : profileOptions,
      userDataDir: typeof profileOptions === "string" ? profileOptions : undefined,
      targetId,
      ...options,
    },
    "select_page",
    { bringToFront: true },
  );
}

/** Close a Chrome MCP page by target id. */
export async function closeChromeMcpTab(
  profileName: string,
  targetId: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpOperationOptions = {},
): Promise<void> {
  const profile = typeof profileOptions === "string" ? undefined : profileOptions;
  const userDataDir = typeof profileOptions === "string" ? profileOptions : undefined;
  await withChromeMcpTarget(
    {
      profileName,
      profile,
      userDataDir,
      targetId,
      ...options,
    },
    async (target) => {
      await callTool(
        profileName,
        target.profileOptions,
        "close_page",
        { pageId: target.pageId },
        options,
        target.lease,
      );
      // Retire inside the same operation lock so queued work cannot dispatch
      // against a closed page id. A later list gets a new opaque handle even if
      // Chrome reuses that numeric id.
      const routing = getChromeMcpRoutingState(target.lease.session);
      routing.targetIdByPageId.delete(target.pageId);
      clearChromeMcpSnapshotRefsForTarget(routing, targetId);
    },
  );
}

/** Navigate a Chrome MCP page and return its resolved URL. */
export async function navigateChromeMcpPage(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  url: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ url: string }> {
  const resolvedTimeoutMs = params.timeoutMs ?? CHROME_MCP_NAVIGATE_TIMEOUT_MS;
  const callTimeoutMs = resolveChromeMcpNavigateCallTimeoutMs(resolvedTimeoutMs);
  return await withChromeMcpTarget({ ...params, timeoutMs: callTimeoutMs }, async (target) => {
    await callTool(
      params.profileName,
      target.profileOptions,
      "navigate_page",
      {
        pageId: target.pageId,
        type: "url",
        url: params.url,
        timeout: resolvedTimeoutMs,
      },
      { timeoutMs: callTimeoutMs, signal: params.signal },
      target.lease,
    );
    const pages = await listChromeMcpTargetsWithLease({
      profileName: params.profileName,
      profileOptions: target.profileOptions,
      lease: target.lease,
      options: { timeoutMs: callTimeoutMs, signal: params.signal },
    });
    const page = pages.find((entry) => entry.targetId === params.targetId)?.page;
    if (!page) {
      throw new Error(
        "Chrome MCP tab identity changed while navigation was running; the navigation outcome is unknown.",
      );
    }
    return { url: page.url ?? params.url };
  });
}

/** Add call-level grace around the MCP navigate timeout. */
export function resolveChromeMcpNavigateCallTimeoutMs(timeoutMs: number): number {
  return addTimerTimeoutGraceMs(timeoutMs) ?? 1;
}

/** Take a structured Chrome MCP snapshot for one page. */
export async function takeChromeMcpSnapshot(
  params: ChromeMcpTargetOperation,
): Promise<ChromeMcpSnapshotNode> {
  return await withChromeMcpTarget(params, async (target) => {
    const result = await callTool(
      params.profileName,
      target.profileOptions,
      "take_snapshot",
      { pageId: target.pageId },
      params,
      target.lease,
    );
    return wrapChromeMcpSnapshotRefs(
      target.lease.session,
      params.targetId,
      extractSnapshot(result),
    );
  });
}

/** Take a screenshot via Chrome MCP and return the image bytes. */
export async function takeChromeMcpScreenshot(
  params: ChromeMcpTargetOperation & {
    uid?: string;
    fullPage?: boolean;
    format?: "png" | "jpeg";
  },
): Promise<Buffer> {
  return await withTempFile(async (filePath) => {
    const format = params.format ?? "png";
    await callTargetTool(params, "take_screenshot", (session) => ({
      filePath,
      format,
      ...(params.uid
        ? { uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.uid) }
        : {}),
      ...(params.fullPage ? { fullPage: true } : {}),
    }));
    return await fs.readFile(`${filePath}.${format}`);
  });
}

/** Click a Chrome MCP snapshot element by uid. */
export async function clickChromeMcpElement(
  params: ChromeMcpTargetOperation & {
    uid: string;
    doubleClick?: boolean;
  },
): Promise<void> {
  await callTargetTool(params, "click", (session) => ({
    uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.uid),
    ...(params.doubleClick ? { dblClick: true } : {}),
  }));
}

/** Dispatch mouse events at page coordinates through an in-page script. */
export async function clickChromeMcpCoords(
  params: ChromeMcpTargetOperation & {
    x: number;
    y: number;
    doubleClick?: boolean;
    button?: "left" | "right" | "middle";
    delayMs?: number;
  },
): Promise<void> {
  const button = params.button ?? "left";
  const buttonCode = button === "middle" ? 1 : button === "right" ? 2 : 0;
  const pressedButtons = button === "middle" ? 4 : button === "right" ? 2 : 1;
  const x = JSON.stringify(params.x);
  const y = JSON.stringify(params.y);
  const delayMs = JSON.stringify(resolveNonNegativeIntegerOption(params.delayMs, 0));
  const doubleClick = params.doubleClick ? "true" : "false";
  await evaluateChromeMcpScript({
    ...params,
    fn: `async () => {
      const x = ${x};
      const y = ${y};
      const delayMs = ${delayMs};
      const doubleClick = ${doubleClick};
      const target = document.elementFromPoint(x, y) ?? document.body ?? document.documentElement ?? document;
      const base = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        screenX: window.screenX + x,
        screenY: window.screenY + y,
        button: ${buttonCode},
      };
      const pressedButtons = ${pressedButtons};
      const dispatch = (type, buttons, detail) => {
        target.dispatchEvent(new MouseEvent(type, { ...base, buttons, detail }));
      };
      dispatch("mousemove", 0, 0);
      dispatch("mousedown", pressedButtons, 1);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      dispatch("mouseup", 0, 1);
      dispatch("click", 0, 1);
      if (doubleClick) {
        dispatch("mousedown", pressedButtons, 2);
        dispatch("mouseup", 0, 2);
        dispatch("click", 0, 2);
        dispatch("dblclick", 0, 2);
      }
      return true;
    }`,
  });
}

/** Fill one Chrome MCP element by uid. */
export async function fillChromeMcpElement(
  params: ChromeMcpTargetOperation & { uid: string; value: string },
): Promise<void> {
  await callTargetTool(params, "fill", (session) => ({
    uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.uid),
    value: params.value,
  }));
}

/** Fill multiple Chrome MCP form elements in one tool call. */
export async function fillChromeMcpForm(
  params: ChromeMcpTargetOperation & {
    elements: Array<{ uid: string; value: string }>;
  },
): Promise<void> {
  await callTargetTool(params, "fill_form", (session) => ({
    elements: params.elements.map((element) => ({
      ...element,
      uid: resolveChromeMcpSnapshotRef(session, params.targetId, element.uid),
    })),
  }));
}

/** Hover a Chrome MCP snapshot element by uid. */
export async function hoverChromeMcpElement(
  params: ChromeMcpTargetOperation & { uid: string },
): Promise<void> {
  await callTargetTool(params, "hover", (session) => ({
    uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.uid),
  }));
}

/** Drag between two Chrome MCP snapshot element uids. */
export async function dragChromeMcpElement(
  params: ChromeMcpTargetOperation & { fromUid: string; toUid: string },
): Promise<void> {
  await callTargetTool(params, "drag", (session) => ({
    from_uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.fromUid),
    to_uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.toUid),
  }));
}

/** Upload a local file into a Chrome MCP file input by uid. */
export async function uploadChromeMcpFile(
  params: ChromeMcpTargetOperation & { uid: string; filePath: string },
): Promise<void> {
  await callTargetTool(params, "upload_file", (session) => ({
    uid: resolveChromeMcpSnapshotRef(session, params.targetId, params.uid),
    filePath: params.filePath,
  }));
}

/** Press a keyboard key in a Chrome MCP page. */
export async function pressChromeMcpKey(
  params: ChromeMcpTargetOperation & { key: string },
): Promise<void> {
  await callTargetTool(params, "press_key", {
    key: params.key,
  });
}

/** Resize a Chrome MCP page viewport. */
export async function resizeChromeMcpPage(
  params: ChromeMcpTargetOperation & { width: number; height: number },
): Promise<void> {
  await callTargetTool(params, "resize_page", {
    width: params.width,
    height: params.height,
  });
}

/** Evaluate a JavaScript function in a Chrome MCP page. */
export async function evaluateChromeMcpScript(
  params: ChromeMcpTargetOperation & { fn: string; args?: string[] },
): Promise<unknown> {
  const result = await callTargetTool(params, "evaluate_script", (session) => ({
    function: params.fn,
    ...(params.args?.length
      ? {
          args: params.args.map((ref) =>
            resolveChromeMcpSnapshotRef(session, params.targetId, ref),
          ),
        }
      : {}),
  }));
  return extractJsonMessage(result);
}

/** Replace Chrome MCP session creation for focused tests. */
export function setChromeMcpSessionFactoryForTest(factory: ChromeMcpSessionFactory | null): void {
  sessionFactory = factory;
}

/** Replace process cleanup hooks for focused tests. */
export function setChromeMcpProcessCleanupDepsForTest(
  deps: ChromeMcpProcessCleanupDeps | null,
): void {
  chromeMcpProcessCleanupDepsForTest = deps;
}

/** Reset cached sessions and test hooks. */
export async function resetChromeMcpSessionsForTest(): Promise<void> {
  sessionFactory = null;
  for (const pending of pendingSessions.values()) {
    abortPendingChromeMcpSession(pending, new Error("Chrome MCP sessions reset for test"));
  }
  pendingSessions.clear();
  await stopAllChromeMcpSessions();
  chromeMcpProcessCleanupDepsForTest = null;
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
