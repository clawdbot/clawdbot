import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { NODE_FS_LIST_DIR_COMMAND } from "../infra/node-commands.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { parseNodeList } from "../shared/node-list-parse.js";
import type { NodeListNode } from "../shared/node-list-types.js";
import { resolveEligibleNodeFromList } from "../shared/node-resolve.js";
import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";
import { boundCodeModeValue } from "./code-mode-json.js";
import type { CodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import type { PendingBridgeRequest, SettledBridgeRequest } from "./code-mode-runtime.js";
import { readCodeModeSkill } from "./code-mode-skills.js";
import type { AgentToolUpdateCallback } from "./runtime/index.js";
import {
  getSwarmRunByLaunchReplayKey,
  initSubagentRegistry,
} from "./subagents/registry/subagent-registry.js";
import type { SubagentRunRecord } from "./subagents/registry/subagent-registry.types.js";
import {
  SWARM_CODE_MODE_IDEMPOTENCY_KEY,
  SWARM_CODE_MODE_REQUEST_FINGERPRINT,
} from "./subagents/swarm/swarm-code-mode.js";
import { resolveSwarmConfig } from "./subagents/swarm/swarm-config.js";
import { ToolSearchRuntime, type ToolSearchToolContext } from "./tool-search.js";
import {
  waitForCollectorCompletion,
  type CollectorCompletionResult,
} from "./tools/agents-wait-tool.js";
import { ToolInputError } from "./tools/common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./tools/sessions-helpers.js";

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
    recoverySurface: "tools",
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

function requireCodeModeSwarmEnabled(ctx: ToolSearchToolContext): void {
  if (!resolveSwarmConfig(ctx.runtimeConfig ?? ctx.config, ctx.agentId).enabled) {
    throw new ToolInputError("code mode swarm globals are disabled.");
  }
}

function resolveCodeModeRequesterSessionKey(ctx: ToolSearchToolContext): string {
  const sessionKey = ctx.sessionKey?.trim();
  if (!sessionKey) {
    throw new ToolInputError("code mode swarm globals require session and run identity.");
  }
  const { mainKey, alias } = resolveMainSessionAlias(ctx.runtimeConfig ?? ctx.config ?? {});
  return resolveInternalSessionKey({ key: sessionKey, alias, mainKey });
}

function resolveCodeModeSwarmGroupId(ctx: ToolSearchToolContext): string {
  const sessionKey = resolveCodeModeRequesterSessionKey(ctx);
  const runId = ctx.runId?.trim();
  if (!runId) {
    throw new ToolInputError("code mode swarm globals require session and run identity.");
  }
  return `swarm:${sessionKey}:${runId}`;
}

function replayedSpawnResult(entry: SubagentRunRecord) {
  return {
    status: "accepted",
    runId: entry.swarmRunId ?? entry.runId,
    sessionKey: entry.childSessionKey,
    ...(entry.label ? { label: entry.label } : {}),
  };
}

function readOptionalStringOption(
  options: Record<string, unknown>,
  key: "label" | "model" | "thinking" | "agentId",
): string | undefined {
  const value = options[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError(`agents.run ${key} must be a non-empty string.`);
  }
  return value.trim();
}

async function runAgentSpawnBridge(params: {
  runtime: ToolSearchRuntime;
  parentToolCallId: string;
  request: PendingBridgeRequest;
  codeModeRunId: string;
  ctx: ToolSearchToolContext;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) {
  requireCodeModeSwarmEnabled(params.ctx);
  const prompt = params.request.args[0];
  const options = isRecord(params.request.args[1]) ? params.request.args[1] : {};
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new ToolInputError("agents.run prompt must be a non-empty string.");
  }
  const fastMode = options.fastMode;
  if (fastMode !== undefined && fastMode !== true && fastMode !== false && fastMode !== "auto") {
    throw new ToolInputError('agents.run fastMode must be boolean or "auto".');
  }
  const schema = options.schema;
  if (schema !== undefined && !isRecord(schema)) {
    throw new ToolInputError("agents.run schema must be a JSON schema object.");
  }
  const label = readOptionalStringOption(options, "label");
  const model = readOptionalStringOption(options, "model");
  const thinking = readOptionalStringOption(options, "thinking");
  const agentId = readOptionalStringOption(options, "agentId");
  const spawnEntry = params.runtime
    .namespaceEntries()
    .find((entry) => entry.source === "openclaw" && entry.name === "sessions_spawn");
  if (!spawnEntry) {
    throw new ToolInputError("agents.run requires the sessions_spawn tool.");
  }
  const spawnInput: Record<PropertyKey, unknown> = {
    task: prompt.trim(),
    collect: true,
    groupId: resolveCodeModeSwarmGroupId(params.ctx),
    ...(label ? { label } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(agentId ? { agentId } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(schema ? { outputSchema: schema } : {}),
  };
  const requestFingerprint = `sha256:${createHash("sha256")
    .update(stableStringify(spawnInput))
    .digest("hex")}`;
  // The registry persists this exact tuple and payload hash before launch.
  const idempotencyKey = `${params.codeModeRunId}:${params.request.id}`;
  const requesterSessionKey = resolveCodeModeRequesterSessionKey(params.ctx);
  let existing = getSwarmRunByLaunchReplayKey(
    idempotencyKey,
    requesterSessionKey,
    params.ctx.agentId,
  );
  if (existing) {
    if (existing.swarmLaunchRequestFingerprint !== requestFingerprint) {
      throw new ToolInputError("agents.run replay request does not match the persisted collector.");
    }
    if (existing.swarmLaunchPending === true) {
      if (!existing.queuedLaunch) {
        throw new ToolInputError("agents.run persisted launch reservation cannot be recovered.");
      }
      // Cold-start restore idempotently re-enqueues this durable launch before agentWait parks.
      initSubagentRegistry();
      existing =
        getSwarmRunByLaunchReplayKey(idempotencyKey, requesterSessionKey, params.ctx.agentId) ??
        existing;
      if (existing.swarmLaunchPending === true && !existing.queuedLaunch) {
        throw new ToolInputError("agents.run persisted launch reservation cannot be recovered.");
      }
    }
    return replayedSpawnResult(existing);
  }
  Object.defineProperty(spawnInput, SWARM_CODE_MODE_IDEMPOTENCY_KEY, {
    value: idempotencyKey,
  });
  Object.defineProperty(spawnInput, SWARM_CODE_MODE_REQUEST_FINGERPRINT, {
    value: requestFingerprint,
  });
  const called = await params.runtime.callExactId(spawnEntry.id, spawnInput, {
    parentToolCallId: params.parentToolCallId,
    signal: params.signal,
    onUpdate: params.onUpdate,
  });
  const value =
    isRecord(called.result) && "details" in called.result ? called.result.details : called.result;
  if (!isRecord(value) || value.status !== "accepted" || typeof value.runId !== "string") {
    const detail =
      isRecord(value) && typeof value.error === "string"
        ? value.error
        : "collector spawn was not accepted";
    throw new ToolInputError(`agents.run spawn failed: ${detail}`);
  }
  return value;
}

async function runAgentWaitBridge(params: {
  request: PendingBridgeRequest;
  ctx: ToolSearchToolContext;
  signal?: AbortSignal;
}): Promise<CollectorCompletionResult> {
  requireCodeModeSwarmEnabled(params.ctx);
  const runId = params.request.args[0];
  if (typeof runId !== "string" || !runId.trim()) {
    throw new ToolInputError("agentWait run id must be a non-empty string.");
  }
  const rawSessionKey = params.ctx.sessionKey?.trim();
  if (!rawSessionKey) {
    throw new ToolInputError("agents.run wait requires session identity.");
  }
  const requesterSessionKey = resolveCodeModeRequesterSessionKey(params.ctx);
  return await waitForCollectorCompletion({
    runId: runId.trim(),
    currentSessionKeys: new Set([rawSessionKey, requesterSessionKey]),
    currentAgentId: params.ctx.agentId,
    config: params.ctx.runtimeConfig ?? params.ctx.config,
    signal: params.signal,
  });
}

function runSwarmNoteBridge(params: {
  request: PendingBridgeRequest;
  ctx: ToolSearchToolContext;
}): { ok: true } {
  requireCodeModeSwarmEnabled(params.ctx);
  const note = isRecord(params.request.args[0]) ? params.request.args[0] : undefined;
  const kind = note?.kind;
  const text = note?.text;
  if ((kind !== "phase" && kind !== "log") || typeof text !== "string" || !text.trim()) {
    throw new ToolInputError("swarmNote requires phase/log kind and non-empty text.");
  }
  const sessionKey = params.ctx.sessionKey?.trim();
  if (!sessionKey) {
    throw new ToolInputError("swarmNote requires session identity.");
  }
  emitSessionLifecycleEvent({
    sessionKey,
    reason: "swarm-note",
    swarmGroupId: resolveCodeModeSwarmGroupId(params.ctx),
    kind,
    text: text.trim(),
  } as Parameters<typeof emitSessionLifecycleEvent>[0] & {
    swarmGroupId: string;
    kind: "phase" | "log";
    text: string;
  });
  return { ok: true };
}

export async function runBridgeRequest(params: {
  runtime: ToolSearchRuntime;
  namespaceRuntime: CodeModeNamespaceRuntime;
  parentToolCallId: string;
  codeModeRunId: string;
  maxOutputBytes: number;
  ctx: ToolSearchToolContext;
  request: PendingBridgeRequest;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}): Promise<SettledBridgeRequest> {
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
        value = await params.runtime.search(query, {
          limit: typeof options?.limit === "number" ? options.limit : undefined,
          includeMcp: false,
        });
        break;
      }
      case "describe": {
        const id = values[0];
        if (typeof id !== "string") {
          throw new ToolInputError("describe id must be a string.");
        }
        value = await params.runtime.describe(id, {
          includeMcp: false,
          recoverySurface: "tools",
        });
        break;
      }
      case "call": {
        const id = values[0];
        if (typeof id !== "string") {
          throw new ToolInputError("call id must be a string.");
        }
        value = await params.runtime.call(id, values[1] ?? {}, {
          includeMcp: false,
          parentToolCallId: params.parentToolCallId,
          signal: params.signal,
          onUpdate: params.onUpdate,
          recoverySurface: "tools",
        });
        break;
      }
      case "callValue": {
        const id = values[0];
        if (typeof id !== "string") {
          throw new ToolInputError("callValue id must be a string.");
        }
        value = await params.runtime.callValue(id, values[1] ?? {}, {
          includeMcp: false,
          parentToolCallId: params.parentToolCallId,
          signal: params.signal,
          onUpdate: params.onUpdate,
          recoverySurface: "tools",
        });
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
            if (request.catalogId) {
              return called.result;
            }
            return isRecord(called.result) && "details" in called.result
              ? called.result.details
              : called.result;
          },
        );
        break;
      }
      case "agentSpawn": {
        value = await runAgentSpawnBridge(params);
        break;
      }
      case "agentWait": {
        value = await runAgentWaitBridge(params);
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
      case "swarmNote": {
        value = runSwarmNoteBridge(params);
        break;
      }
    }
    return {
      id: params.request.id,
      ok: true,
      value: boundCodeModeValue(value, params.maxOutputBytes),
    };
  } catch (error) {
    return { id: params.request.id, ok: false, error: formatErrorMessage(error) };
  }
}
