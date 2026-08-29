import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import type { PendingBridgeRequest } from "./code-mode-worker-types.js";
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
import type { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";
import {
  waitForCollectorCompletion,
  type CollectorCompletionResult,
} from "./tools/agents-wait-tool.js";
import { ToolInputError } from "./tools/common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./tools/sessions-resolution.js";

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
  });
  return { ok: true };
}

export const codeModeSwarmHandlers = {
  agentSpawn: runAgentSpawnBridge,
  agentWait: runAgentWaitBridge,
  swarmNote: runSwarmNoteBridge,
};
