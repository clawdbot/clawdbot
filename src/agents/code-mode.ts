/**
 * Host-side Code Mode controller for isolated QuickJS execution with bridged
 * tool search/call/yield support.
 */
import { Type } from "typebox";
import { getAgentToolExecutionContext } from "../../packages/agent-core/src/tool-execution-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import {
  codeModeReplayIdForToolCall,
  runBridgeRequest,
  setCodeModeSwarmDepsForTest,
} from "./code-mode-bridge.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  isCodeModeControlTool,
  markCodeModeControlTool,
} from "./code-mode-control-tools.js";
import { runExec, runWait } from "./code-mode-execution.js";
import { createHeadlessAbortScope, runCodeModeScriptHeadless } from "./code-mode-headless.js";
import { describeCodeModeNamespacesForPrompt } from "./code-mode-namespaces.js";
import {
  codeModeRuntimeTesting,
  isCodeModeEngagedForModel,
  readCode,
  readRunId,
  resolveCodeModeConfig,
  resolveCodeModeHeadlessConfig,
} from "./code-mode-runtime.js";
import { activeRuns, removeExpiredRuns, resumingRunIds } from "./code-mode-state.js";
import {
  normalizeCodeModeTimeoutResult,
  normalizeCodeModeWorkerResult,
  resolveCodeModeWorkerUrl,
  runCodeModeWorker,
  CodeModeHeadlessAbortError,
  CodeModeHeadlessTimeoutError,
} from "./code-mode-worker.js";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import { optionalStringEnum } from "./schema/typebox.js";
import type { ToolDefinition } from "./sessions/index.js";
import { resolveSwarmConfig } from "./swarm-config.js";
import { isDirectVisibleCatalogTool } from "./tool-search-catalog.js";
import { isSideEffectFreeToolSearchCall } from "./tool-search-telemetry.js";
import {
  addClientToolsToToolCatalog,
  applyToolCatalogCompaction,
  compactToolSearchCatalogEntry,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
  type ToolSearchCatalogEntry,
  type ToolSearchCatalogRef,
  type ToolSearchToolContext,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

export { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME };
export {
  CodeModeHeadlessAbortError,
  CodeModeHeadlessTimeoutError,
  isCodeModeEngagedForModel,
  runCodeModeScriptHeadless,
  resolveCodeModeConfig,
};
export type { CodeModeFailureCode, CodeModeHeadlessResult } from "./code-mode-runtime.js";

type CodeModeToolContext = ToolSearchToolContext;

const MAX_CODE_MODE_METHOD_INDEX_CHARS = 1_600;
const MAX_CODE_MODE_METHOD_INDEX_ENTRIES = 12;
const MAX_CODE_MODE_OUTPUT_HINT_CHARS = 96;
const CODE_MODE_DIRECT_METHOD_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const CODE_MODE_RESERVED_METHOD_NAMES = new Set([
  "search",
  "describe",
  "call",
  "callValue",
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
]);
const CODE_MODE_METHOD_INDEX_PRIORITY = new Map(
  ["read", "edit", "write", "apply_patch", "grep", "find", "ls"].map((name, index) => [
    name,
    index,
  ]),
);
const CODE_MODE_METHOD_INDEX_HEADING =
  "Enabled direct methods inside code (await calls; short declared outputs follow `->`):";

function codeModeMethodIndexFooter(included: number, total: number): string {
  const omitted = total - included;
  return omitted > 0
    ? `${omitted} more direct methods omitted. Discover them with ALL_TOOLS or tools.search(query).`
    : "";
}

function renderCodeModeMethodIndex(lines: readonly string[], total: number): string {
  const footer = codeModeMethodIndexFooter(lines.length, total);
  return [CODE_MODE_METHOD_INDEX_HEADING, ...lines, ...(footer ? ["", footer] : [])].join("\n");
}

function collectCodeModeDirectCatalogEntries(
  catalog: readonly ToolSearchCatalogEntry[],
): ToolSearchCatalogEntry[] {
  const nameCounts = new Map<string, number>();
  for (const entry of catalog) {
    if (!CODE_MODE_DIRECT_METHOD_PATTERN.test(entry.name)) {
      continue;
    }
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }
  return catalog.filter(
    (entry) =>
      entry.source === "openclaw" &&
      nameCounts.get(entry.name) === 1 &&
      !CODE_MODE_RESERVED_METHOD_NAMES.has(entry.name),
  );
}

export function collectCodeModeDirectToolNames(
  catalog: readonly ToolSearchCatalogEntry[],
): Set<string> {
  return new Set(collectCodeModeDirectCatalogEntries(catalog).map((entry) => entry.name));
}

export function collectCodeModeDirectToolSchemas(
  catalog: readonly ToolSearchCatalogEntry[],
): Map<string, unknown> {
  return new Map(
    collectCodeModeDirectCatalogEntries(catalog)
      .filter((entry) => entry.parameters !== undefined)
      .map((entry) => [entry.name, entry.parameters]),
  );
}

function formatCodeModeMethodIndex(catalog: readonly ToolSearchCatalogEntry[]): string {
  const allLines = collectCodeModeDirectCatalogEntries(catalog)
    .map((entry) => compactToolSearchCatalogEntry(entry))
    .map((entry) => {
      const input = entry.input && entry.input !== "unknown" ? entry.input : "input?: unknown";
      const output =
        entry.output && entry.output.length <= MAX_CODE_MODE_OUTPUT_HINT_CHARS
          ? ` -> ${entry.output}`
          : "";
      return {
        line: `- tools.${entry.name}(${input})${output}`,
        name: entry.name,
      };
    })
    // Keep the core coding workflow visible before filling the remaining prompt
    // budget with short signatures. Small models cannot reliably discover a
    // requested method after prompt compaction has hidden it.
    .toSorted((a, b) => {
      const aPriority = CODE_MODE_METHOD_INDEX_PRIORITY.get(a.name);
      const bPriority = CODE_MODE_METHOD_INDEX_PRIORITY.get(b.name);
      if (aPriority !== undefined || bPriority !== undefined) {
        return (
          (aPriority ?? CODE_MODE_METHOD_INDEX_PRIORITY.size) -
          (bPriority ?? CODE_MODE_METHOD_INDEX_PRIORITY.size)
        );
      }
      return a.line.length - b.line.length || a.name.localeCompare(b.name);
    });
  const lines = allLines.slice(0, MAX_CODE_MODE_METHOD_INDEX_ENTRIES).map((entry) => entry.line);
  if (lines.length === 0) {
    return "";
  }
  const fullIndex = renderCodeModeMethodIndex(lines, allLines.length);
  if (fullIndex.length <= MAX_CODE_MODE_METHOD_INDEX_CHARS) {
    return fullIndex;
  }

  // Keep the signature budget deterministic while skipping pathological lines.
  // Every omitted method remains available on `tools` and discoverable at runtime.
  const included: string[] = [];
  let includedLineLength = 0;
  for (const line of lines) {
    const candidateLineLength = includedLineLength + 1 + line.length;
    const candidateLength =
      CODE_MODE_METHOD_INDEX_HEADING.length +
      candidateLineLength +
      2 +
      codeModeMethodIndexFooter(included.length + 1, allLines.length).length;
    if (candidateLength <= MAX_CODE_MODE_METHOD_INDEX_CHARS) {
      included.push(line);
      includedLineLength = candidateLineLength;
    }
  }
  return renderCodeModeMethodIndex(included, allLines.length);
}

function filterReadOnlyCodeModeCatalog(
  catalog: readonly ToolSearchCatalogEntry[],
): ToolSearchCatalogEntry[] {
  // Recovery execution admits only the audited replay-safe core surface.
  // Keep the prompt on that same boundary so models never see unavailable
  // mutation, plugin, client, or MCP methods during verification.
  return catalog.filter(
    (entry) => entry.sourceName === "core" && isSideEffectFreeToolSearchCall(entry, {}),
  );
}

function createCodeModeExecDescription(
  ctx: CodeModeToolContext,
  catalog?: readonly ToolSearchCatalogEntry[],
): string {
  const directMethodNames = catalog ? collectCodeModeDirectToolNames(catalog) : new Set<string>();
  const hasRead = directMethodNames.has("read");
  const hasWrite = directMethodNames.has("write");
  const hasEdit = directMethodNames.has("edit");
  const namespacePrompt = describeCodeModeNamespacesForPrompt(catalog);
  // A known run catalog with neither MCP nor swarm has no virtual API files.
  const catalogKnown = catalog !== undefined;
  const hasMcp = catalog?.some((entry) => entry.source === "mcp") ?? false;
  const swarmEnabled = resolveSwarmConfig(ctx.runtimeConfig ?? ctx.config, ctx.agentId).enabled;
  const apiGuidance =
    !catalogKnown || hasMcp || swarmEnabled
      ? " Read TypeScript-style declaration files with `API.list(prefix?)` and `API.read(path)`."
      : "";
  const mcpGuidance =
    !catalogKnown || hasMcp ? " MCP tools are available only through the `MCP` namespace." : "";
  const swarmGuidance = swarmEnabled
    ? " Swarm globals `agents.run`, `phase`, and `log` are available; read `agents.d.ts` for types and orchestration idioms."
    : "";
  const nodesGuidance =
    !catalogKnown || catalog.some((entry) => entry.name === "nodes")
      ? "\n- nodes: paired Gateway nodes; nodes.list(), (await nodes.get(id)).invoke(command, params)\n"
      : "";
  const skillsGuidance = ctx.codeModeSkills?.length
    ? " Skills are available through the async `skills` global: use `await skills.list()` and `await skills.read(name)`."
    : "";
  const readOnlyGuidance =
    ctx.forceReadOnlyTools === true
      ? " This is a read-only recovery after a prior mutation may have completed. Do not call write, edit, apply_patch, or any unavailable method; inspect the existing state and return the requested answer."
      : "";
  const methodIndex = catalog ? formatCodeModeMethodIndex(catalog) : "";
  const writeVerificationGuidance =
    hasRead && hasWrite ? " For write verification, include write and read in one cell." : "";
  const editGuidance = hasEdit
    ? ' If the user asks for an edit or exact replacement, `tools.edit` is mandatory: use `await tools.edit({ path: "file.txt", edits: [{ oldText: "old", newText: "new" }] })`; `oldText` is the exact text being removed and `newText` is its replacement; never substitute `tools.write`.'
    : "";
  const readGuidance = hasRead
    ? ' Read files with `await tools.read({ path: "notes.txt" })`. For multiple files, call every read in the same exec before answering.'
    : "";
  return (
    "Use only injected Code Mode globals; Node.js modules, shell, `require`, `import`, `process`, and `fs` are unavailable. A requested verification is incomplete until its verification tool call runs; knowing the value is not verification." +
    writeVerificationGuidance +
    editGuidance +
    readGuidance +
    " Text results expose `.content`, string methods, and `.field(name)` for `key=value` or `key: value`. For a named key's value, call `.field()` with that exact key and use its result; never use the key name as the value. Sandboxed `console` writes tool output. Explicitly `return` the final value; a trailing guest tool call or local result expression is auto-returned. Prefer enabled direct methods on `tools`. Use the requested workspace-relative path exactly; never add `state/workspaces` or `/workspace` prefixes. Await dependent calls in order; use `Promise.all` only for independent work. If a direct method is unavailable, use ALL_TOOLS or `await tools.search(query)`, then `tools.callValue(id, args)`. Never invent or transform ids. Return unknown result shapes raw. Nested calls keep normal policy and approvals." +
    apiGuidance +
    mcpGuidance +
    swarmGuidance +
    nodesGuidance +
    skillsGuidance +
    readOnlyGuidance +
    (namespacePrompt ? `\n\n${namespacePrompt}` : "") +
    (methodIndex ? `\n\n${methodIndex}` : "")
  );
}

function createCodeModeCodeDescription(
  catalog?: readonly ToolSearchCatalogEntry[],
  forceReadOnlyTools = false,
): string {
  const directMethodNames = catalog ? collectCodeModeDirectToolNames(catalog) : new Set<string>();
  const editExample = directMethodNames.has("edit")
    ? ' Asked to edit: await tools.edit({path:"file.txt",edits:[{oldText:"exact old",newText:"exact new"}]}); oldText is removed, newText replaces it; never use write.'
    : "";
  const multiReadExample = directMethodNames.has("read")
    ? ' Multiple reads: const a=await tools.read({path:"first.txt"}); const b=await tools.read({path:"second.txt"});'
    : "";
  if (forceReadOnlyTools) {
    return `Read-only recovery: a prior mutation may already have completed. Do not repeat mutations or call write/edit/apply_patch or any missing method. Use available read-only tools to verify existing state, then return the exact requested answer.${multiReadExample} For named text fields use r.field("requested_key"); preserve the string exactly. Replace every example path/key with the exact user request. No imports/process/fs.`;
  }
  if (directMethodNames.has("read") && directMethodNames.has("write")) {
    return `Obey every step in one exec.${editExample}${multiReadExample} If the prompt asks to verify or read back after a write/edit, code ending at the mutation is invalid; finish with the requested read and confirm the requested state. Read -> write -> verify: const source=await tools.read({path:"input.txt"}); const value=source.field("requested_key"); await tools.write({path:"output.txt",content:value}); return (await tools.read({path:"output.txt"})).content; field() returns a string: preserve it exactly and do not use Number/parseInt/parseFloat unless numeric conversion was requested. Use the extracted value, never the key name. Replace every example path/key with the exact user request. No imports/process/fs.`;
  }
  if (directMethodNames.has("read")) {
    return `Obey every step in one exec.${multiReadExample} Return raw content or call r.field("requested_key"); replace every example path/key with the exact user request. No imports/process/fs.`;
  }
  return "Obey every step with enabled tools. Await calls; return the final value. No imports/process/fs.";
}

function setCodeModeCodeDescription(
  tool: AnyAgentTool,
  catalog?: readonly ToolSearchCatalogEntry[],
  forceReadOnlyTools = false,
): void {
  const parameters = tool.parameters as {
    properties?: { code?: { description?: string } };
  };
  if (parameters.properties?.code) {
    parameters.properties.code.description = createCodeModeCodeDescription(
      catalog,
      forceReadOnlyTools,
    );
  }
}

export function createCodeModeTools(ctx: CodeModeToolContext): AnyAgentTool[] {
  const execTool = markCodeModeControlTool({
    name: CODE_MODE_EXEC_TOOL_NAME,
    label: "exec",
    description: createCodeModeExecDescription(ctx),
    parameters: Type.Object({
      // `command` and `restartSafe` stay runtime-only for hook compatibility.
      // Replay safety is host policy, not a property models should self-certify.
      code: Type.String({
        description: createCodeModeCodeDescription(undefined, ctx.forceReadOnlyTools === true),
      }),
      language: optionalStringEnum(["javascript", "typescript"] as const, {
        description: "Defaults to javascript.",
      }),
    }),
    execute: async (
      toolCallId: string,
      args: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) => {
      const input = readCode(args);
      const executionContext = getAgentToolExecutionContext();
      return jsonResult(
        normalizeCodeModeTimeoutResult(
          await runExec({
            toolCallId,
            ctx,
            code: input.code,
            assistantTurnId:
              executionContext?.assistantMessage.responseId?.trim() ||
              executionContext?.assistantMessage.turnId?.trim(),
            language: input.language,
            restartSafe:
              ctx.forceRestartSafeTools === true ||
              ctx.forceReadOnlyTools === true ||
              input.restartSafe,
            readOnly: ctx.forceReadOnlyTools === true,
            signal,
            onUpdate,
          }),
        ),
      );
    },
  } as AnyAgentTool);
  const waitTool = markCodeModeControlTool({
    name: CODE_MODE_WAIT_TOOL_NAME,
    label: "wait",
    hideFromChannelProgress: true,
    description: "Resume a suspended OpenClaw code mode run returned by exec.",
    parameters: Type.Object({
      runId: Type.String({ description: "Code mode run id returned by exec." }),
    }),
    execute: async (
      toolCallId: string,
      args: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) =>
      jsonResult(
        normalizeCodeModeTimeoutResult(
          await runWait({
            toolCallId,
            ctx,
            runId: readRunId(args),
            requireRestartSafe:
              ctx.forceRestartSafeTools === true || ctx.forceReadOnlyTools === true,
            requireReadOnly: ctx.forceReadOnlyTools === true,
            signal,
            onUpdate,
          }),
        ),
      ),
  } as AnyAgentTool);
  return [execTool, waitTool];
}

/** Compact normal tools behind Code Mode exec/wait controls. */
export function applyCodeModeCatalog(params: {
  tools: AnyAgentTool[];
  config?: OpenClawConfig;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
  toolHookContext?: HookContext;
  directToolNames?: Iterable<string>;
  codeModeSkills?: CodeModeToolContext["codeModeSkills"];
  forceEnabled?: boolean;
  forceReadOnlyTools?: boolean;
}) {
  const config = resolveCodeModeConfig(params.config, params.agentId);
  // Engagement (including "auto" per-model resolution) is decided by the run
  // gates before this is called; only a hard `false` may disable compaction.
  if (config.enabled === false && params.forceEnabled !== true) {
    return applyToolCatalogCompaction({
      ...params,
      enabled: false,
      isVisibleControlTool: isCodeModeControlTool,
    });
  }
  const tools = params.tools.filter(
    (tool) =>
      isCodeModeControlTool(tool) ||
      (tool.name !== TOOL_SEARCH_CODE_MODE_TOOL_NAME &&
        tool.name !== TOOL_SEARCH_RAW_TOOL_NAME &&
        tool.name !== TOOL_DESCRIBE_RAW_TOOL_NAME &&
        tool.name !== TOOL_CALL_RAW_TOOL_NAME),
  );
  const directToolNames = new Set(params.directToolNames);
  const compacted = applyToolCatalogCompaction({
    ...params,
    tools,
    enabled: true,
    isVisibleControlTool: isCodeModeControlTool,
    isVisibleCatalogTool: (tool) =>
      params.forceReadOnlyTools !== true &&
      directToolNames.has(tool.name) &&
      isDirectVisibleCatalogTool(tool, directToolNames),
    shouldCatalogTool: (tool) => !isCodeModeControlTool(tool),
  });
  // Only the catalog ref reflects the freshly compacted run catalog. Without it
  // the real catalog is registered under session keys and resolved later, so
  // keep the catalog "unknown" (undefined) rather than an empty array that would
  // wrongly strip MCP/namespace guidance from the exec description.
  const catalog = params.catalogRef?.current?.entries;
  const visibleCatalog =
    catalog && params.forceReadOnlyTools ? filterReadOnlyCodeModeCatalog(catalog) : catalog;
  for (const tool of compacted.tools) {
    if (tool.name === CODE_MODE_EXEC_TOOL_NAME) {
      tool.description = createCodeModeExecDescription(
        {
          config: params.config,
          runtimeConfig: params.config,
          agentId: params.agentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          runId: params.runId,
          catalogRef: params.catalogRef,
          codeModeSkills: params.codeModeSkills,
          forceReadOnlyTools: params.forceReadOnlyTools,
        },
        visibleCatalog,
      );
      setCodeModeCodeDescription(tool, visibleCatalog, params.forceReadOnlyTools === true);
    }
  }
  return compacted;
}

/** Move client-side tool definitions into the active Code Mode catalog. */
export function addClientToolsToCodeModeCatalog(params: {
  tools: ToolDefinition[];
  config?: OpenClawConfig;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  runId?: string;
  catalogRef?: ToolSearchCatalogRef;
}) {
  return addClientToolsToToolCatalog({
    ...params,
    // Callers gate on run engagement; "auto" counts as enabled here.
    enabled: resolveCodeModeConfig(params.config, params.agentId).enabled !== false,
  });
}

/** Test-only hooks and state accessors for Code Mode worker orchestration. */
const testing = {
  activeRuns,
  resumingRunIds,
  codeModeReplayIdForToolCall,
  removeExpiredRuns,
  runBridgeRequest,
  createHeadlessAbortScope,
  normalizeCodeModeWorkerResult,
  runCodeModeWorker,
  resolveCodeModeHeadlessConfig,
  resolveCodeModeWorkerUrl,
  getTypescriptRuntimePromise: codeModeRuntimeTesting.getTypescriptRuntimePromise,
  setTypescriptRuntimeForTest: codeModeRuntimeTesting.setTypescriptRuntimeForTest,
  setSwarmDepsForTest: setCodeModeSwarmDepsForTest,
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.codeModeTestApi")] = testing;
}
