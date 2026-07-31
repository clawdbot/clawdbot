import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { resolveThreadBindingSpawnPolicy } from "../channels/thread-bindings-policy.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SubagentSpawnPreparation } from "../context-engine/types.js";
import { summarizeSpawnError } from "./spawn-pipeline.js";
import { getSubagentSpawnDeps } from "./subagent-spawn-deps.js";
import { resolveGatewaySessionStoreTarget } from "./subagent-spawn.runtime.js";
import type { SpawnSubagentContextMode } from "./subagent-spawn.types.js";

type PreparedSpawnContext =
  | {
      status: "ok";
      mode: "isolated";
      parentEntry?: SessionEntry;
      childEntry?: SessionEntry;
      forkFallbackNote?: string;
    }
  | {
      status: "ok";
      mode: "fork";
      parentEntry: SessionEntry;
      childEntry?: SessionEntry;
      forked: { sessionId: string; sessionFile: string };
      forkFallbackNote?: never;
    }
  | { status: "error"; error: string };

export async function prepareSubagentSessionContext(params: {
  cfg: OpenClawConfig;
  contextMode: SpawnSubagentContextMode;
  requesterAgentId: string;
  targetAgentId: string;
  requesterInternalKey: string;
  childSessionKey: string;
}): Promise<PreparedSpawnContext> {
  if (params.contextMode === "isolated") {
    return { status: "ok", mode: "isolated" };
  }
  const childTarget = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.childSessionKey,
  });
  const parentTarget = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.requesterInternalKey,
  });

  let parentEntry: SessionEntry | undefined;
  let childEntry: SessionEntry | undefined;
  let forkFallbackNote: string | undefined;

  try {
    if (params.targetAgentId !== params.requesterAgentId) {
      throw new Error(
        'context="fork" currently requires the same target agent as the requester; use context="isolated" for cross-agent spawns.',
      );
    }

    const forkedResult = await getSubagentSpawnDeps().forkSessionEntryFromParent({
      storePath: childTarget.storePath,
      parentSessionKey: parentTarget.canonicalKey,
      parentStoreKeys: parentTarget.storeKeys,
      sessionKey: childTarget.canonicalKey,
      sessionStoreKeys: childTarget.storeKeys,
      fallbackEntry: { sessionId: "", updatedAt: Date.now() },
      agentId: params.requesterAgentId,
    });
    if (forkedResult.status === "missing-parent") {
      throw new Error(
        'context="fork" requested but the requester session transcript is not available.',
      );
    }
    if (forkedResult.status === "failed" || forkedResult.status === "missing-entry") {
      throw new Error(
        'context="fork" requested but OpenClaw could not fork the requester transcript.',
      );
    }
    parentEntry = forkedResult.parentEntry;
    childEntry = forkedResult.sessionEntry;
    if (forkedResult.status === "skipped") {
      forkFallbackNote =
        forkedResult.decision?.status === "skip" ? forkedResult.decision.message : undefined;
    }
    const forked =
      forkedResult.status === "forked"
        ? {
            sessionId: forkedResult.fork.sessionId,
            sessionFile: forkedResult.fork.sessionFile,
          }
        : null;

    if (params.contextMode === "fork") {
      if (!parentEntry || !forked) {
        if (forkFallbackNote) {
          return {
            status: "ok",
            mode: "isolated",
            parentEntry,
            childEntry,
            forkFallbackNote,
          };
        }
        return {
          status: "error",
          error: 'context="fork" requested but OpenClaw could not prepare forked context.',
        };
      }
      return {
        status: "ok",
        mode: "fork",
        parentEntry,
        childEntry,
        forked,
      };
    }
    return {
      status: "ok",
      mode: "isolated",
      parentEntry,
      childEntry,
      ...(forkFallbackNote ? { forkFallbackNote } : {}),
    };
  } catch (err) {
    return { status: "error", error: summarizeSpawnError(err) };
  }
}

export async function prepareContextEngineSubagentSpawn(params: {
  cfg: OpenClawConfig;
  context: PreparedSpawnContext & { status: "ok" };
  requesterInternalKey: string;
  childSessionKey: string;
  runTimeoutSeconds: number;
}): Promise<
  { status: "ok"; preparation?: SubagentSpawnPreparation } | { status: "error"; error: string }
> {
  try {
    const deps = getSubagentSpawnDeps();
    deps.ensureContextEnginesInitialized();
    const engine = await deps.resolveContextEngine(params.cfg);
    const preparation = await engine.prepareSubagentSpawn?.({
      parentSessionKey: params.requesterInternalKey,
      childSessionKey: params.childSessionKey,
      contextMode: params.context.mode,
      parentSessionId: params.context.parentEntry?.sessionId,
      parentSessionFile: params.requesterInternalKey,
      childSessionId:
        params.context.mode === "fork"
          ? params.context.forked.sessionId
          : params.context.childEntry?.sessionId,
      childSessionFile:
        params.context.mode === "fork" ? params.context.forked.sessionFile : params.childSessionKey,
      ttlMs: finiteSecondsToTimerSafeMilliseconds(params.runTimeoutSeconds, {
        floorSeconds: true,
      }),
    });
    return { status: "ok", preparation };
  } catch (err) {
    return {
      status: "error",
      error: `Context engine subagent preparation failed: ${summarizeSpawnError(err)}`,
    };
  }
}

export async function rollbackPreparedContextEngine(
  preparation?: SubagentSpawnPreparation,
): Promise<boolean> {
  try {
    await preparation?.rollback();
    return true;
  } catch {
    // Best-effort cleanup only.
    return false;
  }
}

export function resolveSubagentContextMode(params: {
  requestedContext?: SpawnSubagentContextMode;
  threadRequested: boolean;
  cfg: OpenClawConfig;
  requester: {
    channel?: string;
    accountId?: string;
  };
}): SpawnSubagentContextMode {
  if (params.requestedContext === "fork" || params.requestedContext === "isolated") {
    return params.requestedContext;
  }
  if (!params.threadRequested || !params.requester.channel) {
    return "isolated";
  }
  return resolveThreadBindingSpawnPolicy({
    cfg: params.cfg,
    channel: params.requester.channel,
    accountId: params.requester.accountId,
    kind: "subagent",
  }).defaultSpawnContext;
}
