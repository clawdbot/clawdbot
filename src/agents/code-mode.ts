/**
 * Host-side Code Mode controller for isolated QuickJS execution with bridged
 * tool search/call/yield support.
 */
import { Type } from "typebox";
import { getAgentToolExecutionContext } from "../../packages/agent-core/src/tool-execution-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import {
  beginCodeModeControlActivity,
  ensureCodeModeActivityOwner,
  type CodeModeActivityContext,
} from "./code-mode-activity.js";
import {
  codeModeReplayIdForToolCall,
  runBridgeRequest,
  setCodeModeSwarmDepsForTest,
} from "./code-mode-bridge.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  isCodeModeExecControlTool,
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
  ensureCodeModeStats,
  recordCodeModeControlCall,
  recordCodeModeOutcome,
} from "./code-mode-stats.js";
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
import { formatToolSearchControlResult, type ToolSearchRuntime } from "./tool-search-runtime.js";
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
import type { AnyAgentTool } from "./tools/common.js";

export { CODE_MODE_EXEC_TOOL_NAME, CODE_MODE_WAIT_TOOL_NAME };
export {
  CodeModeHeadlessAbortError,
  CodeModeHeadlessTimeoutError,
  isCodeModeEngagedForModel,
  runCodeModeScriptHeadless,
  resolveCodeModeConfig,
};
export type { CodeModeFailureCode, CodeModeHeadlessResult } from "./code-mode-runtime.js";

type CodeModeToolContext = ToolSearchToolContext & CodeModeActivityContext;

const MAX_CODE_MODE_CATALOG_INDEX_CHARS = 8_000;

const CODE_MODE_CATALOG_INDEX_HEADING = [
  "OpenClaw/plugin tool quick index (exact ids; descriptions are intentionally deferred):",
  "Each line is `id input -> output`; `-> ?` means unknown.",
  "OUTPUT DECLARED RULE: use declared fields for deterministic transforms and dependent calls; `tools.search` catalog lookup stays inline. Stable IDs supplied by the request/trusted prior context may flow into a dependent mutation. List-derived conversation IDs require one complete owner snapshot and one unique exact normalized address; singleton output alone is insufficient. Return candidates/evidence when target identity remains ambiguous.",
  "AUTHORITY RULE: normal tool policy authorizes mutation; return incomplete, duplicate, stale, or conflicting target evidence before mutation.",
  "OUTPUT UNKNOWN RULE: unknown output shape is schema ambiguity; return the raw tool value unchanged, then inspect or map it in a later exec.",
].join("\n");

function codeModeCatalogIndexFooter(included: number, total: number): string {
  const omitted = total - included;
  return omitted > 0
    ? `${omitted} additional OpenClaw/plugin tools omitted from this prompt index. Use ALL_TOOLS or tools.search inside exec to find them.`
    : "Use these exact ids with tools.callValue; use ALL_TOOLS or tools.search inside exec when lookup is ambiguous.";
}

function renderCodeModeCatalogIndex(lines: readonly string[], total: number): string {
  return [
    CODE_MODE_CATALOG_INDEX_HEADING,
    ...lines,
    "",
    codeModeCatalogIndexFooter(lines.length, total),
  ].join("\n");
}

function formatCodeModeCatalogIndex(catalog: readonly ToolSearchCatalogEntry[]): string {
  const lines = catalog
    .filter((entry) => entry.source === "openclaw")
    .map((entry) => compactToolSearchCatalogEntry(entry))
    // Declared-output entries sort first so byte truncation drops `-> ?`
    // lines, which stay fully discoverable through ALL_TOOLS, before it drops
    // contracts the model can one-pass on. Deterministic within each tier.
    .toSorted((a, b) => (a.output ? 0 : 1) - (b.output ? 0 : 1) || a.id.localeCompare(b.id))
    .map(
      (entry) =>
        `- ${JSON.stringify(entry.id)} ${entry.input ?? "unknown"} -> ${entry.output ?? "?"}`,
    );
  if (lines.length === 0) {
    return "";
  }
  const fullIndex = renderCodeModeCatalogIndex(lines, lines.length);
  if (fullIndex.length <= MAX_CODE_MODE_CATALOG_INDEX_CHARS) {
    return fullIndex;
  }

  // Greedily pack lines in the deterministic sorted order, skipping any single
  // line too large to fit rather than dropping the whole tail after it. A prefix
  // cut let one oversized entry — a pathological plugin id or input hint — blank
  // the entire index; skipping it keeps every other declared contract visible
  // and fits more of them when the declared tier alone overflows. Skipped
  // entries stay discoverable through ALL_TOOLS, and the stable input order
  // keeps prompt bytes deterministic for provider caches.
  const included: string[] = [];
  let includedLineLength = 0;
  for (const line of lines) {
    const candidateLineLength = includedLineLength + 1 + line.length;
    const candidateLength =
      CODE_MODE_CATALOG_INDEX_HEADING.length +
      candidateLineLength +
      2 +
      codeModeCatalogIndexFooter(included.length + 1, lines.length).length;
    if (candidateLength <= MAX_CODE_MODE_CATALOG_INDEX_CHARS) {
      included.push(line);
      includedLineLength = candidateLineLength;
    }
  }
  return renderCodeModeCatalogIndex(included, lines.length);
}

function createCodeModeExecDescription(
  ctx: CodeModeToolContext,
  catalog?: readonly ToolSearchCatalogEntry[],
): string {
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
  const restartRecoveryGuidance =
    swarmEnabled && ctx.forceRestartSafeTools
      ? " Restart recovery cannot resume `agents.run`. Do not call it: cold recovery cannot reattach a prior collector or launch a replacement."
      : "";
  const nodesGuidance =
    "\n- nodes: paired Gateway nodes; nodes.list(), (await nodes.get(id)).invoke(command, params)\n";
  const skillsGuidance = ctx.codeModeSkills?.length
    ? " Skills are available through the async `skills` global: use `await skills.list()` and `await skills.read(name)`."
    : "";
  const catalogIndex = catalog ? formatCodeModeCatalogIndex(catalog) : "";
  return (
    "Run JavaScript or TypeScript in OpenClaw Code Mode. `return` sets final value; otherwise `null`. Quick-index arrows are output hints; `-> ?` marks unknown output. Declared fields support deterministic one-cell composition; `tools.search` catalog lookup stays inline. Stable target IDs from the request or trusted prior context may feed a dependent mutation. List-derived conversation IDs require a complete owner snapshot and one unique normalized address; singleton output is insufficient. Return incomplete, duplicate, stale, or conflicting target evidence before mutation. Compose dependent calls in order; parallelize independent work. Unknown output stays raw for observation; transform it later. Nested calls enforce normal policy and approvals. `ALL_TOOLS` is the complete compact catalog. Select exact IDs with `tools.search(query: string, options?)`; use `tools.describe(id: string)` when needed and keep IDs unchanged. `tools.callValue(id: string, args?)` returns JSON; `tools.call(id: string, args?)` preserves `{ tool, result }`. Use enabled catalog tools for shell, file, network, and external actions; raw shell commands and Node.js `require`/`import` are unavailable." +
    apiGuidance +
    mcpGuidance +
    swarmGuidance +
    restartRecoveryGuidance +
    nodesGuidance +
    skillsGuidance +
    ' The `language` field selects "javascript" or "typescript".' +
    (namespacePrompt ? `\n\n${namespacePrompt}` : "") +
    (catalogIndex ? `\n\n${catalogIndex}` : "")
  );
}

export function createCodeModeTools(ctx: CodeModeToolContext): AnyAgentTool[] {
  const ownedCtx = ensureCodeModeActivityOwner(ctx);
  const execTool = markCodeModeControlTool({
    name: CODE_MODE_EXEC_TOOL_NAME,
    label: "exec",
    description: createCodeModeExecDescription(ownedCtx),
    parameters: Type.Object({
      // `command` stays runtime-only for hook compatibility. Requiring the sole
      // model-facing field prevents schema-valid empty calls from constrained models.
      code: Type.String({
        description:
          "Run JavaScript or TypeScript in OpenClaw Code Mode. `return` sets result; else `null`. Declared fields enable deterministic transforms/dependent calls; `tools.search` resolves catalog IDs inline. Stable target IDs from request/trusted prior context may feed a mutation. List-derived conversation IDs require one complete owner snapshot and one unique exact normalized address; return incomplete, duplicate, stale, or conflicting evidence. `-> ?`: return raw, inspect later. Use exact enabled catalog tools for shell/file/network/external actions; raw shell commands and Node `require`/`import` are unavailable.",
      }),
      language: optionalStringEnum(["javascript", "typescript"] as const, {
        description:
          'Source language. Must be "javascript" or "typescript". Defaults to javascript.',
      }),
    }),
    execute: async (
      toolCallId: string,
      args: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) => {
      const stats = ensureCodeModeStats(ownedCtx.catalogRef);
      recordCodeModeControlCall(stats, "exec");
      const releaseActivity = beginCodeModeControlActivity(ownedCtx.codeModeActivityOwner);
      let outcome: "completed" | "waiting" | "failed" | "aborted" = "failed";
      try {
        const input = readCode(args);
        const executionContext = getAgentToolExecutionContext();
        let runtime: ToolSearchRuntime | undefined;
        const result = normalizeCodeModeTimeoutResult(
          await runExec({
            toolCallId,
            ctx: ownedCtx,
            code: input.code,
            assistantTurnId:
              executionContext?.assistantMessage.responseId?.trim() ||
              executionContext?.assistantMessage.turnId?.trim(),
            language: input.language,
            enforceReplaySafeTools: ownedCtx.forceRestartSafeTools === true,
            signal,
            onUpdate,
            onRuntime: (value) => {
              runtime = value;
            },
          }),
        );
        outcome =
          result.status === "failed" && result.code === "aborted" ? "aborted" : result.status;
        return formatToolSearchControlResult(result, runtime);
      } finally {
        releaseActivity();
        recordCodeModeOutcome(stats, outcome);
      }
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
    ) => {
      const stats = ensureCodeModeStats(ownedCtx.catalogRef);
      recordCodeModeControlCall(stats, "wait");
      const releaseActivity = beginCodeModeControlActivity(ownedCtx.codeModeActivityOwner);
      let outcome: "completed" | "waiting" | "failed" | "aborted" = "failed";
      try {
        let runtime: ToolSearchRuntime | undefined;
        const result = normalizeCodeModeTimeoutResult(
          await runWait({
            toolCallId,
            ctx: ownedCtx,
            runId: readRunId(args),
            signal,
            onUpdate,
            onRuntime: (value) => {
              runtime = value;
            },
          }),
        );
        outcome =
          result.status === "failed" && result.code === "aborted" ? "aborted" : result.status;
        return formatToolSearchControlResult(result, runtime);
      } finally {
        releaseActivity();
        recordCodeModeOutcome(stats, outcome);
      }
    },
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
    // Code mode never exposes core shell/file tools just because structured
    // search does; only explicitly required, trusted direct tools may remain.
    isVisibleCatalogTool: (tool) =>
      directToolNames.has(tool.name) && isDirectVisibleCatalogTool(tool, directToolNames),
    shouldCatalogTool: (tool) => !isCodeModeControlTool(tool),
  });
  // Only the catalog ref reflects the freshly compacted run catalog. Without it
  // the real catalog is registered under session keys and resolved later, so
  // keep the catalog "unknown" (undefined) rather than an empty array that would
  // wrongly strip MCP/namespace guidance from the exec description.
  const visibleCatalog = params.catalogRef?.current?.entries;
  for (const tool of compacted.tools) {
    if (isCodeModeExecControlTool(tool)) {
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
        },
        visibleCatalog,
      );
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
