/** Session-scoped embedded LSP runtime and tool materialization for agent bundles. */
import type { ChildProcess } from "node:child_process";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAbortError } from "../infra/abort-signal.js";
import { logDebug, logWarn } from "../logger.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { setPluginToolMeta } from "../plugins/tools.js";
import {
  defaultBundleLspRuntimeDependencies,
  type BundleLspRuntimeDependencies,
} from "./agent-bundle-lsp-dependencies.js";
import {
  resolveStdioMcpServerLaunchConfig,
  describeStdioMcpServerLaunchConfig,
} from "./mcp-stdio.js";
import type { AgentToolResult } from "./runtime/index.js";
import type { AnyAgentTool } from "./tools/common.js";

// Minimal LSP JSON-RPC framing over stdio (Content-Length header + JSON body).

type LspSession = {
  serverName: string;
  process: ChildProcess;
  requestId: number;
  pendingRequests: Map<number, PendingLspRequest>;
  buffer: Buffer;
  initialized: boolean;
  capabilities: LspServerCapabilities;
  disposed: boolean;
  // Cleanup must use the same process owner that spawned this session.
  killProcessTree: BundleLspRuntimeDependencies["killProcessTree"];
  // Preserve a terminal process/transport failure so later requests reject immediately
  // instead of waiting for the per-request timeout.
  failure?: Error;
};

type PendingLspRequest = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  dispose: () => void;
};

type LspServerCapabilities = {
  hoverProvider?: boolean;
  completionProvider?: boolean;
  definitionProvider?: boolean;
  referencesProvider?: boolean;
  diagnosticProvider?: boolean;
  [key: string]: unknown;
};

/** Materialized LSP tools plus session capabilities and cleanup handle. */
type BundleLspToolRuntime = {
  tools: AnyAgentTool[];
  sessions: Array<{ serverName: string; capabilities: LspServerCapabilities }>;
  dispose: () => Promise<void>;
};

type LspPositionParams = {
  uri: string;
  line: number;
  character: number;
};

const LSP_SHUTDOWN_GRACE_MS = 500;
const LSP_PROCESS_TREE_KILL_GRACE_MS = 1_000;
const activeBundleLspSessions = new Set<LspSession>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, Math.max(1, ms));
    timeout.unref?.();
  });
}

function createLspSession(
  serverName: string,
  child: ChildProcess,
  killProcessTree: BundleLspRuntimeDependencies["killProcessTree"],
): LspSession {
  return {
    serverName,
    process: child,
    requestId: 0,
    pendingRequests: new Map(),
    buffer: Buffer.alloc(0),
    initialized: false,
    capabilities: {},
    disposed: false,
    killProcessTree,
  };
}

function registerActiveLspSession(session: LspSession): void {
  activeBundleLspSessions.add(session);
}

function rememberLspFailure(session: LspSession, error: Error): void {
  session.failure ??= error;
}

function takePendingLspRequest(session: LspSession, id: number): PendingLspRequest | undefined {
  const pending = session.pendingRequests.get(id);
  if (!pending) {
    return undefined;
  }
  session.pendingRequests.delete(id);
  clearTimeout(pending.timeout);
  pending.dispose();
  return pending;
}

function failLspSession(session: LspSession, error: Error): void {
  rememberLspFailure(session, error);
  for (const [id] of session.pendingRequests) {
    takePendingLspRequest(session, id)?.reject(session.failure ?? error);
  }
}

function lspProcessExitError(
  session: LspSession,
  code: number | null,
  signal: NodeJS.Signals | null,
) {
  return new Error(`LSP server "${session.serverName}" exited (${signal ?? code ?? "unknown"})`);
}

function attachLspProcessHandlers(session: LspSession): void {
  session.process.on("error", (error) => {
    failLspSession(session, error);
  });
  session.process.on("exit", (code, signal) => {
    // Block new requests immediately, but let stdout drain any final response before close.
    rememberLspFailure(session, lspProcessExitError(session, code, signal));
  });
  session.process.on("close", (code, signal) => {
    failLspSession(session, lspProcessExitError(session, code, signal));
  });
  session.process.stdout?.on("data", (chunk: Buffer | string) =>
    handleIncomingData(session, chunk),
  );
  session.process.stdout?.on("error", (error) => {
    failLspSession(session, error);
  });
  session.process.stdin?.on("error", (error) => {
    failLspSession(session, error);
  });
  session.process.stderr?.setEncoding("utf-8");
  session.process.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
      logDebug(`bundle-lsp:${session.serverName}: ${line.trim()}`);
    }
  });
  session.process.stderr?.on("error", (error) => {
    logWarn(`bundle-lsp:${session.serverName}: stderr failed: ${String(error)}`);
  });
}

function encodeLspMessage(body: unknown): string {
  const json = JSON.stringify(body);
  return `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;
}

const LSP_HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "ascii");
const MAX_LSP_HEADER_BYTES = 8 * 1024;
const MAX_LSP_BODY_BYTES = 64 * 1024 * 1024;

class LspFramingError extends Error {
  override readonly name = "LspFramingError";
}

type LspParseResult =
  | { readonly ok: true; readonly messages: unknown[]; readonly remaining: Buffer }
  | { readonly ok: false; readonly messages: unknown[]; readonly error: LspFramingError };

function framingError(messages: unknown[], detail: string): LspParseResult {
  return {
    ok: false,
    messages,
    error: new LspFramingError(`LSP framing error: ${detail}`),
  };
}

function parseContentLength(header: string): number | LspFramingError {
  const values: string[] = [];
  for (const line of header.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      return new LspFramingError("LSP framing error: header line must contain a colon");
    }
    if (line.slice(0, separator).trim().toLowerCase() === "content-length") {
      values.push(line.slice(separator + 1).trim());
    }
  }
  if (values.length !== 1) {
    return new LspFramingError(
      `LSP framing error: expected exactly one Content-Length header, received ${values.length}`,
    );
  }
  const value = values[0];
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    return new LspFramingError("LSP framing error: Content-Length must be decimal digits");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length <= 0) {
    return new LspFramingError("LSP framing error: Content-Length must be a positive safe integer");
  }
  if (length > MAX_LSP_BODY_BYTES) {
    return new LspFramingError(
      `LSP framing error: Content-Length exceeds ${MAX_LSP_BODY_BYTES} bytes`,
    );
  }
  return length;
}

function parseLspMessages(buffer: Buffer): LspParseResult {
  const messages: unknown[] = [];
  let remaining = buffer;

  while (true) {
    const headerEnd = remaining.indexOf(LSP_HEADER_SEPARATOR);
    if (headerEnd === -1) {
      const maxIncompleteHeaderBytes = MAX_LSP_HEADER_BYTES + LSP_HEADER_SEPARATOR.length - 1;
      return remaining.length > maxIncompleteHeaderBytes
        ? framingError(messages, `header exceeds ${MAX_LSP_HEADER_BYTES} bytes`)
        : { ok: true, messages, remaining };
    }
    if (headerEnd > MAX_LSP_HEADER_BYTES) {
      return framingError(messages, `header exceeds ${MAX_LSP_HEADER_BYTES} bytes`);
    }

    const contentLength = parseContentLength(remaining.subarray(0, headerEnd).toString("ascii"));
    if (contentLength instanceof LspFramingError) {
      return { ok: false, messages, error: contentLength };
    }
    const bodyStart = headerEnd + LSP_HEADER_SEPARATOR.length;
    const bodyEnd = bodyStart + contentLength;
    if (remaining.length < bodyEnd) {
      return { ok: true, messages, remaining };
    }

    const body = remaining.subarray(bodyStart, bodyEnd).toString("utf8");
    try {
      messages.push(JSON.parse(body));
    } catch (error) {
      return framingError(
        messages,
        `body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    remaining = remaining.subarray(bodyEnd);
  }
}

function lspAbortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : createAbortError("LSP request aborted", { cause: signal?.reason });
}

function sendRequest(
  session: LspSession,
  method: string,
  params?: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (session.failure) {
    return Promise.reject(session.failure);
  }
  if (signal?.aborted) {
    return Promise.reject(lspAbortError(signal));
  }
  const id = ++session.requestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      takePendingLspRequest(session, id)?.reject(new Error(`LSP request ${method} timed out`));
    }, 10_000);
    timeout.unref?.();
    const onAbort = () => {
      const pending = takePendingLspRequest(session, id);
      if (!pending) {
        return;
      }
      // Bundle tools share the server process, so cancel only this request.
      try {
        session.process.stdin?.write(
          encodeLspMessage({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }),
          "utf-8",
        );
      } catch {
        // Best-effort notification; the local tool promise must still settle.
      }
      pending.reject(lspAbortError(signal));
    };
    const dispose = () => signal?.removeEventListener("abort", onAbort);
    session.pendingRequests.set(id, { resolve, reject, timeout, dispose });
    signal?.addEventListener("abort", onAbort, { once: true });
    const message = { jsonrpc: "2.0", id, method, params };
    const encoded = encodeLspMessage(message);
    session.process.stdin?.write(encoded, "utf-8");
  });
}

function handleIncomingData(session: LspSession, chunk: Buffer | string) {
  session.buffer = Buffer.concat([
    session.buffer,
    typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
  ]);
  const parsed = parseLspMessages(session.buffer);
  session.buffer = parsed.ok
    ? parsed.remaining.length === 0
      ? Buffer.alloc(0)
      : Buffer.from(parsed.remaining)
    : Buffer.alloc(0);

  for (const msg of parsed.messages) {
    if (typeof msg !== "object" || msg === null) {
      continue;
    }
    const record = msg as Record<string, unknown>;

    if ("id" in record && typeof record.id === "number") {
      const pending = takePendingLspRequest(session, record.id);
      if (pending) {
        if ("error" in record) {
          pending.reject(new Error(JSON.stringify(record.error)));
        } else {
          pending.resolve(record.result);
        }
      }
    }
    // Notifications (no id) are logged but not acted on
    if ("method" in record && !("id" in record)) {
      logDebug(`bundle-lsp:${session.serverName}: notification ${String(record.method)}`);
    }
  }
  if (!parsed.ok) {
    failLspSession(session, parsed.error);
    terminateLspProcessTree(session);
  }
}

async function initializeSession(session: LspSession): Promise<LspServerCapabilities> {
  const result = (await sendRequest(session, "initialize", {
    processId: process.pid,
    rootUri: null,
    capabilities: {
      textDocument: {
        hover: { contentFormat: ["plaintext", "markdown"] },
        completion: { completionItem: { snippetSupport: false } },
        definition: {},
        references: {},
      },
    },
  })) as { capabilities?: LspServerCapabilities } | undefined;

  // Send initialized notification
  session.process.stdin?.write(
    encodeLspMessage({ jsonrpc: "2.0", method: "initialized", params: {} }),
    "utf-8",
  );

  session.initialized = true;
  return result?.capabilities ?? {};
}

function hasLspProcessExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function terminateLspProcessTree(session: LspSession): void {
  const pid = session.process.pid;
  if (pid && !hasLspProcessExited(session.process)) {
    session.killProcessTree(pid, { graceMs: LSP_PROCESS_TREE_KILL_GRACE_MS });
    return;
  }
  if (!hasLspProcessExited(session.process)) {
    session.process.kill("SIGTERM");
  }
}

async function disposeSession(session: LspSession) {
  if (session.disposed) {
    return;
  }
  session.disposed = true;
  activeBundleLspSessions.delete(session);

  if (session.initialized) {
    try {
      const shutdown = sendRequest(session, "shutdown").catch(() => undefined);
      await Promise.race([shutdown, delay(LSP_SHUTDOWN_GRACE_MS)]);
      session.process.stdin?.write(
        encodeLspMessage({ jsonrpc: "2.0", method: "exit", params: null }),
        "utf-8",
      );
    } catch {
      // best-effort
    }
  }
  for (const [id] of session.pendingRequests) {
    takePendingLspRequest(session, id)?.reject(new Error("LSP session disposed"));
  }
  terminateLspProcessTree(session);
}

async function disposeSessions(sessions: Iterable<LspSession>): Promise<void> {
  await Promise.allSettled(Array.from(sessions, (session) => disposeSession(session)));
}

function createLspPositionTool(params: {
  session: LspSession;
  toolName: string;
  label: string;
  description: string;
  method: string;
  resultLabel: string;
}): AnyAgentTool {
  return {
    name: params.toolName,
    label: params.label,
    description: params.description,
    parameters: {
      type: "object",
      properties: {
        uri: { type: "string", description: "File URI (file:///path/to/file)" },
        line: { type: "number", description: "Zero-based line number" },
        character: { type: "number", description: "Zero-based character offset" },
      },
      required: ["uri", "line", "character"],
    },
    execute: async (_toolCallId, input, signal) => {
      const position = input as LspPositionParams;
      const result = await sendRequest(
        params.session,
        params.method,
        {
          textDocument: { uri: position.uri },
          position: { line: position.line, character: position.character },
        },
        signal,
      );
      return formatLspResult(params.session.serverName, params.resultLabel, result);
    },
  };
}

function buildLspTools(session: LspSession): AnyAgentTool[] {
  const tools: AnyAgentTool[] = [];
  const caps = session.capabilities;
  const serverLabel = session.serverName;

  if (caps.hoverProvider) {
    tools.push(
      createLspPositionTool({
        session,
        toolName: `lsp_hover_${serverLabel}`,
        label: `LSP Hover (${serverLabel})`,
        description: `Get hover information for a symbol at a position in a file via the ${serverLabel} language server.`,
        method: "textDocument/hover",
        resultLabel: "hover",
      }),
    );
  }

  if (caps.definitionProvider) {
    tools.push(
      createLspPositionTool({
        session,
        toolName: `lsp_definition_${serverLabel}`,
        label: `LSP Go to Definition (${serverLabel})`,
        description: `Find the definition of a symbol at a position in a file via the ${serverLabel} language server.`,
        method: "textDocument/definition",
        resultLabel: "definition",
      }),
    );
  }

  if (caps.referencesProvider) {
    tools.push({
      name: `lsp_references_${serverLabel}`,
      label: `LSP Find References (${serverLabel})`,
      description: `Find all references to a symbol at a position in a file via the ${serverLabel} language server.`,
      parameters: {
        type: "object",
        properties: {
          uri: { type: "string", description: "File URI (file:///path/to/file)" },
          line: { type: "number", description: "Zero-based line number" },
          character: { type: "number", description: "Zero-based character offset" },
          includeDeclaration: {
            type: "boolean",
            description: "Include the declaration in results",
          },
        },
        required: ["uri", "line", "character"],
      },
      execute: async (_toolCallId, input, signal) => {
        const params = input as {
          uri: string;
          line: number;
          character: number;
          includeDeclaration?: boolean;
        };
        const result = await sendRequest(
          session,
          "textDocument/references",
          {
            textDocument: { uri: params.uri },
            position: { line: params.line, character: params.character },
            context: { includeDeclaration: params.includeDeclaration ?? true },
          },
          signal,
        );
        return formatLspResult(serverLabel, "references", result);
      },
    });
  }

  return tools;
}

function formatLspResult(
  serverName: string,
  method: string,
  result: unknown,
): AgentToolResult<unknown> {
  const text =
    result !== null && result !== undefined
      ? JSON.stringify(result, null, 2)
      : `No ${method} result from ${serverName}`;
  return {
    content: [{ type: "text", text }],
    details: { lspServer: serverName, lspMethod: method },
  };
}

export async function createBundleLspToolRuntime(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  reservedToolNames?: Iterable<string>;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  dependencies?: BundleLspRuntimeDependencies;
}): Promise<BundleLspToolRuntime> {
  const dependencies = params.dependencies ?? defaultBundleLspRuntimeDependencies;
  const loaded = dependencies.loadLspConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
  });
  for (const diagnostic of loaded.diagnostics) {
    logWarn(`bundle-lsp: ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  // Skip spawning when no LSP servers are configured.
  if (Object.keys(loaded.lspServers).length === 0) {
    return { tools: [], sessions: [], dispose: async () => {} };
  }

  const reservedNames = new Set(
    Array.from(params.reservedToolNames ?? [], (name) =>
      normalizeOptionalLowercaseString(name),
    ).filter(Boolean),
  );
  const sessions: LspSession[] = [];
  const tools: AnyAgentTool[] = [];

  try {
    for (const [serverName, rawServer] of Object.entries(loaded.lspServers)) {
      const launch = resolveStdioMcpServerLaunchConfig(rawServer);
      if (!launch.ok) {
        logWarn(`bundle-lsp: skipped server "${serverName}" because ${launch.reason}.`);
        continue;
      }
      const launchConfig = launch.config;
      let session: LspSession | undefined;

      try {
        session = createLspSession(
          serverName,
          dependencies.spawnServerProcess(launchConfig),
          dependencies.killProcessTree,
        );
        registerActiveLspSession(session);
        attachLspProcessHandlers(session);

        const capabilities = await initializeSession(session);
        session.capabilities = capabilities;
        sessions.push(session);

        const serverTools = buildLspTools(session);
        for (const tool of serverTools) {
          const normalizedName = normalizeOptionalLowercaseString(tool.name);
          if (!normalizedName) {
            continue;
          }
          if (reservedNames.has(normalizedName)) {
            logWarn(
              `bundle-lsp: skipped tool "${tool.name}" from server "${serverName}" because the name already exists.`,
            );
            continue;
          }
          reservedNames.add(normalizedName);
          setPluginToolMeta(tool, {
            pluginId: "bundle-lsp",
            optional: false,
          });
          tools.push(tool);
        }

        logDebug(
          `bundle-lsp: started "${serverName}" (${describeStdioMcpServerLaunchConfig(launchConfig)}) with ${serverTools.length} tools`,
        );
      } catch (error) {
        if (session) {
          await disposeSession(session);
        }
        logWarn(
          `bundle-lsp: failed to start server "${serverName}" (${describeStdioMcpServerLaunchConfig(launchConfig)}): ${String(error)}`,
        );
      }
    }

    return {
      tools,
      sessions: sessions.map((s) => ({
        serverName: s.serverName,
        capabilities: s.capabilities,
      })),
      dispose: async () => {
        await disposeSessions(sessions);
      },
    };
  } catch (error) {
    await disposeSessions(sessions);
    throw error;
  }
}

export async function disposeAllBundleLspRuntimes(): Promise<void> {
  await disposeSessions(activeBundleLspSessions);
}
