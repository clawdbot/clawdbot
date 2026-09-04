import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { NODE_FS_LIST_DIR_COMMAND } from "../infra/node-commands.js";
import { createLazyRuntimeNamedExport } from "../shared/lazy-runtime.js";
import { parseNodeList } from "../shared/node-list-parse.js";
import type { NodeListNode } from "../shared/node-list-types.js";
import { resolveEligibleNodeFromList } from "../shared/node-resolve.js";
import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";
import { redactCodeModeCatalogIds, type CodeModeCatalogProjection } from "./code-mode-catalog.js";
import { boundCodeModeError, boundCodeModeValue } from "./code-mode-json.js";
import type { CodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import type { PendingBridgeRequest, SettledBridgeRequest } from "./code-mode-runtime.js";
import { readCodeModeSkill } from "./code-mode-skills.js";
import { consumeMcpCodeModeGuestResult } from "./mcp-content.js";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import { isCollectorSpawnTool } from "./subagents/swarm/swarm-collector-capability.js";
import { resolveSwarmConfig } from "./subagents/swarm/swarm-config.js";
import {
  consumeToolEffectReceipt,
  registerToolEffectReceipt,
  type ToolEffectReceipt,
} from "./tool-effect-receipt.js";
import { isToolExecutionAllowed, TOOL_EXECUTION_GATED_MESSAGE } from "./tool-policy-shared.js";
import {
  consumeTrustedToolNoStartError,
  registerTrustedToolNoStartError,
} from "./tool-result-error.js";
import type { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { ToolSearchCatalogEntry, ToolSearchToolContext } from "./tool-search-types.js";
import { ToolInputError } from "./tools/common.js";

const loadSwarmHandlers = createLazyRuntimeNamedExport(
  () => import("./code-mode-swarm.runtime.js"),
  "codeModeSwarmHandlers",
);

export const CODE_MODE_NODES_TOOL_ID = "openclaw:core:nodes";

type CodeModeNode = {
  id: string;
  name: string;
  platform?: string;
  connected: boolean;
  commands: string[];
};

function projectCodeModeNode(node: NodeListNode): CodeModeNode {
  return {
    id: node.nodeId,
    name: node.displayName?.trim() || node.nodeId,
    ...(node.platform ? { platform: node.platform } : {}),
    connected: node.connected === true,
    commands: Array.isArray(node.commands)
      ? node.commands.filter((command): command is string => typeof command === "string")
      : [],
  };
}

async function callNodesTool(params: {
  runtime: ToolSearchRuntime;
  parentToolCallId: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
  input: Record<string, unknown>;
}): Promise<unknown> {
  return await params.runtime.callValue(CODE_MODE_NODES_TOOL_ID, params.input, {
    includeMcp: false,
    parentToolCallId: params.parentToolCallId,
    signal: params.signal,
    onUpdate: params.onUpdate,
    recoverySurface: "catalog",
  });
}

async function listCodeModeNodes(params: {
  runtime: ToolSearchRuntime;
  parentToolCallId: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}): Promise<NodeListNode[]> {
  return parseNodeList(
    await callNodesTool({
      ...params,
      input: { action: "status" },
    }),
  );
}

async function runNodesBridge(params: {
  runtime: ToolSearchRuntime;
  parentToolCallId: string;
  request: PendingBridgeRequest;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}): Promise<unknown> {
  const values = params.request.args;
  const action = values[0];
  if (action === "list") {
    return (await listCodeModeNodes(params))
      .filter((node) => node.paired === true)
      .map(projectCodeModeNode);
  }
  if (action === "get") {
    const query = values[1];
    if (typeof query !== "string" || !query.trim()) {
      throw new ToolInputError("nodes.get id or name must be a non-empty string.");
    }
    const node = resolveEligibleNodeFromList(
      await listCodeModeNodes(params),
      query,
      (candidate) => candidate.paired === true,
      {
        ineligibleExact: (id, eligibleIds) =>
          `node "${id}" is not paired (paired node ids: ${eligibleIds})`,
        nameResolveFailed: (reason, eligibleIds) => `${reason} (paired node ids: ${eligibleIds})`,
        noneEligible: () => "no paired nodes",
        multipleEligible: (eligible) =>
          `multiple nodes paired: ${eligible
            .map((candidate) => candidate.nodeId)
            .toSorted()
            .join(", ")}`,
      },
    );
    const projected = projectCodeModeNode(node);
    return {
      id: projected.id,
      name: projected.name,
      ...(projected.commands.includes(NODE_FS_LIST_DIR_COMMAND)
        ? { listDirCommand: NODE_FS_LIST_DIR_COMMAND }
        : {}),
    };
  }
  if (action === "invoke") {
    const node = values[1];
    const command = values[2];
    if (typeof node !== "string" || !node.trim()) {
      throw new ToolInputError("nodes.invoke node id must be a non-empty string.");
    }
    if (typeof command !== "string" || !command.trim()) {
      throw new ToolInputError("nodes.invoke command must be a non-empty string.");
    }
    return await callNodesTool({
      ...params,
      input: {
        action: "invoke",
        node,
        invokeCommand: command,
        invokeParamsJson: JSON.stringify(values[3] ?? {}),
      },
    });
  }
  throw new ToolInputError("unsupported nodes bridge action.");
}

export function codeModeReplayIdForToolCall(
  ctx: ToolSearchToolContext,
  toolCallId: string,
  code: string,
  assistantTurnId?: string,
): string {
  const outerRunId = ctx.runId?.trim();
  if (!outerRunId) {
    // Swarm bridges require an outer run id; ordinary Code Mode still gets an isolated identity.
    return `cm_replay_${randomUUID()}`;
  }
  // Provider response ids survive transcript restore and scope resettable tool-call ids to one turn.
  const identity = JSON.stringify([
    ctx.sessionKey ?? "",
    ctx.sessionId ?? "",
    outerRunId,
    assistantTurnId?.trim() ?? "",
    toolCallId,
    code,
  ]);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return `cm_replay_${digest}`;
}

export function isCodeModeSwarmAvailable(
  ctx: ToolSearchToolContext,
  catalog: readonly Pick<ToolSearchCatalogEntry, "source" | "name">[] | undefined,
): boolean {
  // Detached runs retain denied schemas; only an executable spawn capability
  // may advertise Swarm declarations or install its guest globals.
  return (
    resolveSwarmConfig(ctx.runtimeConfig ?? ctx.config, ctx.agentId).enabled &&
    (!ctx.toolExecutionAllow || isToolExecutionAllowed(ctx.toolExecutionAllow, "sessions_spawn")) &&
    catalog?.some((entry) => entry.source === "openclaw" && entry.name === "sessions_spawn") ===
      true &&
    ctx.catalogRef?.current?.entries.some(
      (entry) => entry.name === "sessions_spawn" && isCollectorSpawnTool(entry.tool),
    ) === true &&
    !ctx.catalogRef.current.entries.some(
      (entry) => entry.source === "client" && entry.name === "sessions_spawn",
    )
  );
}

function requireCodeModeSwarmEnabled(ctx: ToolSearchToolContext): void {
  if (!resolveSwarmConfig(ctx.runtimeConfig ?? ctx.config, ctx.agentId).enabled) {
    throw new ToolInputError("code mode swarm globals are disabled.");
  }
  // Swarm globals are the sessions_spawn capability: phase/log emit foreground lifecycle
  // events and agents.run launches collectors. A run that executes only an allowlist
  // (detached skill review) gets the same refusal as the tool, never the foreground session.
  if (ctx.toolExecutionAllow && !isToolExecutionAllowed(ctx.toolExecutionAllow, "sessions_spawn")) {
    throw new ToolInputError(TOOL_EXECUTION_GATED_MESSAGE);
  }
}

export async function runBridgeRequest(params: {
  runtime: ToolSearchRuntime;
  catalogProjection: CodeModeCatalogProjection;
  namespaceRuntime: CodeModeNamespaceRuntime;
  parentToolCallId: string;
  codeModeRunId: string;
  maxOutputBytes: number;
  remainingMs: number;
  ctx: ToolSearchToolContext;
  request: PendingBridgeRequest;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}): Promise<SettledBridgeRequest> {
  const catalogProjection = params.catalogProjection;
  let effectReceipt: ToolEffectReceipt | undefined;
  try {
    const values = Array.isArray(params.request.args) ? params.request.args : [];
    let value: unknown;
    switch (params.request.method) {
      case "search": {
        const query = values[0];
        if (typeof query !== "string") {
          throw new ToolInputError("search query must be a string.");
        }
        const options = isRecord(values[1]) ? values[1] : undefined;
        const matches = await params.runtime.search(query, {
          limit: typeof options?.limit === "number" ? options.limit : undefined,
          includeMcp: false,
          allowedIds: catalogProjection.byId,
        });
        const exact = query.trim().toLowerCase();
        const exactBinding = catalogProjection.bindings.find(
          (binding) =>
            binding.name.toLowerCase() === exact || binding.callableName.toLowerCase() === exact,
        );
        value = exactBinding
          ? [exactBinding.callableName]
          : matches.flatMap((entry) => {
              const binding = catalogProjection.byId.get(entry.id);
              return binding ? [binding.callableName] : [];
            });
        break;
      }
      case "describe": {
        const callableName = values[0];
        if (typeof callableName !== "string") {
          throw new ToolInputError("describe callable name must be a string.");
        }
        const binding = catalogProjection.byCallableName.get(callableName);
        if (!binding) {
          throw new ToolInputError(`Unknown catalog function: ${callableName}.`);
        }
        const described = await params.runtime.describe(binding.id, {
          includeMcp: false,
        });
        const { id: _id, sourceName: _sourceName, mcp: _mcp, ...guestDescription } = described;
        value = { ...guestDescription, callableName: binding.callableName };
        break;
      }
      case "callValue": {
        const callableName = values[0];
        if (typeof callableName !== "string") {
          throw new ToolInputError("catalog callable name must be a string.");
        }
        const binding = catalogProjection.byCallableName.get(callableName);
        if (!binding) {
          throw new ToolInputError(`Unknown catalog function: ${callableName}.`);
        }
        let input = values[1] ?? {};
        if (
          binding.source === "openclaw" &&
          binding.name === "exec" &&
          binding.input?.includes("yieldMs") === true &&
          isRecord(input) &&
          input.background !== true &&
          input.yieldMs === undefined
        ) {
          // The shell's 10s default equals Code Mode's default budget. Yield
          // within the remaining shared deadline so late sequential calls can
          // still return their process handle and resume the guest inline.
          input = {
            ...input,
            yieldMs: Math.max(1, Math.min(1_000, Math.floor(params.remainingMs / 4))),
          };
        }
        const called = await params.runtime.callExactId(binding.id, input, {
          parentToolCallId: params.parentToolCallId,
          signal: params.signal,
          onUpdate: params.onUpdate,
        });
        effectReceipt = consumeToolEffectReceipt(called.result);
        value =
          isRecord(called.result) && "details" in called.result
            ? called.result.details
            : called.result;
        break;
      }
      case "nodes": {
        value = await runNodesBridge(params);
        break;
      }
      case "yield": {
        value = { status: "yielded", reason: values[0] ?? null };
        break;
      }
      case "namespace": {
        const namespaceId = values[0];
        const pathLocal = values[1];
        const callArgs = values[2];
        if (typeof namespaceId !== "string") {
          throw new ToolInputError("namespace id must be a string.");
        }
        if (!Array.isArray(pathLocal) || !pathLocal.every((entry) => typeof entry === "string")) {
          throw new ToolInputError("namespace path must be an array of strings.");
        }
        value = await params.namespaceRuntime.invoke(
          namespaceId,
          pathLocal,
          Array.isArray(callArgs) ? callArgs : [],
          async (request) => {
            const entry = request.catalogId
              ? params.runtime
                  .namespaceEntries()
                  .find((candidate) => candidate.id === request.catalogId)
              : params.runtime
                  .namespaceEntries()
                  .find(
                    (candidate) =>
                      candidate.name === request.toolName &&
                      candidate.sourceName === request.pluginId,
                  );
            if (!entry) {
              throw new ToolInputError(
                `namespace tool is not visible in the run catalog: ${request.toolName}`,
              );
            }
            const called = await params.runtime.callExactId(entry.id, request.input, {
              parentToolCallId: params.parentToolCallId,
              signal: params.signal,
              onUpdate: params.onUpdate,
            });
            effectReceipt = consumeToolEffectReceipt(called.result);
            if (request.catalogId) {
              const guestResult = consumeMcpCodeModeGuestResult(called.result);
              if (guestResult === undefined) {
                throw new ToolInputError(
                  "MCP namespace tool result is missing its owned guest projection.",
                );
              }
              return guestResult;
            }
            return isRecord(called.result) && "details" in called.result
              ? called.result.details
              : called.result;
          },
        );
        effectReceipt ??= consumeToolEffectReceipt(value);
        break;
      }
      case "agentSpawn":
      case "agentWait":
      case "swarmNote": {
        const { signal } = params;
        requireCodeModeSwarmEnabled(params.ctx);
        signal?.throwIfAborted();
        const handlers = await loadSwarmHandlers();
        // Loading can outlive the cell. Reject before replay recovery, collector
        // reads, or note publication, even when the cancellation race has settled.
        signal?.throwIfAborted();
        requireCodeModeSwarmEnabled(params.ctx);
        value = await handlers[params.request.method](params);
        break;
      }
      case "skillsList": {
        value = (params.ctx.codeModeSkills ?? []).map(({ name, description, location }) => ({
          name,
          description,
          location,
        }));
        break;
      }
      case "skillsRead": {
        const name = values[0];
        const available = params.ctx.codeModeSkills ?? [];
        const skill =
          typeof name === "string" ? available.find((entry) => entry.name === name) : null;
        if (!skill) {
          const names = available.map((entry) => entry.name).join(", ") || "(none)";
          throw new ToolInputError(
            `Unknown skill ${JSON.stringify(name)}. Available skills: ${names}`,
          );
        }
        value = await readCodeModeSkill(skill, params.signal);
        break;
      }
      case "sleep": {
        const delay = values[0];
        if (typeof delay !== "number" || !Number.isFinite(delay) || delay < 0) {
          throw new ToolInputError("setTimeout delay must be a non-negative finite number.");
        }
        value = await sleep(resolveSafeTimeoutDelayMs(delay, { minMs: 0 }), null, {
          signal: params.signal,
        });
        break;
      }
    }
    value = boundCodeModeValue(value, params.maxOutputBytes);
    // Search must remain a callable-name array; a truncation marker erases discovery.
    if (params.request.method === "search" && !Array.isArray(value)) {
      throw new ToolInputError(
        "Search results exceed the output budget. Narrow the query or lower the limit.",
      );
    }
    const settled: SettledBridgeRequest = { id: params.request.id, ok: true, value };
    return effectReceipt ? registerToolEffectReceipt(settled, effectReceipt) : settled;
  } catch (error) {
    const boundedError = boundCodeModeError(
      redactCodeModeCatalogIds(formatErrorMessage(error), catalogProjection.bindings),
      params.maxOutputBytes,
    );
    const settled: SettledBridgeRequest = {
      id: params.request.id,
      ok: false,
      error: boundedError,
    };
    const trustedNoStart = consumeTrustedToolNoStartError(error);
    if (trustedNoStart) {
      registerTrustedToolNoStartError(settled);
    }
    effectReceipt =
      consumeToolEffectReceipt(error) ?? (trustedNoStart ? { state: "not_started" } : undefined);
    return effectReceipt ? registerToolEffectReceipt(settled, effectReceipt) : settled;
  }
}
