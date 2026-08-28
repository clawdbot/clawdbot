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
  createCodeModeCatalogProjection,
  type CodeModeCatalogBinding,
} from "./code-mode-catalog.js";
import {
  CODE_MODE_EXEC_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  createCodeModeExecDescriptionUpdater,
  isCodeModeControlTool,
  markCodeModeControlTool,
} from "./code-mode-control-tools.js";
import { runCodeModeExec, runWait } from "./code-mode-execution.js";
import { runCodeModeScriptHeadless } from "./code-mode-headless.js";
import {
  createCodeModeNamespaceRuntime,
  describeCodeModeNamespacesForPrompt,
} from "./code-mode-namespaces.js";
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
  "Enabled async tool globals (descriptions are intentionally deferred):",
  "Each line is `callableName input -> output`; `-> ?` means unknown output.",
].join("\n");

function codeModeCatalogIndexFooter(included: number, total: number): string {
  const omitted = total - included;
  return omitted > 0
    ? `${omitted} additional tools omitted from this prompt index. Use catalog.search(query); results are callable.`
    : "Call these globals directly; use catalog.search(query) when lookup is ambiguous.";
}

function renderCodeModeCatalogIndex(lines: readonly string[], total: number): string {
  return [
    CODE_MODE_CATALOG_INDEX_HEADING,
    ...lines,
    "",
    codeModeCatalogIndexFooter(lines.length, total),
  ].join("\n");
}

function formatCodeModeCatalogIndex(bindings: readonly CodeModeCatalogBinding[]): string {
  const lines = bindings
    // Declared-output entries sort first so byte truncation drops `-> ?`
    // lines, which stay fully discoverable through catalog.search, before it drops
    // contracts the model can one-pass on. Deterministic within each tier.
    .toSorted(
      (a, b) =>
        (a.output ? 0 : 1) - (b.output ? 0 : 1) || a.callableName.localeCompare(b.callableName),
    )
    .map(
      (entry) => `- ${entry.callableName} ${entry.input ?? "unknown"} -> ${entry.output ?? "?"}`,
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
  // entries stay discoverable through catalog.search, and the stable input order
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
  const projection = catalog
    ? createCodeModeCatalogProjection(
        catalog.map((entry) => compactToolSearchCatalogEntry(entry)),
        {
          reservedNames: createCodeModeNamespaceRuntime(catalog).descriptors.map(
            (descriptor) => descriptor.globalName,
          ),
        },
      )
    : undefined;
  const catalogIndex = projection ? formatCodeModeCatalogIndex(projection.bindings) : "";
  return (
    `Run JavaScript or TypeScript in OpenClaw code mode. Enabled tools are async global functions listed in the quick index. Await dependent calls in order; independent calls may run with Promise.all. Declared output fields may feed later calls in the same program; do not spend another \`exec\` merely inspecting them. Return the final value; otherwise the result is \`null\`. \`-> ?\` means unknown output: do not feed it into guessed field-dependent logic in the same program. Return the raw value first, observe it, then use a later \`exec\` for dependent composition. If a tool is omitted from the bounded index, use \`catalog.search(query)\`; results are callable: \`const [tool] = await catalog.search("..."); return await tool({...});\`. Handles expose \`describe()\` when a schema is needed. \`setTimeout\` and \`clearTimeout\` work. Nested calls enforce normal tool policy and approvals. Tool failures are catchable JavaScript errors; otherwise, use a safe failed result to correct your code or choose another tool. If an action may have started, inspect its outcome without repeating mutations. Never replay actions that already ran. Nested results, output, and final value share ${maxOutputBytes} bytes; truncation reports omitted bytes and asks you to rerun with narrower args. Node.js modules and \`require\`/\`import\` are NOT available; use enabled globals for shell, file, network, or external actions.` +
    apiGuidance +
    mcpGuidance +
    swarmGuidance +
    nodesGuidance +
    skillsGuidance +
    ' The `language` field accepts only "javascript" or "typescript"; do not pass "bash", "shell", or other values.' +
    " The `code` field contains JavaScript or TypeScript, never a shell command. " +
    "For shell or file operations, call an enabled global from guest JavaScript; do not retry failed shell source." +
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
          'Required JS/TS; no Python, shell, `require`, or `import`. Use `return value`; a trailing expression yields `null`. Call enabled async globals directly; independent calls may use Promise.all. Declared output fields may feed later calls in the same program; do not spend another `exec` merely inspecting them. Unknown output (`-> ?`) cannot feed guessed dependent logic in the same program: return it raw, observe it, then use a later `exec`. For discovery, use `catalog.search(query)`: `const [tool] = await catalog.search("..."); return await tool({...});`.',
      }),
      language: optionalStringEnum(["javascript", "typescript"] as const, {
        description:
          'Source language. Must be "javascript" or "typescript". Defaults to javascript.',
      }),
      restartSafe: Type.Optional(
        Type.Boolean({
          description:
            "Do not set on a new exec. Set true only when OpenClaw explicitly requests replay after a gateway restart; never for write, edit, exec, or any mutation. True rejects unmarked or namespace surfaces.",
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
      return formatToolSearchControlResult(result, runtime, undefined, result.status);
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
      return formatToolSearchControlResult(result, runtime, undefined, result.status);
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
  const catalogRef = params.catalogRef;
  const execTool = compacted.tools.find((tool) => tool.name === CODE_MODE_EXEC_TOOL_NAME);
  if (catalogRef?.current && execTool) {
    // Refreshing descriptions replaces their observer, not the catalog's parked consumers.
    catalogRef.disposeObserver?.();
    const descriptionUpdater = createCodeModeExecDescriptionUpdater(execTool);
    catalogRef.disposeObserver = descriptionUpdater.dispose;
    catalogRef.onChange = () => {
      descriptionUpdater.update(
        createCodeModeExecDescription(
          { ...params, runtimeConfig: params.config },
          catalogRef.current?.entries,
        ),
      );
    };
    catalogRef.onChange();
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
