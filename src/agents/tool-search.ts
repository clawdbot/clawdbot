/**
 * Tool Search catalog compaction.
 *
 * Presents large OpenClaw/MCP/client tool inventories through search, describe, call, and optional code-mode tools.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeStringEntries,
  uniqueStrings,
  uniqueValues,
} from "@openclaw/normalization-core/string-normalization";
import { Type } from "typebox";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginToolMeta, type PluginToolMcpMeta } from "../plugins/tools.js";
import {
  isToolWrappedWithBeforeToolCallHook,
  type HookContext,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import type { AgentMessage, AgentToolResult, AgentToolUpdateCallback } from "./runtime/index.js";
import type { ToolDefinition } from "./sessions/index.js";
import { asToolParamsRecord, jsonResult, ToolInputError } from "./tools/common.js";
import type { AnyAgentTool } from "./tools/common.js";

export const TOOL_SEARCH_CODE_MODE_TOOL_NAME = "tool_search_code";
export const TOOL_SEARCH_RAW_TOOL_NAME = "tool_search";
export const TOOL_DESCRIBE_RAW_TOOL_NAME = "tool_describe";
export const TOOL_CALL_RAW_TOOL_NAME = "tool_call";

const TOOL_SEARCH_CONTROL_TOOL_NAMES = new Set([
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_CALL_RAW_TOOL_NAME,
]);

const DEFAULT_CODE_TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_MAX_SEARCH_LIMIT = 20;
const MAX_REUSABLE_CATALOG_SNAPSHOTS = 256;

type ToolSearchMode = "code" | "tools";
type CatalogSource = "openclaw" | "mcp" | "client";
type CatalogTool = AnyAgentTool | ToolDefinition;
type CatalogVisibilityOptions = {
  includeMcp?: boolean;
};

type ReusableCatalogSnapshot = {
  entries: ToolSearchCatalogEntry[];
  fingerprint: string;
};

export type ToolSearchCatalogToolExecutor = (params: {
  tool: CatalogTool;
  toolName: string;
  toolCallId: string;
  parentToolCallId?: string;
  input: unknown;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) => Promise<AgentToolResult<unknown>>;

/** Transcript projection for target tool calls made through Tool Search. */
export type ToolSearchTargetTranscriptProjection = {
  parentToolCallId?: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  result?: unknown;
  isError?: boolean;
  timestamp?: number;
};

/** Resolved Tool Search config after defaults, limits, and runtime support checks. */
export type ToolSearchConfig = {
  enabled: boolean;
  mode: ToolSearchMode;
  codeTimeoutMs: number;
  searchDefaultLimit: number;
  maxSearchLimit: number;
};

/** Per-run/session context used by Tool Search control tools. */
export type ToolSearchToolContext = {
  config?: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  abortSignal?: AbortSignal;
  executeTool?: ToolSearchCatalogToolExecutor;
};

/** Catalog entry retained behind compacted Tool Search control tools. */
export type ToolSearchCatalogEntry = {
  id: string;
  source: CatalogSource;
  sourceName?: string;
  mcp?: PluginToolMcpMeta;
  name: string;
  label?: string;
  description: string;
  parameters?: unknown;
  tool: CatalogTool;
};

export type ToolSearchCatalogSession = {
  entries: ToolSearchCatalogEntry[];
  searchCount: number;
  describeCount: number;
  callCount: number;
};

export type ToolSearchCatalogRef = {
  current?: ToolSearchCatalogSession;
};

type CodeModeBridgeMethod = "search" | "describe" | "call";

type CodeModeChildMessage =
  | { type: "result"; ok: true; value: unknown }
  | { type: "result"; ok: false; error?: string }
  | { type: "log"; items?: unknown[] }
  | { type: "bridge"; id?: unknown; method?: unknown; args?: unknown };

type CodeModeBridgeResultMessage = {
  type: "bridge-result";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
};

const TOOL_SEARCH_CODE_MODE_CHILD_SOURCE = String.raw`
import vm from "node:vm";

let activeController;

function send(message) {
  if (typeof process.send === "function" && process.connected) {
    process.send(message);
  }
}

function sendAndFlush(message) {
  return new Promise((resolve) => {
    if (typeof process.send !== "function" || !process.connected) {
      resolve();
      return;
    }
    try {
      process.send(message, () => resolve());
    } catch {
      resolve();
    }
  });
}

function toJsonSafe(value) {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    if (value instanceof Error) {
      return value.message;
    }
    if (value === null) {
      return null;
    }
    switch (typeof value) {
      case "string":
        return value;
      case "number":
      case "boolean":
      case "bigint":
      case "symbol":
      case "function":
        return String(value);
      default:
        return Object.prototype.toString.call(value);
    }
  }
}

function formatLogItem(value) {
  if (typeof value === "string") {
    return value;
  }
  const safe = toJsonSafe(value);
  return typeof safe === "string" ? safe : JSON.stringify(safe);
}

function bridgeResultPayload(message) {
  if (!message.ok) {
    return typeof message.error === "string" ? message.error : "tool bridge failed";
  }
  const json = JSON.stringify(toJsonSafe(message.value));
  return typeof json === "string" ? json : "null";
}

function settleBridge(message) {
  if (!activeController) {
    return;
  }
  const id = typeof message?.id === "string" ? message.id : "";
  try {
    activeController.settleBridge(id, Boolean(message.ok), bridgeResultPayload(message));
  } catch (error) {
    send({
      type: "result",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildModelScriptSource(code) {
  return "(async (openclaw, console) => {\n" + code + "\n})(openclaw, console)";
}

function buildControllerSource() {
  // The controller returns promise-like bridge handles. The model code can await
  // them naturally, while the parent process serializes real tool calls.
  return (
    '"use strict";\n' +
    "(() => {\n" +
    "const pending = new Map();\n" +
    "const bridgeMessages = [];\n" +
    "const logs = [];\n" +
    "let idleWaiters = [];\n" +
    "let nextBridgeId = 1;\n" +
    toJsonSafe.toString() +
    "\n" +
    formatLogItem.toString() +
    "\n" +
    "function notifyBridgeIdle() {\n" +
    "  if (pending.size !== 0 || bridgeMessages.length !== 0) return;\n" +
    "  const waiters = idleWaiters;\n" +
    "  idleWaiters = [];\n" +
    "  for (const resolve of waiters) resolve();\n" +
    "}\n" +
    "function isBridgeIdle() {\n" +
    "  return pending.size === 0 && bridgeMessages.length === 0;\n" +
    "}\n" +
    "function waitForBridgeIdle() {\n" +
    "  if (isBridgeIdle()) return Promise.resolve();\n" +
    "  return new Promise((resolve) => idleWaiters.push(resolve));\n" +
    "}\n" +
    "function bridge(method, args) {\n" +
    "  let promise;\n" +
    "  const start = () => {\n" +
    "    if (!promise) {\n" +
    "      const id = String(nextBridgeId++);\n" +
    "      promise = new Promise((resolve, reject) => {\n" +
    "        pending.set(id, { resolve, reject });\n" +
    "        bridgeMessages.push({ id, method, args: toJsonSafe(args) });\n" +
    "      });\n" +
    "    }\n" +
    "    return promise;\n" +
    "  };\n" +
    "  return Object.freeze({\n" +
    "    then: (resolve, reject) => start().then(resolve, reject),\n" +
    "    catch: (reject) => start().catch(reject),\n" +
    "    finally: (onFinally) => start().finally(onFinally),\n" +
    "  });\n" +
    "}\n" +
    "const console = Object.freeze({\n" +
    "  log: (...items) => logs.push(items.map(formatLogItem)),\n" +
    "  warn: (...items) => logs.push(items.map(formatLogItem)),\n" +
    "  error: (...items) => logs.push(items.map(formatLogItem)),\n" +
    "});\n" +
    "const openclaw = Object.freeze({\n" +
    "  tools: Object.freeze({\n" +
    "    search: (query, options) => bridge('search', [query, options]),\n" +
    "    describe: (id) => bridge('describe', [id]),\n" +
    "    call: (id, input) => bridge('call', [id, input]),\n" +
    "  }),\n" +
    "});\n" +
    "return Object.freeze({\n" +
    "  openclaw,\n" +
    "  console,\n" +
    "  isBridgeIdle,\n" +
    "  waitForBridgeIdle,\n" +
    "  takeLogs: () => logs.splice(0),\n" +
    "  takeBridgeMessages: () => bridgeMessages.splice(0),\n" +
    "  settleBridge: (id, ok, payload) => {\n" +
    "    const waiter = pending.get(String(id));\n" +
    "    if (!waiter) return;\n" +
    "    pending.delete(String(id));\n" +
    "    if (ok) {\n" +
    "      waiter.resolve(JSON.parse(String(payload)));\n" +
    "    } else {\n" +
    "      waiter.reject(new Error(String(payload)));\n" +
    "    }\n" +
    "    Promise.resolve().then(notifyBridgeIdle);\n" +
    "  },\n" +
    "});\n" +
    "})()"
  );
}

function pumpController(controller) {
  for (const items of controller.takeLogs()) {
    send({ type: "log", items });
  }
  for (const message of controller.takeBridgeMessages()) {
    send({ type: "bridge", id: message.id, method: message.method, args: message.args });
  }
}

async function runModelCode(code, timeoutMs) {
  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox, {
    name: "tool_search_code",
    codeGeneration: { strings: false, wasm: false },
  });
  const controllerScript = new vm.Script(buildControllerSource(), {
    filename: "tool_search_code:controller.js",
  });
  const controller = controllerScript.runInContext(context, {
    timeout: Math.max(1, Math.min(Number(timeoutMs) || 1, 2147483647)),
    breakOnSigint: false,
  });
  Object.defineProperties(sandbox, {
    console: { value: controller.console, enumerable: true },
    openclaw: { value: controller.openclaw, enumerable: true },
  });
  activeController = controller;
  const pumpTimer = setInterval(() => pumpController(controller), 1);
  try {
    const modelScript = new vm.Script(buildModelScriptSource(code), {
      filename: "tool_search_code:model.js",
    });
    const result = await Promise.resolve(
      modelScript.runInContext(context, {
        timeout: Math.max(1, Math.min(Number(timeoutMs) || 1, 2147483647)),
        breakOnSigint: false,
      }),
    ).then(
      (value) => ({ ok: true, value: toJsonSafe(value) }),
      (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
    do {
      pumpController(controller);
      await controller.waitForBridgeIdle();
      pumpController(controller);
    } while (!controller.isBridgeIdle());
    pumpController(controller);
    await sendAndFlush(
      result.ok
        ? { type: "result", ok: true, value: result.value }
        : { type: "result", ok: false, error: result.error },
    );
  } finally {
    clearInterval(pumpTimer);
    activeController = undefined;
  }
}

process.on("message", (message) => {
  if (message?.type === "bridge-result") {
    settleBridge(message);
    return;
  }
  if (message?.type !== "run") {
    return;
  }
  const code = typeof message.code === "string" ? message.code : "";
  runModelCode(code, message.timeoutMs).catch((error) => {
    return sendAndFlush({
      type: "result",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }).finally(() => {
    setTimeout(() => process.exit(0), 100);
  });
});
`;

const SESSION_CATALOGS_KEY = Symbol.for("openclaw.toolSearch.sessionCatalogs");
const globalToolSearchState = globalThis as typeof globalThis & {
  [SESSION_CATALOGS_KEY]?: Map<string, ToolSearchCatalogSession>;
};
const sessionCatalogs =
  globalToolSearchState[SESSION_CATALOGS_KEY] ??
  (globalToolSearchState[SESSION_CATALOGS_KEY] = new Map<string, ToolSearchCatalogSession>());
const reusableCatalogSnapshots = new Map<string, ReusableCatalogSnapshot>();
const catalogFingerprints = new WeakMap<ToolSearchCatalogSession, string>();
const catalogToolIdentities = new WeakMap<object, number>();
let nextCatalogToolIdentity = 1;

function readToolSearchConfig(config?: OpenClawConfig): Record<string, unknown> {
  const tools = isRecord(config?.tools) ? config.tools : undefined;
  const toolSearch = tools?.toolSearch;
  if (toolSearch === true) {
    return { enabled: true };
  }
  if (toolSearch === false) {
    return { enabled: false };
  }
  return isRecord(toolSearch) ? toolSearch : {};
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

let toolSearchCodeModeSupportedForTest: boolean | undefined;
let toolSearchMinCodeTimeoutMsForTest: number | undefined;

function isToolSearchCodeModeSupported(): boolean {
  if (toolSearchCodeModeSupportedForTest !== undefined) {
    return toolSearchCodeModeSupportedForTest;
  }
  return process.allowedNodeEnvironmentFlags.has("--permission");
}

function resolveMinCodeTimeoutMs(): number {
  return toolSearchMinCodeTimeoutMsForTest ?? 1000;
}

export function resolveToolSearchConfig(config?: OpenClawConfig): ToolSearchConfig {
  const raw = readToolSearchConfig(config);
  const rawMode = typeof raw.mode === "string" ? raw.mode : "code";
  const requestedMode: ToolSearchMode =
    rawMode === "tools" || rawMode === "code" ? rawMode : "code";
  const mode: ToolSearchMode =
    requestedMode === "code" && !isToolSearchCodeModeSupported() ? "tools" : requestedMode;
  const configured = Object.keys(raw).some((key) => key !== "enabled");
  const maxSearchLimit = Math.max(
    1,
    Math.min(50, readInteger(raw.maxSearchLimit, DEFAULT_MAX_SEARCH_LIMIT)),
  );
  return {
    enabled: readBoolean(raw.enabled, configured),
    mode,
    codeTimeoutMs: Math.max(
      resolveMinCodeTimeoutMs(),
      Math.min(60_000, readInteger(raw.codeTimeoutMs, DEFAULT_CODE_TIMEOUT_MS)),
    ),
    searchDefaultLimit: Math.max(
      1,
      Math.min(maxSearchLimit, readInteger(raw.searchDefaultLimit, DEFAULT_SEARCH_LIMIT)),
    ),
    maxSearchLimit,
  };
}

function sessionCatalogKeys(input: {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
}): string[] {
  const runId = input.runId?.trim();
  if (runId) {
    return [`run:${runId}`];
  }
  const keys: string[] = [];
  if (input.sessionId?.trim()) {
    keys.push(`session:${input.sessionId.trim()}`);
  }
  if (input.sessionKey?.trim()) {
    keys.push(`key:${input.sessionKey.trim()}`);
  }
  if (input.agentId?.trim()) {
    keys.push(`agent:${input.agentId.trim()}`);
  }
  return uniqueStrings(keys);
}

function sessionCatalogKey(input: {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
}): string | undefined {
  return sessionCatalogKeys(input)[0];
}

function reusableCatalogKey(input: {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): string | undefined {
  return sessionCatalogKey({
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
    agentId: input.agentId,
  });
}

function stableJsonFingerprint(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (seen.has(value)) {
    return '"[Circular]"';
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonFingerprint(item, seen)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJsonFingerprint(record[key], seen)}`);
  return `{${entries.join(",")}}`;
}

function catalogToolIdentity(tool: CatalogTool): number {
  const existing = catalogToolIdentities.get(tool);
  if (existing !== undefined) {
    return existing;
  }
  const next = nextCatalogToolIdentity;
  nextCatalogToolIdentity += 1;
  catalogToolIdentities.set(tool, next);
  return next;
}

function catalogEntriesFingerprint(entries: readonly ToolSearchCatalogEntry[]): string {
  // Fingerprints include object identity for executable tools because function
  // bodies are not JSON-stable but catalog reuse must not bind stale executors.
  return entries
    .map((entry) =>
      [
        entry.id,
        entry.source,
        entry.sourceName ?? "",
        stableJsonFingerprint(entry.mcp),
        entry.name,
        entry.label ?? "",
        entry.description,
        stableJsonFingerprint(entry.parameters),
        String(catalogToolIdentity(entry.tool)),
      ]
        .map((part) => JSON.stringify(part))
        .join(":"),
    )
    .toSorted()
    .join("\n");
}

function restoreToolSearchCatalog(params: {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  entries: ToolSearchCatalogEntry[];
  fingerprint: string;
}): ToolSearchCatalogSession | undefined {
  const keys = sessionCatalogKeys(params);
  if (keys.length === 0 && !params.catalogRef) {
    return undefined;
  }
  const next = {
    entries: params.entries,
    searchCount: 0,
    describeCount: 0,
    callCount: 0,
  };
  if (params.catalogRef) {
    params.catalogRef.current = next;
  }
  catalogFingerprints.set(next, params.fingerprint);
  for (const key of keys) {
    sessionCatalogs.set(key, next);
  }
  return next;
}

function bindToolSearchCatalog(params: {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  catalog: ToolSearchCatalogSession;
}): void {
  if (params.catalogRef) {
    params.catalogRef.current = params.catalog;
  }
  for (const key of sessionCatalogKeys(params)) {
    sessionCatalogs.set(key, params.catalog);
  }
}

function rememberReusableCatalog(key: string | undefined, catalog: ToolSearchCatalogSession): void {
  if (!key) {
    return;
  }
  const fingerprint = catalogFingerprints.get(catalog);
  if (!fingerprint) {
    return;
  }
  if (reusableCatalogSnapshots.has(key)) {
    reusableCatalogSnapshots.delete(key);
  }
  reusableCatalogSnapshots.set(key, { entries: catalog.entries, fingerprint });
  while (reusableCatalogSnapshots.size > MAX_REUSABLE_CATALOG_SNAPSHOTS) {
    const oldestKey = reusableCatalogSnapshots.keys().next().value;
    if (!oldestKey) {
      break;
    }
    reusableCatalogSnapshots.delete(oldestKey);
  }
}

function classifyTool(tool: CatalogTool): {
  source: CatalogSource;
  sourceName?: string;
  mcp?: PluginToolMcpMeta;
} {
  const meta = getPluginToolMeta(tool as AnyAgentTool);
  const pluginId = meta?.pluginId?.trim();
  if (pluginId === "bundle-mcp") {
    const mcp = meta?.mcp;
    return {
      source: "mcp",
      sourceName: pluginId,
      ...(mcp ? { mcp } : {}),
    };
  }
  if (pluginId) {
    return { source: "openclaw", sourceName: pluginId };
  }
  return { source: "openclaw", sourceName: "core" };
}

function makeCatalogId(tool: CatalogTool, source: CatalogSource, sourceName?: string): string {
  const owner = sourceName?.trim() || "core";
  return `${source}:${owner}:${tool.name}`;
}

function wrapCatalogTool(tool: AnyAgentTool, hookContext?: HookContext): AnyAgentTool {
  if (!hookContext || isToolWrappedWithBeforeToolCallHook(tool)) {
    return tool;
  }
  return wrapToolWithBeforeToolCallHook(tool, hookContext);
}

function toCatalogEntry(
  tool: CatalogTool,
  sourceOverride?: CatalogSource,
  hookContext?: HookContext,
): ToolSearchCatalogEntry {
  const classified = classifyTool(tool);
  const source = sourceOverride ?? classified.source;
  const sourceName = sourceOverride === "client" ? "client" : classified.sourceName;
  const catalogTool =
    source === "client" ? tool : wrapCatalogTool(tool as AnyAgentTool, hookContext);
  return {
    id: makeCatalogId(tool, source, sourceName),
    source,
    sourceName,
    ...(source === "mcp" && classified.mcp ? { mcp: classified.mcp } : {}),
    name: tool.name,
    label: tool.label,
    description: tool.description ?? "",
    parameters: tool.parameters,
    tool: catalogTool,
  };
}

function shouldCatalogTool(tool: AnyAgentTool): boolean {
  if (TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name)) {
    return false;
  }
  return true;
}

function shouldExposeControlTool(name: string, mode: ToolSearchMode): boolean {
  if (name === TOOL_SEARCH_CODE_MODE_TOOL_NAME) {
    return mode === "code";
  }
  if (
    name === TOOL_SEARCH_RAW_TOOL_NAME ||
    name === TOOL_DESCRIBE_RAW_TOOL_NAME ||
    name === TOOL_CALL_RAW_TOOL_NAME
  ) {
    return mode === "tools";
  }
  return false;
}

function readMessageToolResultId(message: AgentMessage): string | undefined {
  const record = message as unknown as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : "";
  const canUseDirectId = role === "toolResult" || role === "tool";
  const direct = record.toolCallId ?? record.toolUseId ?? record.tool_use_id;
  if (canUseDirectId && typeof direct === "string" && direct.trim()) {
    return direct;
  }
  const content = record.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type !== "toolResult") {
      continue;
    }
    const nested = block.toolCallId ?? block.toolUseId ?? block.tool_use_id ?? block.id;
    if (typeof nested === "string" && nested.trim()) {
      return nested;
    }
  }
  return undefined;
}

function textFromToolSearchProjectionResult(result: unknown, isError: boolean): string {
  if (isRecord(result)) {
    const details = isRecord(result.details) ? result.details : undefined;
    const detailError = details?.error;
    if (typeof detailError === "string" && detailError.trim()) {
      return detailError;
    }
    const content = result.content;
    if (Array.isArray(content)) {
      const text = content
        .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
        .filter(Boolean)
        .join("\n");
      if (text.trim()) {
        return text;
      }
    }
  }
  const safe = toJsonSafe(result);
  if (typeof safe === "string") {
    return safe;
  }
  const encoded = JSON.stringify(safe);
  if (typeof encoded === "string") {
    return encoded;
  }
  return isError ? "Tool Search target tool failed." : "Tool Search target tool completed.";
}

function buildToolSearchTargetTranscriptMessages(
  projection: ToolSearchTargetTranscriptProjection,
): AgentMessage[] {
  const input = toJsonSafe(projection.input);
  const timestamp = projection.timestamp ?? Date.now();
  const resultRecord = isRecord(projection.result) ? projection.result : undefined;
  const resultContent =
    Array.isArray(resultRecord?.content) && resultRecord.content.length > 0
      ? toJsonSafe(resultRecord.content)
      : [
          {
            type: "text",
            text: textFromToolSearchProjectionResult(
              projection.result,
              projection.isError === true,
            ),
          },
        ];
  return [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: projection.toolCallId,
          name: projection.toolName,
          arguments: input,
          input,
        },
      ],
      stopReason: "toolUse",
      timestamp,
    } as unknown as AgentMessage,
    {
      role: "toolResult",
      toolCallId: projection.toolCallId,
      toolName: projection.toolName,
      isError: projection.isError === true,
      content: resultContent,
      timestamp,
    } as unknown as AgentMessage,
  ];
}

export function projectToolSearchTargetTranscriptMessages(
  messages: AgentMessage[],
  projections: readonly ToolSearchTargetTranscriptProjection[],
): AgentMessage[] {
  if (projections.length === 0) {
    return messages;
  }
  const byParent = new Map<string, ToolSearchTargetTranscriptProjection[]>();
  const unmatched: ToolSearchTargetTranscriptProjection[] = [];
  for (const projection of projections) {
    const parent = projection.parentToolCallId?.trim();
    if (!parent) {
      unmatched.push(projection);
      continue;
    }
    const group = byParent.get(parent) ?? [];
    group.push(projection);
    byParent.set(parent, group);
  }
  const inserted = new Set<ToolSearchTargetTranscriptProjection>();
  const projected: AgentMessage[] = [];
  for (const message of messages) {
    projected.push(message);
    const toolResultId = readMessageToolResultId(message);
    const group = toolResultId ? byParent.get(toolResultId) : undefined;
    if (!group) {
      continue;
    }
    for (const projection of group) {
      projected.push(...buildToolSearchTargetTranscriptMessages(projection));
      inserted.add(projection);
    }
  }
  for (const projection of [...unmatched, ...projections]) {
    if (inserted.has(projection)) {
      continue;
    }
    projected.push(...buildToolSearchTargetTranscriptMessages(projection));
    inserted.add(projection);
  }
  return projected;
}

/** Create an explicit catalog holder for callers that cannot rely on session keys. */
export function createToolSearchCatalogRef(): ToolSearchCatalogRef {
  return {};
}

/** Replace visible tools with Tool Search controls and register hidden catalog entries. */
export function applyToolSearchCatalog(params: {
  tools: AnyAgentTool[];
  config?: OpenClawConfig;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  toolHookContext?: HookContext;
}): {
  tools: AnyAgentTool[];
  compacted: boolean;
  catalogToolCount: number;
  catalogRegistered: boolean;
  catalogReused: boolean;
} {
  const config = resolveToolSearchConfig(params.config);
  return applyToolCatalogCompaction({
    ...params,
    enabled: config.enabled,
    isVisibleControlTool: (tool) =>
      TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name) &&
      shouldExposeControlTool(tool.name, config.mode),
  });
}

/** Move client-provided tools into an existing Tool Search catalog. */
export function addClientToolsToToolSearchCatalog(params: {
  tools: ToolDefinition[];
  config?: OpenClawConfig;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
}): { tools: ToolDefinition[]; compacted: boolean; catalogToolCount: number } {
  return addClientToolsToToolCatalog({
    ...params,
    enabled: resolveToolSearchConfig(params.config).enabled,
  });
}

/** Register catalog entries under run/session keys and optional direct refs. */
export function registerToolSearchCatalog(params: {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  entries: ToolSearchCatalogEntry[];
  append?: boolean;
}): ToolSearchCatalogSession | undefined {
  const keys = sessionCatalogKeys(params);
  const primaryKey = keys[0];
  if (!primaryKey && !params.catalogRef) {
    return undefined;
  }
  const prior = params.append
    ? (params.catalogRef?.current ?? (primaryKey ? sessionCatalogs.get(primaryKey) : undefined))
    : undefined;
  const byId = new Map<string, ToolSearchCatalogEntry>();
  for (const entry of prior?.entries ?? []) {
    byId.set(entry.id, entry);
  }
  for (const entry of params.entries) {
    byId.set(entry.id, entry);
    byId.set(entry.name, entry);
  }
  const next = {
    entries: uniqueValues(byId.values()).toSorted((a, b) => a.id.localeCompare(b.id)),
    searchCount: prior?.searchCount ?? 0,
    describeCount: prior?.describeCount ?? 0,
    callCount: prior?.callCount ?? 0,
  };
  catalogFingerprints.set(next, catalogEntriesFingerprint(next.entries));
  if (params.catalogRef) {
    params.catalogRef.current = next;
  }
  for (const key of keys) {
    sessionCatalogs.set(key, next);
  }
  return next;
}

/** Clear Tool Search catalog state for a run/session/ref. */
export function clearToolSearchCatalog(params: {
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
}): void {
  if (params.catalogRef) {
    params.catalogRef.current = undefined;
  }
  for (const key of sessionCatalogKeys(params)) {
    sessionCatalogs.delete(key);
  }
  if (!params.runId?.trim()) {
    const snapshotKey = reusableCatalogKey(params);
    if (snapshotKey) {
      reusableCatalogSnapshots.delete(snapshotKey);
    }
  }
}

function resolveCatalog(ctx: ToolSearchToolContext): ToolSearchCatalogSession {
  if (ctx.catalogRef?.current) {
    return ctx.catalogRef.current;
  }
  const keys = sessionCatalogKeys({
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    runId: ctx.runId,
  });
  for (const key of keys) {
    const catalog = sessionCatalogs.get(key);
    if (catalog) {
      return catalog;
    }
  }
  if (ctx.runId?.trim()) {
    throw new ToolInputError("Tool Search catalog is unavailable for this run.");
  }
  const uniqueCatalogs = uniqueValues(sessionCatalogs.values());
  if (uniqueCatalogs.length === 1) {
    const catalog = uniqueCatalogs[0];
    if (catalog) {
      return catalog;
    }
  }
  throw new ToolInputError("Tool Search catalog is unavailable for this run.");
}

function compactEntry(entry: ToolSearchCatalogEntry) {
  return {
    id: entry.id,
    source: entry.source,
    sourceName: entry.sourceName,
    ...(entry.mcp ? { mcp: entry.mcp } : {}),
    name: entry.name,
    label: entry.label,
    description: entry.description,
  };
}

function describeEntry(entry: ToolSearchCatalogEntry) {
  return {
    ...compactEntry(entry),
    parameters: entry.parameters ?? {},
  };
}

function tokenize(input: string): string[] {
  return normalizeStringEntries(input.toLowerCase().split(/[^a-z0-9_./:-]+/u));
}

function scoreEntry(entry: ToolSearchCatalogEntry, terms: string[]): number {
  if (terms.length === 0) {
    return 1;
  }
  const name = entry.name.toLowerCase();
  const id = entry.id.toLowerCase();
  const label = (entry.label ?? "").toLowerCase();
  const description = entry.description.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (name === term || id === term) {
      score += 20;
    }
    if (name.includes(term)) {
      score += 8;
    }
    if (id.includes(term)) {
      score += 6;
    }
    if (label.includes(term)) {
      score += 4;
    }
    if (description.includes(term)) {
      score += 2;
    }
  }
  return score;
}

function visibleCatalogEntries(
  catalog: ToolSearchCatalogSession,
  options?: CatalogVisibilityOptions,
): ToolSearchCatalogEntry[] {
  return options?.includeMcp === false
    ? catalog.entries.filter((entry) => entry.source !== "mcp")
    : catalog.entries;
}

function findEntry(
  catalog: ToolSearchCatalogSession,
  id: string,
  options?: CatalogVisibilityOptions,
): ToolSearchCatalogEntry {
  const needle = id.trim();
  const entry = visibleCatalogEntries(catalog, options).find(
    (candidate) => candidate.id === needle || candidate.name === needle,
  );
  if (!entry) {
    throw new ToolInputError(`Unknown tool id: ${needle}`);
  }
  return entry;
}

function findEntryByExactId(catalog: ToolSearchCatalogSession, id: string): ToolSearchCatalogEntry {
  const needle = id.trim();
  const entry = catalog.entries.find((candidate) => candidate.id === needle);
  if (!entry) {
    throw new ToolInputError(`Unknown tool id: ${needle}`);
  }
  return entry;
}

function readId(args: unknown): string {
  const params = asToolParamsRecord(args);
  const value = params.id ?? params.toolId ?? params.name;
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError("id must be a non-empty string.");
  }
  return value.trim();
}

function readLimit(value: unknown, config: ToolSearchConfig): number {
  if (value === undefined) {
    return config.searchDefaultLimit;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ToolInputError("limit must be a positive integer.");
  }
  return Math.min(value, config.maxSearchLimit);
}

function readSearchArgs(args: unknown, config: ToolSearchConfig): { query: string; limit: number } {
  const params = asToolParamsRecord(args);
  const query = params.query;
  if (typeof query !== "string") {
    throw new ToolInputError("query must be a string.");
  }
  const options = isRecord(params.options) ? params.options : undefined;
  return {
    query,
    limit: readLimit(params.limit ?? options?.limit, config),
  };
}

function readCallArgs(args: unknown): { id: string; input: unknown } {
  const params = asToolParamsRecord(args);
  const id = readId(params);
  return {
    id,
    input: params.args ?? params.input ?? {},
  };
}

function getTelemetry(catalog: ToolSearchCatalogSession) {
  const sources: Record<CatalogSource, number> = {
    openclaw: 0,
    mcp: 0,
    client: 0,
  };
  for (const entry of catalog.entries) {
    sources[entry.source] += 1;
  }
  return {
    catalogSize: catalog.entries.length,
    sources,
    searchCount: catalog.searchCount,
    describeCount: catalog.describeCount,
    callCount: catalog.callCount,
  };
}

function sanitizeToolCallIdPart(value: string): string {
  const trimmed = value.trim();
  const safe = trimmed.replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 120);
  return safe || "call";
}

export class ToolSearchRuntime {
  private callSequence = 0;

  constructor(
    private readonly ctx: ToolSearchToolContext,
    private readonly config: ToolSearchConfig,
  ) {}

  search = async (query: string, options?: { limit?: number } & CatalogVisibilityOptions) => {
    const catalog = resolveCatalog(this.ctx);
    catalog.searchCount += 1;
    const limit = readLimit(options?.limit, this.config);
    const terms = tokenize(query);
    return visibleCatalogEntries(catalog, options)
      .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
      .filter((hit) => hit.score > 0)
      .toSorted((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
      .slice(0, limit)
      .map((hit) => compactEntry(hit.entry));
  };

  all = (options?: CatalogVisibilityOptions) => {
    const catalog = resolveCatalog(this.ctx);
    return visibleCatalogEntries(catalog, options).map((entry) => compactEntry(entry));
  };

  namespaceEntries = () => {
    const catalog = resolveCatalog(this.ctx);
    return catalog.entries.map((entry) =>
      Object.assign(compactEntry(entry), {
        parameters: entry.parameters ?? {},
      }),
    );
  };

  describe = async (id: string, options?: CatalogVisibilityOptions) => {
    const catalog = resolveCatalog(this.ctx);
    catalog.describeCount += 1;
    return describeEntry(findEntry(catalog, id, options));
  };

  call = async (
    id: string,
    input?: unknown,
    options?: {
      parentToolCallId?: string;
      signal?: AbortSignal;
      onUpdate?: AgentToolUpdateCallback;
    },
  ) => {
    const catalog = resolveCatalog(this.ctx);
    const entry = findEntry(catalog, id);
    return await this.callEntry(catalog, entry, input, options);
  };

  callExactId = async (
    id: string,
    input?: unknown,
    options?: {
      parentToolCallId?: string;
      signal?: AbortSignal;
      onUpdate?: AgentToolUpdateCallback;
    },
  ) => {
    const catalog = resolveCatalog(this.ctx);
    const entry = findEntryByExactId(catalog, id);
    return await this.callEntry(catalog, entry, input, options);
  };

  private readonly callEntry = async (
    catalog: ToolSearchCatalogSession,
    entry: ToolSearchCatalogEntry,
    input?: unknown,
    options?: {
      parentToolCallId?: string;
      signal?: AbortSignal;
      onUpdate?: AgentToolUpdateCallback;
    },
  ) => {
    catalog.callCount += 1;
    const parentId = sanitizeToolCallIdPart(options?.parentToolCallId ?? "direct");
    const toolCallId = `tool_search_code:${parentId}:${entry.name}:${++this.callSequence}`;
    const executeTool =
      this.ctx.executeTool ??
      (async (params: Parameters<ToolSearchCatalogToolExecutor>[0]) =>
        await params.tool.execute(
          params.toolCallId,
          params.input,
          params.signal,
          params.onUpdate,
          undefined as never,
        ));
    const result = await executeTool({
      tool: entry.tool,
      toolName: entry.name,
      toolCallId,
      parentToolCallId: options?.parentToolCallId,
      input: input ?? {},
      signal: options?.signal ?? this.ctx.abortSignal,
      onUpdate: options?.onUpdate,
    });
    return {
      tool: compactEntry(entry),
      result,
    };
  };

  telemetry() {
    return getTelemetry(resolveCatalog(this.ctx));
  }
}

/** Compact a native tool list into visible control tools plus hidden catalog entries. */
export function applyToolCatalogCompaction(params: {
  tools: AnyAgentTool[];
  enabled: boolean;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  toolHookContext?: HookContext;
  isVisibleControlTool: (tool: AnyAgentTool) => boolean;
  shouldCatalogTool?: (tool: AnyAgentTool) => boolean;
}): {
  tools: AnyAgentTool[];
  compacted: boolean;
  catalogToolCount: number;
  catalogRegistered: boolean;
  catalogReused: boolean;
} {
  if (!params.enabled) {
    return {
      tools: params.tools,
      compacted: false,
      catalogToolCount: 0,
      catalogRegistered: false,
      catalogReused: false,
    };
  }
  const hasControlTool = params.tools.some((tool) => params.isVisibleControlTool(tool));
  const key = sessionCatalogKey(params);
  if (!hasControlTool || (!key && !params.catalogRef)) {
    return {
      tools: params.tools.filter((tool) => !TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name)),
      compacted: false,
      catalogToolCount: 0,
      catalogRegistered: false,
      catalogReused: false,
    };
  }

  const visible: AnyAgentTool[] = [];
  const catalog: ToolSearchCatalogEntry[] = [];
  const shouldCatalog = params.shouldCatalogTool ?? shouldCatalogTool;
  for (const tool of params.tools) {
    if (params.isVisibleControlTool(tool)) {
      visible.push(tool);
      continue;
    }
    if (TOOL_SEARCH_CONTROL_TOOL_NAMES.has(tool.name)) {
      continue;
    }
    if (shouldCatalog(tool)) {
      catalog.push(toCatalogEntry(tool, undefined, params.toolHookContext));
      continue;
    }
    visible.push(tool);
  }
  const incomingFingerprint = catalogEntriesFingerprint(catalog);
  const existingCatalog =
    params.catalogRef?.current ?? (key ? sessionCatalogs.get(key) : undefined);
  if (existingCatalog && catalogFingerprints.get(existingCatalog) === incomingFingerprint) {
    bindToolSearchCatalog({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      runId: params.runId,
      catalogRef: params.catalogRef,
      catalog: existingCatalog,
    });
    return {
      tools: visible,
      compacted: catalog.length > 0,
      catalogToolCount: catalog.length,
      catalogRegistered: true,
      catalogReused: true,
    };
  }

  const reusableKey = reusableCatalogKey(params);
  const reusableSnapshot = reusableKey ? reusableCatalogSnapshots.get(reusableKey) : undefined;
  if (reusableSnapshot?.fingerprint === incomingFingerprint) {
    restoreToolSearchCatalog({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      runId: params.runId,
      catalogRef: params.catalogRef,
      entries: reusableSnapshot.entries,
      fingerprint: reusableSnapshot.fingerprint,
    });
    if (reusableKey) {
      reusableCatalogSnapshots.delete(reusableKey);
      reusableCatalogSnapshots.set(reusableKey, reusableSnapshot);
    }
    return {
      tools: visible,
      compacted: catalog.length > 0,
      catalogToolCount: catalog.length,
      catalogRegistered: true,
      catalogReused: true,
    };
  }

  const registered = registerToolSearchCatalog({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    runId: params.runId,
    catalogRef: params.catalogRef,
    entries: catalog,
    append: false,
  });
  if (registered) {
    rememberReusableCatalog(reusableKey, registered);
  }
  return {
    tools: visible,
    compacted: catalog.length > 0,
    catalogToolCount: catalog.length,
    catalogRegistered: true,
    catalogReused: false,
  };
}

/** Append client-side tool definitions to an already registered catalog. */
export function addClientToolsToToolCatalog(params: {
  tools: ToolDefinition[];
  enabled: boolean;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
}): { tools: ToolDefinition[]; compacted: boolean; catalogToolCount: number } {
  const key = sessionCatalogKey(params);
  if (!params.enabled || (!key && !params.catalogRef)) {
    return { tools: params.tools, compacted: false, catalogToolCount: 0 };
  }
  const existing = params.catalogRef?.current ?? (key ? sessionCatalogs.get(key) : undefined);
  if (!existing) {
    return { tools: params.tools, compacted: false, catalogToolCount: 0 };
  }
  registerToolSearchCatalog({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    runId: params.runId,
    catalogRef: params.catalogRef,
    entries: params.tools.map((tool) => toCatalogEntry(tool, "client")),
    append: true,
  });
  return { tools: [], compacted: params.tools.length > 0, catalogToolCount: params.tools.length };
}

function toJsonSafe(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : (JSON.parse(serialized) as unknown);
  } catch {
    if (value instanceof Error) {
      return value.message;
    }
    if (value === null) {
      return null;
    }
    switch (typeof value) {
      case "string":
        return value;
      case "number":
      case "boolean":
      case "bigint":
      case "symbol":
      case "function":
        return String(value);
      default:
        return Object.prototype.toString.call(value);
    }
  }
}

async function runCodeMode(params: {
  toolCallId: string;
  ctx: ToolSearchToolContext;
  code: string;
  config: ToolSearchConfig;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) {
  const runtime = new ToolSearchRuntime(params.ctx, params.config);
  const logs: string[] = [];
  const value = await runCodeModeChild({
    code: params.code,
    config: params.config,
    logs,
    parentToolCallId: params.toolCallId,
    runtime,
    signal: params.signal,
    onUpdate: params.onUpdate,
  });
  return {
    ok: true,
    value: toJsonSafe(value),
    logs,
    telemetry: runtime.telemetry(),
  };
}

function buildCodeModeChildArgs(): string[] {
  if (!process.allowedNodeEnvironmentFlags.has("--permission")) {
    throw new ToolInputError("tool_search_code requires a Node runtime with --permission support.");
  }
  return ["--permission", "--input-type=module", "--eval", TOOL_SEARCH_CODE_MODE_CHILD_SOURCE];
}

function isCodeModeBridgeMethod(value: unknown): value is CodeModeBridgeMethod {
  return value === "search" || value === "describe" || value === "call";
}

async function runCodeModeBridgeRequest(
  runtime: ToolSearchRuntime,
  method: CodeModeBridgeMethod,
  args: unknown,
  options?: {
    parentToolCallId?: string;
    signal?: AbortSignal;
    onUpdate?: AgentToolUpdateCallback;
  },
): Promise<unknown> {
  const values = Array.isArray(args) ? args : [];
  switch (method) {
    case "search": {
      const query = values[0];
      if (typeof query !== "string") {
        throw new ToolInputError("search query must be a string.");
      }
      const optionsLocal = isRecord(values[1]) ? values[1] : undefined;
      return await runtime.search(query, {
        limit: typeof optionsLocal?.limit === "number" ? optionsLocal.limit : undefined,
      });
    }
    case "describe": {
      const id = values[0];
      if (typeof id !== "string") {
        throw new ToolInputError("describe id must be a string.");
      }
      return await runtime.describe(id);
    }
    case "call": {
      const id = values[0];
      if (typeof id !== "string") {
        throw new ToolInputError("call id must be a string.");
      }
      return await runtime.call(id, values[1] ?? {}, options);
    }
  }
  throw new ToolInputError("Unsupported tool_search_code bridge method.");
}

function runCodeModeChild(params: {
  code: string;
  config: ToolSearchConfig;
  logs: string[];
  parentToolCallId: string;
  runtime: ToolSearchRuntime;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, buildCodeModeChildArgs(), {
      cwd: os.tmpdir(),
      env: {},
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const stderr: string[] = [];
    let settled = false;
    let timedOut = false;
    let exitRejectionTimer: ReturnType<typeof setTimeout> | undefined;
    const bridgeAbortController = new AbortController();
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (exitRejectionTimer) {
        clearTimeout(exitRejectionTimer);
      }
      params.signal?.removeEventListener("abort", abortFromParent);
      child.kill();
      callback();
    };
    const abortFromParent: () => void = () => {
      bridgeAbortController.abort(params.signal?.reason);
      child.kill("SIGKILL");
      settle(() => reject(new Error("tool_search_code aborted")));
    };
    const timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timedOut = true;
      bridgeAbortController.abort(new Error("tool_search_code timed out"));
      child.kill("SIGKILL");
      settle(() => reject(new Error("tool_search_code timed out")));
    }, params.config.codeTimeoutMs);
    params.signal?.addEventListener("abort", abortFromParent, { once: true });
    if (params.signal?.aborted) {
      abortFromParent();
      return;
    }

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr.push(chunk);
    });

    child.on("error", (error) => {
      settle(() => reject(error));
    });
    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }
      const rejectOnExit = () => {
        const suffix = stderr.join("").trim();
        const detail = suffix ? `: ${suffix.slice(0, 500)}` : "";
        settle(() =>
          reject(
            new Error(
              timedOut
                ? "tool_search_code timed out"
                : `tool_search_code child exited with ${signal ?? code}${detail}`,
            ),
          ),
        );
      };
      if (code === 0 && signal === null) {
        // A clean exit can race the final IPC result. Wait briefly before
        // treating it as failure so flushed bridge/result messages can arrive.
        exitRejectionTimer = setTimeout(rejectOnExit, 250);
        return;
      }
      rejectOnExit();
    });
    child.on("message", (message: CodeModeChildMessage) => {
      if (settled) {
        return;
      }
      if (!isRecord(message) || typeof message.type !== "string") {
        return;
      }
      if (message.type === "log") {
        const items = Array.isArray(message.items) ? message.items : [];
        params.logs.push(items.map((item) => String(item)).join(" "));
        return;
      }
      if (message.type === "result") {
        if (message.ok) {
          settle(() => resolve(message.value));
        } else {
          settle(() =>
            reject(new Error(typeof message.error === "string" ? message.error : "code failed")),
          );
        }
        return;
      }
      if (message.type !== "bridge") {
        return;
      }
      const id = typeof message.id === "string" ? message.id : "";
      const method = isCodeModeBridgeMethod(message.method) ? message.method : undefined;
      if (!id || !method) {
        return;
      }
      void runCodeModeBridgeRequest(params.runtime, method, message.args, {
        parentToolCallId: params.parentToolCallId,
        signal: bridgeAbortController.signal,
        onUpdate: params.onUpdate,
      })
        .then((value) => {
          if (settled || !child.connected) {
            return;
          }
          const response: CodeModeBridgeResultMessage = {
            type: "bridge-result",
            id,
            ok: true,
            value: toJsonSafe(value),
          };
          child.send(response, () => undefined);
        })
        .catch((error: unknown) => {
          if (settled || !child.connected) {
            return;
          }
          const response: CodeModeBridgeResultMessage = {
            type: "bridge-result",
            id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
          child.send(response, () => undefined);
        });
    });

    child.send({
      type: "run",
      code: params.code,
      timeoutMs: params.config.codeTimeoutMs,
    });
  });
}

function readCode(args: unknown): string {
  const params = asToolParamsRecord(args);
  const code = params.code;
  if (typeof code !== "string" || !code.trim()) {
    throw new ToolInputError("code must be a non-empty string.");
  }
  return code;
}

/** Create Tool Search control tools for the current run/session context. */
export function createToolSearchTools(ctx: ToolSearchToolContext): AnyAgentTool[] {
  const config = resolveToolSearchConfig(ctx.runtimeConfig ?? ctx.config);
  const runtime = new ToolSearchRuntime(ctx, config);
  return [
    {
      name: TOOL_SEARCH_CODE_MODE_TOOL_NAME,
      label: "Tool Search Code",
      description:
        "Run JavaScript in an isolated Node subprocess with openclaw.tools.search, openclaw.tools.describe, and openclaw.tools.call for large tool catalogs.",
      parameters: Type.Object({
        code: Type.String({
          description:
            "JavaScript body for an async function. Use return to return the final value. The openclaw.tools bridge is available.",
        }),
      }),
      execute: async (
        toolCallId: string,
        args: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback,
      ): Promise<AgentToolResult<unknown>> =>
        jsonResult(
          await runCodeMode({ toolCallId, ctx, code: readCode(args), config, signal, onUpdate }),
        ),
    },
    {
      name: TOOL_SEARCH_RAW_TOOL_NAME,
      label: "Tool Search",
      description: "Search the effective Tool Search catalog.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query." }),
        limit: Type.Optional(Type.Number({ description: "Maximum number of results." })),
      }),
      execute: async (_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> => {
        const search = readSearchArgs(args, config);
        return jsonResult(await runtime.search(search.query, { limit: search.limit }));
      },
    },
    {
      name: TOOL_DESCRIBE_RAW_TOOL_NAME,
      label: "Tool Describe",
      description: "Load the full schema and metadata for one search result.",
      parameters: Type.Object({
        id: Type.String({ description: "Tool search result id or tool name." }),
      }),
      execute: async (_toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> =>
        jsonResult(await runtime.describe(readId(args))),
    },
    {
      name: TOOL_CALL_RAW_TOOL_NAME,
      label: "Tool Call",
      description: "Call a selected Tool Search catalog entry through OpenClaw.",
      parameters: Type.Object({
        id: Type.String({ description: "Tool search result id or tool name." }),
        args: Type.Optional(
          Type.Record(Type.String(), Type.Unknown(), { description: "Tool input." }),
        ),
      }),
      execute: async (
        _toolCallId: string,
        args: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback,
      ): Promise<AgentToolResult<unknown>> => {
        const call = readCallArgs(args);
        return jsonResult(
          await runtime.call(call.id, call.input, {
            parentToolCallId: _toolCallId,
            signal,
            onUpdate,
          }),
        );
      },
    },
  ];
}

export const testing = {
  sessionCatalogs,
  reusableCatalogSnapshots,
  resolveToolSearchConfig,
  isToolSearchCodeModeSupported,
  setToolSearchCodeModeSupportedForTest: (value: boolean | undefined) => {
    toolSearchCodeModeSupportedForTest = value;
  },
  setToolSearchMinCodeTimeoutMsForTest: (value: number | undefined) => {
    toolSearchMinCodeTimeoutMsForTest =
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : undefined;
  },
  applyToolSearchCatalog,
  addClientToolsToToolSearchCatalog,
};
export { testing as __testing };
