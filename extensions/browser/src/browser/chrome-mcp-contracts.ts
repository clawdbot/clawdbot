// Shared Chrome MCP contracts and constants.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { createAsyncLock } from "openclaw/plugin-sdk/async-lock-runtime";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import type { CdpActionTimeouts } from "./cdp.js";

export type ChromeMcpStructuredPage = {
  id: number;
  url?: string;
  selected?: boolean;
};

export type ChromeMcpToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
};

export type ChromeMcpSession = {
  client: Client;
  transport: StdioClientTransport;
  ready: Promise<void>;
  processCleanup?: ChromeMcpProcessCleanupState;
  processCleanupRefresh?: Promise<void>;
  routing?: ChromeMcpRoutingState;
};

export type ChromeMcpRoutingState = {
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

export type ChromeMcpOpenOptions = ChromeMcpOperationOptions & {
  cdpPolicy?: SsrFPolicy;
  cdpTimeouts?: CdpActionTimeouts;
};

export type ChromeMcpTargetOperation = ChromeMcpOperationOptions & {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
};

export class ChromeMcpDocumentUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChromeMcpDocumentUnavailableError";
  }
}

export function rethrowChromeMcpDocumentError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /Element (?:with )?uid .* (?:not found|no longer exists) on (?:the )?page|Execution context was destroyed|Cannot find context with specified id|Frame (?:was |is )?detached|detached Frame|Node is detached from document/i.test(
      message,
    )
  ) {
    throw new ChromeMcpDocumentUnavailableError(message, { cause: error });
  }
  throw error;
}

export type ChromeMcpCallOptions = ChromeMcpOperationOptions & {
  ephemeral?: boolean;
};

export const MCP_REQUEST_TIMEOUT_CODE: number = ErrorCode.RequestTimeout;

/** Browser profile options used to connect or launch chrome-devtools-mcp. */
export type ChromeMcpProfileOptions = {
  userDataDir?: string;
  cdpUrl?: string;
  mcpCommand?: string;
  mcpArgs?: string[];
};

export type NormalizedChromeMcpProfileOptions = {
  userDataDir?: string;
  browserUrl?: string;
  command: string;
  extraArgs: string[];
};
export type ChromeMcpOptionsInput =
  | string
  | ChromeMcpProfileOptions
  | NormalizedChromeMcpProfileOptions;

export type ChromeMcpSessionLease = {
  session: ChromeMcpSession;
  cacheKey: string;
  temporary: boolean;
};

export type ChromeMcpSessionFactory = (
  profileName: string,
  options?: NormalizedChromeMcpProfileOptions,
) => Promise<ChromeMcpSession>;

export type PendingChromeMcpSession = {
  cacheKey: string;
  id: symbol;
  promise: Promise<ChromeMcpSession>;
  cleanup: Promise<void>;
  abortController: AbortController;
  state: {
    waiters: number;
    settled: boolean;
    session?: ChromeMcpSession;
    cancelled: boolean;
    cleanupSettled: boolean;
  };
};

export type PendingChromeMcpSessionLease = {
  session: ChromeMcpSession;
  release: (closeIfLastWaiter: boolean) => Promise<boolean>;
};

/** One OS snapshot row: ancestry and immutable birth identity from the same read. */
export type ChromeMcpProcessSnapshot = {
  pid: number;
  ppid: number;
  identity: string;
};

/** Injectable process cleanup dependencies for platform-specific tests. */
export type ChromeMcpProcessCleanupDeps = {
  listProcesses?: () => Promise<ChromeMcpProcessSnapshot[]>;
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
  taskkillProcessTree?: (pid: number) => Promise<void>;
};

export type ChromeMcpOwnedProcess = {
  pid: number;
  identity: string;
};

export type ChromeMcpProcessCleanupTarget = {
  root: ChromeMcpOwnedProcess;
  descendants: ChromeMcpOwnedProcess[];
};

export type ChromeMcpProcessCleanupState =
  | { status: "open" }
  | { status: "tracked"; target: ChromeMcpProcessCleanupTarget }
  | { status: "uncertain"; target?: ChromeMcpProcessCleanupTarget }
  | { status: "closed" };

export const DEFAULT_CHROME_MCP_COMMAND = "npx";
export const DEFAULT_CHROME_MCP_PACKAGE_ARGS = ["-y", "chrome-devtools-mcp@latest"];
export const DEFAULT_CHROME_MCP_FEATURE_ARGS = [
  "--no-usage-statistics",
  // Direct chrome-devtools-mcp launches do not enable structuredContent by default.
  "--experimentalStructuredContent",
  "--experimental-page-id-routing",
];
export const CHROME_MCP_USAGE_STATISTICS_FLAG_RE = /^--(?:no-)?usage-?statistics(?:=.*)?$/i;
export const CHROME_MCP_CONNECTION_FLAGS = new Set([
  "--autoConnect",
  "--auto-connect",
  "--browserUrl",
  "--browser-url",
  "--wsEndpoint",
  "--ws-endpoint",
  "-w",
]);
export const CHROME_MCP_USER_DATA_DIR_FLAGS = new Set(["--userDataDir", "--user-data-dir"]);
export const CHROME_MCP_NEW_PAGE_TIMEOUT_MS = 5_000;
export const CHROME_MCP_NAVIGATE_TIMEOUT_MS = 20_000;
export const CHROME_MCP_HANDSHAKE_TIMEOUT_MS = 30_000;
export const CHROME_MCP_STDERR_MAX_BYTES = 8 * 1024;
export const CHROME_MCP_PROCESS_EXIT_GRACE_MS = 250;
export const DEVTOOLS_ACTIVE_PORT_RE = /\bDevToolsActivePort\b/i;
export const CHROME_CONNECTION_TOOL_ERROR_RE =
  /(?:Could not connect to Chrome|DevToolsActivePort|ECONNREFUSED|ECONNRESET|websocket|timed out)/i;
export const STALE_SELECTED_PAGE_ERROR =
  "The selected page has been closed. Call list_pages to see open pages.";
export const CHROME_MCP_SESSION_TARGET_PREFIX = "chrome-mcp:";
export const CHROME_MCP_SNAPSHOT_REF_PREFIX = "mcp-ref:";

export class ChromeMcpReconnectRequiredError extends Error {}
export class ChromeMcpProcessSnapshotError extends Error {}
