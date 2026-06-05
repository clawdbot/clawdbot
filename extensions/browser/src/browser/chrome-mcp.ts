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
import {
  addTimerTimeoutGraceMs,
  parseStrictPositiveInteger,
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
import { redactCdpUrl } from "./cdp.helpers.js";
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
};

type ChromeMcpCallOptions = {
  ephemeral?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};

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
export type ChromeMcpProcessInfo = {
  pid: number;
  ppid: number;
};

/** Injectable process cleanup dependencies for platform-specific tests. */
export type ChromeMcpProcessCleanupDeps = {
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
const CDP_URL_IN_TEXT_RE = /\b(?:https?|wss?):\/\/[^\s"'<>`]+/gi;
const STALE_SELECTED_PAGE_ERROR =
  "The selected page has been closed. Call list_pages to see open pages.";

const execFileAsync = promisify(execFile);
const sessions = new Map<string, ChromeMcpSession>();
const pendingSessions = new Map<string, PendingChromeMcpSession>();
let sessionFactory: ChromeMcpSessionFactory | null = null;
let chromeMcpProcessCleanupDepsForTest: ChromeMcpProcessCleanupDeps | null = null;

/** Decode a bounded UTF-8-safe stderr tail for Chrome MCP diagnostics. */
export function decodeChromeMcpStderrTail(buffer: Buffer): string {
  if (buffer.length <= CHROME_MCP_STDERR_MAX_BYTES) {
    return buffer.toString("utf8").trim();
  }

  let start = buffer.length - CHROME_MCP_STDERR_MAX_BYTES;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start++;
  }
  return buffer.subarray(start).toString("utf8").trim();
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

function parsePageId(targetId: string): number {
  const parsed = parseStrictPositiveInteger(targetId);
  if (parsed === undefined) {
    throw new BrowserTabNotFoundError();
  }
  return parsed;
}

function toBrowserTabs(pages: ChromeMcpStructuredPage[]): BrowserTab[] {
  return pages.map((page) => ({
    targetId: String(page.id),
    title: "",
    url: page.url ?? "",
    type: "page",
  }));
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

/** Build command-line args for launching chrome-devtools-mcp. */
export function buildChromeMcpArgs(input?: string | ChromeMcpProfileOptions): string[] {
  return buildChromeMcpArgsFromOptions(normalizeChromeMcpOptions(input));
}

function drainStderr(transport: StdioClientTransport): () => string {
  const stream = transport.stderr;
  if (!stream) {
    return () => "";
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  stream.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const capped =
      buffer.length > CHROME_MCP_STDERR_MAX_BYTES
        ? buffer.subarray(buffer.length - CHROME_MCP_STDERR_MAX_BYTES)
        : buffer;
    chunks.push(capped);
    totalBytes += capped.length;
    while (totalBytes > CHROME_MCP_STDERR_MAX_BYTES && chunks.length > 1) {
      const dropped = chunks.shift();
      if (dropped) {
        totalBytes -= dropped.length;
      }
    }
  });
  stream.on("error", () => {});
  return () => decodeChromeMcpStderrTail(Buffer.concat(chunks));
}

function redactChromeMcpDiagnosticText(text: string): string {
  return redactToolPayloadText(
    text.replace(CDP_URL_IN_TEXT_RE, (match) =>
      redactToolPayloadText(redactCdpUrl(match) ?? match),
    ),
  );
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
  profileOptions: ChromeMcpOptionsInput | undefined,
  name: string,
  args: Record<string, unknown> = {},
  options: ChromeMcpCallOptions = {},
): Promise<ChromeMcpToolResult> {
  const timeoutMs = options.timeoutMs;
  const signal = options.signal;
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lease = await leaseSession(profileName, profileOptions, options);
    const rawCall = lease.session.client.callTool({
      name,
      arguments: args,
    }) as Promise<ChromeMcpToolResult>;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const racers: Array<Promise<ChromeMcpToolResult> | Promise<never>> = [rawCall];

    if (timeoutMs !== undefined && timeoutMs > 0) {
      racers.push(
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(
              new Error(
                `Chrome MCP "${name}" timed out after ${timeoutMs}ms. Session reset for reconnect.`,
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

    let result: ChromeMcpToolResult;
    try {
      result = racers.length === 1 ? await rawCall : await Promise.race(racers);
    } catch (err) {
      void rawCall.catch(() => {});
      // Transport/connection error, timeout, or abort: tear down session so it reconnects.
      // Transport-identity check prevents clobbering a replacement session created concurrently.
      if (!lease.temporary) {
        const cur = sessions.get(lease.cacheKey);
        if (cur?.transport === lease.session.transport) {
          sessions.delete(lease.cacheKey);
          await closeChromeMcpSessionHandle(lease.session);
        }
      }
      throw err;
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      if (lease.temporary) {
        await closeChromeMcpSessionHandle(lease.session);
      }
    }
    // Tool-level errors (element not found, script error, etc.) don't indicate a
    // broken connection. A stale selected-page error does poison the Chrome MCP
    // session, so reconnect and retry that one once.
    if (result.isError) {
      const message = extractToolErrorMessage(result, name);
      if (shouldReconnectForToolError(name, message)) {
        if (!lease.temporary) {
          const cur = sessions.get(lease.cacheKey);
          if (cur?.transport === lease.session.transport) {
            sessions.delete(lease.cacheKey);
            await closeChromeMcpSessionHandle(lease.session);
          }
        }
        if (attempt === 0) {
          continue;
        }
      }
      throw new Error(message);
    }
    return result;
  }
  throw new Error(`Chrome MCP tool "${name}" failed after reconnect.`);
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

async function findPageById(
  profileName: string,
  pageId: number,
  profileOptions?: string | ChromeMcpProfileOptions,
): Promise<ChromeMcpStructuredPage> {
  const pages = await listChromeMcpPages(profileName, profileOptions);
  const page = pages.find((entry) => entry.id === pageId);
  if (!page) {
    throw new BrowserTabNotFoundError();
  }
  return page;
}

/** Ensure a Chrome MCP session can be started for the profile. */
export async function ensureChromeMcpAvailable(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpCallOptions = {},
): Promise<void> {
  const lease = await leaseSession(profileName, profileOptions, options);
  if (lease.temporary) {
    await closeChromeMcpSessionHandle(lease.session);
  }
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
export async function stopAllChromeMcpSessions(): Promise<void> {
  const names = uniqueStrings([...sessions.keys()].map((key) => JSON.parse(key)[0] as string));
  for (const name of names) {
    await closeChromeMcpSession(name).catch(() => {});
  }
}

/** List raw Chrome MCP pages for a profile. */
export async function listChromeMcpPages(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpCallOptions = {},
): Promise<ChromeMcpStructuredPage[]> {
  const result = await callTool(profileName, profileOptions, "list_pages", {}, options);
  return extractStructuredPages(result);
}

/** List Chrome MCP pages converted to BrowserTab records. */
export async function listChromeMcpTabs(
  profileName: string,
  profileOptions?: string | ChromeMcpProfileOptions,
  options: ChromeMcpCallOptions = {},
): Promise<BrowserTab[]> {
  return toBrowserTabs(await listChromeMcpPages(profileName, profileOptions, options));
}

/** Open a new Chrome MCP tab and navigate it to the requested URL. */
export async function openChromeMcpTab(
  profileName: string,
  url: string,
  profileOptions?: string | ChromeMcpProfileOptions,
): Promise<BrowserTab> {
  const targetUrl = url.trim() || "about:blank";
  const result = await callTool(profileName, profileOptions, "new_page", {
    url: "about:blank",
    timeout: CHROME_MCP_NEW_PAGE_TIMEOUT_MS,
  });
  const pages = extractStructuredPages(result);
  const chosen = pages.find((page) => page.selected) ?? pages.at(-1);
  if (!chosen) {
    throw new Error("Chrome MCP did not return the created page.");
  }
  const targetId = String(chosen.id);
  const finalUrl =
    targetUrl === "about:blank"
      ? (chosen.url ?? targetUrl)
      : (
          await navigateChromeMcpPage({
            profileName,
            profile: typeof profileOptions === "string" ? undefined : profileOptions,
            userDataDir: typeof profileOptions === "string" ? profileOptions : undefined,
            targetId,
            url: targetUrl,
            timeoutMs: CHROME_MCP_NAVIGATE_TIMEOUT_MS,
          })
        ).url;
  return {
    targetId,
    title: "",
    url: finalUrl,
    type: "page",
  };
}

/** Bring a Chrome MCP page to the foreground. */
export async function focusChromeMcpTab(
  profileName: string,
  targetId: string,
  profileOptions?: string | ChromeMcpProfileOptions,
): Promise<void> {
  await callTool(profileName, profileOptions, "select_page", {
    pageId: parsePageId(targetId),
    bringToFront: true,
  });
}

/** Close a Chrome MCP page by target id. */
export async function closeChromeMcpTab(
  profileName: string,
  targetId: string,
  profileOptions?: string | ChromeMcpProfileOptions,
): Promise<void> {
  await callTool(profileName, profileOptions, "close_page", { pageId: parsePageId(targetId) });
}

/** Navigate a Chrome MCP page and return its resolved URL. */
export async function navigateChromeMcpPage(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  url: string;
  timeoutMs?: number;
}): Promise<{ url: string }> {
  const resolvedTimeoutMs = params.timeoutMs ?? CHROME_MCP_NAVIGATE_TIMEOUT_MS;
  const callTimeoutMs = resolveChromeMcpNavigateCallTimeoutMs(resolvedTimeoutMs);
  await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "navigate_page",
    {
      pageId: parsePageId(params.targetId),
      type: "url",
      url: params.url,
      timeout: resolvedTimeoutMs,
    },
    { timeoutMs: callTimeoutMs },
  );
  const page = await findPageById(
    params.profileName,
    parsePageId(params.targetId),
    chromeMcpProfileOptionsFromParams(params),
  );
  return { url: page.url ?? params.url };
}

/** Add call-level grace around the MCP navigate timeout. */
export function resolveChromeMcpNavigateCallTimeoutMs(timeoutMs: number): number {
  return addTimerTimeoutGraceMs(timeoutMs) ?? 1;
}

/** Take a structured Chrome MCP snapshot for one page. */
export async function takeChromeMcpSnapshot(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  timeoutMs?: number;
}): Promise<ChromeMcpSnapshotNode> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "take_snapshot",
    {
      pageId: parsePageId(params.targetId),
    },
    { timeoutMs: params.timeoutMs },
  );
  return extractSnapshot(result);
}

/** Take a screenshot via Chrome MCP and return the image bytes. */
export async function takeChromeMcpScreenshot(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  uid?: string;
  fullPage?: boolean;
  format?: "png" | "jpeg";
  timeoutMs?: number;
}): Promise<Buffer> {
  return await withTempFile(async (filePath) => {
    const format = params.format ?? "png";
    await callTool(
      params.profileName,
      chromeMcpProfileOptionsFromParams(params),
      "take_screenshot",
      {
        pageId: parsePageId(params.targetId),
        filePath,
        format,
        ...(params.uid ? { uid: params.uid } : {}),
        ...(params.fullPage ? { fullPage: true } : {}),
      },
      { timeoutMs: params.timeoutMs },
    );
    return await fs.readFile(`${filePath}.${format}`);
  });
}

/** Click a Chrome MCP snapshot element by uid. */
export async function clickChromeMcpElement(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  uid: string;
  doubleClick?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "click",
    {
      pageId: parsePageId(params.targetId),
      uid: params.uid,
      ...(params.doubleClick ? { dblClick: true } : {}),
    },
    {
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    },
  );
}

/** Dispatch mouse events at page coordinates through an in-page script. */
export async function clickChromeMcpCoords(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  x: number;
  y: number;
  doubleClick?: boolean;
  button?: "left" | "right" | "middle";
  delayMs?: number;
}): Promise<void> {
  const button = params.button ?? "left";
  const buttonCode = button === "middle" ? 1 : button === "right" ? 2 : 0;
  const pressedButtons = button === "middle" ? 4 : button === "right" ? 2 : 1;
  const x = JSON.stringify(params.x);
  const y = JSON.stringify(params.y);
  const delayMs = JSON.stringify(resolveNonNegativeIntegerOption(params.delayMs, 0));
  const doubleClick = params.doubleClick ? "true" : "false";
  await evaluateChromeMcpScript({
    profileName: params.profileName,
    profile: params.profile,
    userDataDir: params.userDataDir,
    targetId: params.targetId,
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
export async function fillChromeMcpElement(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  uid: string;
  value: string;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "fill", {
    pageId: parsePageId(params.targetId),
    uid: params.uid,
    value: params.value,
  });
}

/** Fill multiple Chrome MCP form elements in one tool call. */
export async function fillChromeMcpForm(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  elements: Array<{ uid: string; value: string }>;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "fill_form", {
    pageId: parsePageId(params.targetId),
    elements: params.elements,
  });
}

/** Hover a Chrome MCP snapshot element by uid. */
export async function hoverChromeMcpElement(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  uid: string;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "hover", {
    pageId: parsePageId(params.targetId),
    uid: params.uid,
  });
}

/** Drag between two Chrome MCP snapshot element uids. */
export async function dragChromeMcpElement(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  fromUid: string;
  toUid: string;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "drag", {
    pageId: parsePageId(params.targetId),
    from_uid: params.fromUid,
    to_uid: params.toUid,
  });
}

/** Upload a local file into a Chrome MCP file input by uid. */
export async function uploadChromeMcpFile(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  uid: string;
  filePath: string;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "upload_file", {
    pageId: parsePageId(params.targetId),
    uid: params.uid,
    filePath: params.filePath,
  });
}

/** Press a keyboard key in a Chrome MCP page. */
export async function pressChromeMcpKey(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  key: string;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "press_key", {
    pageId: parsePageId(params.targetId),
    key: params.key,
  });
}

/** Resize a Chrome MCP page viewport. */
export async function resizeChromeMcpPage(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  width: number;
  height: number;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "resize_page", {
    pageId: parsePageId(params.targetId),
    width: params.width,
    height: params.height,
  });
}

/** Accept or dismiss a Chrome MCP browser dialog. */
export async function handleChromeMcpDialog(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  action: "accept" | "dismiss";
  promptText?: string;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "handle_dialog", {
    pageId: parsePageId(params.targetId),
    action: params.action,
    ...(params.promptText ? { promptText: params.promptText } : {}),
  });
}

/** Evaluate a JavaScript function in a Chrome MCP page. */
export async function evaluateChromeMcpScript(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  fn: string;
  args?: string[];
}): Promise<unknown> {
  const result = await callTool(
    params.profileName,
    chromeMcpProfileOptionsFromParams(params),
    "evaluate_script",
    {
      pageId: parsePageId(params.targetId),
      function: params.fn,
      ...(params.args?.length ? { args: params.args } : {}),
    },
  );
  return extractJsonMessage(result);
}

/** Wait for text conditions in a Chrome MCP page. */
export async function waitForChromeMcpText(params: {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
  text: string[];
  timeoutMs?: number;
}): Promise<void> {
  await callTool(params.profileName, chromeMcpProfileOptionsFromParams(params), "wait_for", {
    pageId: parsePageId(params.targetId),
    text: params.text,
    ...(typeof params.timeoutMs === "number" ? { timeout: params.timeoutMs } : {}),
  });
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
