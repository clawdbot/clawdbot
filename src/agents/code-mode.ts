/**
 * Host-side Code Mode controller for isolated QuickJS execution with bridged
 * tool search/call/yield support.
 */
import { Type } from "typebox";
import { getAgentToolExecutionContext } from "../../packages/agent-core/src/tool-execution-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import { CODE_MODE_NODES_TOOL_ID } from "./code-mode-bridge.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  isCodeModeControlTool,
  markCodeModeControlTool,
} from "./code-mode-control-tools.js";
import { runCodeModeExec, runWait } from "./code-mode-execution.js";
import { runCodeModeScriptHeadless } from "./code-mode-headless.js";
import { describeCodeModeNamespacesForPrompt } from "./code-mode-namespaces.js";
import {
  isCodeModeEngagedForModel,
  readCode,
  readRunId,
  resolveCodeModeConfig,
} from "./code-mode-runtime.js";
import {
  normalizeCodeModeTimeoutResult,
  CodeModeHeadlessAbortError,
  CodeModeHeadlessTimeoutError,
} from "./code-mode-worker.js";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import { optionalStringEnum } from "./schema/typebox.js";
import type { ToolDefinition } from "./sessions/index.js";
import { resolveSwarmConfig } from "./subagents/swarm/swarm-config.js";
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

type CodeModeToolContext = ToolSearchToolContext;

const MAX_CODE_MODE_CATALOG_INDEX_CHARS = 8_000;

const CODE_MODE_CATALOG_INDEX_HEADING = [
  "OpenClaw/plugin tool quick index (exact ids; descriptions are intentionally deferred):",
  "Each line is `id input -> output`; `-> ?` means unknown.",
  "OUTPUT DECLARED RULE: use declared fields for dependent calls in the first exec.",
  "OUTPUT UNKNOWN RULE: return the raw tool value unchanged; inspect or map it only in a later exec.",
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
  // Nodes ride the owner-only core tool; advertising the namespace to a run
  // whose catalog cannot resolve it turns the hint into hallucination bait.
  const hasNodes = catalog?.some((entry) => entry.id === CODE_MODE_NODES_TOOL_ID) ?? false;
  const nodesGuidance =
    !catalogKnown || hasNodes
      ? "\n- nodes: paired Gateway nodes; nodes.list(), (await nodes.get(id)).invoke(command, params)\n"
      : "";
  const skillsGuidance = ctx.codeModeSkills?.length
    ? " Skills are available through the async `skills` global: use `await skills.list()` and `await skills.read(name)`."
    : "";
  const maxOutputBytes = resolveCodeModeConfig(
    ctx.runtimeConfig ?? ctx.config,
    ctx.agentId,
  ).maxOutputBytes;
  const catalogIndex = catalog ? formatCodeModeCatalogIndex(catalog) : "";
  return (
    `Run JavaScript or TypeScript in OpenClaw code mode. Use \`return\` to pass the final value back; otherwise the result is \`null\`. Quick-index arrows show trusted declared output hints; \`-> ?\` means never guess result field names. For declared fields, process them in the first exec; do not spend another exec inspecting them. Perform dependent reads, checks, and follow-up calls in order; parallelize independent work only. \`setTimeout\` and \`clearTimeout\` work. For an unknown output, including a final dependent call after declared-output calls, return the raw tool value unchanged; do not wrap it in the requested answer shape or guess fields; filter or map it only in a later exec. Nested calls enforce normal tool policy and approvals. Nested results, output, and final value share ${maxOutputBytes} bytes; truncation reports omitted bytes and asks you to rerun with narrower args. \`ALL_TOOLS\` is the complete compact catalog. Select exact ids with \`tools.search(query: string, options?)\`; use \`tools.describe(id: string)\` only when needed. Never invent or transform a tool id. \`tools.callValue(id: string, args?)\` returns its JSON value directly; \`tools.call(id: string, args?)\` preserves \`{ tool, result }\`. \`const hit = ALL_TOOLS.find((entry) => entry.description.includes('weather')) ?? (await tools.search('weather'))[0]; return await tools.callValue(hit.id, {});\`. Node.js modules and \`require\`/\`import\` are NOT available; use enabled catalog tools allowed by policy for shell, file, network, or external actions.` +
    apiGuidance +
    mcpGuidance +
    swarmGuidance +
    nodesGuidance +
    skillsGuidance +
    ' The `language` field accepts only "javascript" or "typescript"; do not pass "bash", "shell", or other values.' +
    " The `code` field contains JavaScript or TypeScript, never a shell command. " +
    "For shell or file operations, call the exact catalog tool from guest JavaScript; do not retry failed shell source." +
    (namespacePrompt ? `\n\n${namespacePrompt}` : "") +
    (catalogIndex ? `\n\n${catalogIndex}` : "")
  );
}

export function createCodeModeTools(ctx: CodeModeToolContext): AnyAgentTool[] {
  const execTool = markCodeModeControlTool({
    name: CODE_MODE_EXEC_TOOL_NAME,
    label: "exec",
    description: createCodeModeExecDescription(ctx),
    parameters: Type.Object({
      // `command` stays runtime-only for hook compatibility. Requiring the sole
      // model-facing field prevents schema-valid empty calls from constrained models.
      code: Type.String({
        description:
          'Required JS/TS; no Python, shell, `require`, `import`. Use explicit `return value`; a trailing expression is discarded and yields `null`. Use `callValue`, not `call`, for data; `call` wraps it under `.result`. Core text reads: `{kind:"text",content:string}`; use `.content`. Unknown format: return it first, then parse it in a later exec; never guess separators. Example: `const file=await tools.callValue("openclaw:core:read", { path: "notes.txt" }); if(file.kind!=="text") return file; return file.content;`. Use exact ids from `ALL_TOOLS` or `tools.search(query)`; never invent ids or parallelize dependent calls.',
      }),
      language: optionalStringEnum(["javascript", "typescript"] as const, {
        description:
          'Source language. Must be "javascript" or "typescript". Defaults to javascript.',
      }),
      restartSafe: Type.Optional(
        Type.Boolean({
          description:
            "Set true only when every catalog call is explicitly replay-safe and OpenClaw may reconstruct the work after a gateway restart. Leave unset for ordinary calls; true rejects unmarked or namespace tool surfaces not proven replay-safe.",
        }),
      ),
    }),
    execute: async (
      toolCallId: string,
      args: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) => {
      const input = readCode(args);
      const executionContext = getAgentToolExecutionContext();
      let runtime: ToolSearchRuntime | undefined;
      const result = normalizeCodeModeTimeoutResult(
        await runCodeModeExec({
          toolCallId,
          ctx,
          code: input.code,
          assistantTurnId:
            executionContext?.assistantMessage.responseId?.trim() ||
            executionContext?.assistantMessage.turnId?.trim(),
          language: input.language,
          restartSafe: ctx.forceRestartSafeTools === true || input.restartSafe,
          signal,
          onUpdate,
          onRuntime: (value) => {
            runtime = value;
          },
        }),
      );
      return formatToolSearchControlResult(result, runtime);
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
      let runtime: ToolSearchRuntime | undefined;
      const result = normalizeCodeModeTimeoutResult(
        await runWait({
          toolCallId,
          ctx,
          runId: readRunId(args),
          signal,
          onUpdate,
          onRuntime: (value) => {
            runtime = value;
          },
        }),
      );
      return formatToolSearchControlResult(result, runtime);
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
