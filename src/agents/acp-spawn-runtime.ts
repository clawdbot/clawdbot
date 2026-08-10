import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "@openclaw/acp-core/runtime/session-identifiers";
import type { AcpRuntimeSessionMode } from "@openclaw/acp-core/runtime/types";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import type { AcpSpawnRuntimeCloseHandle } from "../acp/control-plane/spawn.js";
import { formatThinkingLevels } from "../auto-reply/thinking.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../channels/thread-bindings-messages.js";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "../channels/thread-bindings-policy.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isMissingPathError } from "../infra/errors.js";
import {
  getSessionBindingService,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import { persistAcpSpawnSessionFileBestEffort } from "./acp-spawn-requester.js";
import { resolveAgentConfig } from "./agent-scope.js";
import {
  resolveConfiguredSubagentSpawnModelSelection,
  resolveThinkingDefault,
} from "./model-selection.js";
import type { PreparedSpawnThreadBinding } from "./spawn-plan.js";
import { splitModelRef } from "./subagent-spawn-plan.js";
import { resolveSubagentThinkingOverride } from "./subagent-spawn-thinking.js";

const ACP_RUNTIME_TIMEOUT_MAX_SECONDS = 24 * 60 * 60;

export function resolveAcpSessionMode(mode: "run" | "session"): AcpRuntimeSessionMode {
  return mode === "session" ? "persistent" : "oneshot";
}

export async function resolveRuntimeCwdForAcpSpawn(params: {
  resolvedCwd?: string;
  explicitCwd?: string;
}): Promise<string | undefined> {
  if (!params.resolvedCwd) {
    return undefined;
  }
  if (normalizeOptionalString(params.explicitCwd)) {
    return params.resolvedCwd;
  }
  try {
    await fs.access(params.resolvedCwd);
    return params.resolvedCwd;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

type AcpSpawnInitializedSession = Awaited<
  ReturnType<ReturnType<typeof getAcpSessionManager>["initializeSession"]>
>;

export type AcpSpawnInitializedRuntime = {
  initialized: AcpSpawnInitializedSession;
  runtimeCloseHandle: AcpSpawnRuntimeCloseHandle;
  sessionId?: string;
  sessionEntry: SessionEntry | undefined;
  storePath: string;
};

type AcpSpawnRuntimeOptions = {
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
};

function resolveAcpRuntimeTimeoutSeconds(runTimeoutSeconds?: number): number | undefined {
  if (!runTimeoutSeconds) {
    return undefined;
  }
  return Math.min(runTimeoutSeconds, ACP_RUNTIME_TIMEOUT_MAX_SECONDS);
}

export function resolveAcpSpawnRuntimeOptions(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  configAgentId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
}):
  | { ok: true; runtimeOptions?: AcpSpawnRuntimeOptions; modelExplicit: boolean }
  | { ok: false; error: string } {
  const policyAgentId = params.configAgentId ?? params.targetAgentId;
  const modelExplicit = normalizeOptionalString(params.model) !== undefined;
  const model = resolveConfiguredSubagentSpawnModelSelection({
    cfg: params.cfg,
    agentId: policyAgentId,
    modelOverride: params.model,
  });
  const targetAgentConfig = resolveAgentConfig(params.cfg, policyAgentId);
  const thinkingPlan = resolveSubagentThinkingOverride({
    cfg: params.cfg,
    targetAgentConfig,
    thinkingOverrideRaw: params.thinking,
  });
  if (thinkingPlan.status === "error") {
    const { provider, model: modelId } = splitModelRef(model);
    return {
      ok: false,
      error: `Invalid thinking level "${thinkingPlan.thinkingCandidateRaw}". Use one of: ${formatThinkingLevels(provider, modelId)}.`,
    };
  }

  let thinking = thinkingPlan.thinkingOverride;
  if (!thinking && model) {
    const { provider, model: modelId } = splitModelRef(model);
    if (provider && modelId) {
      thinking = resolveThinkingDefault({
        cfg: params.cfg,
        provider,
        model: modelId,
      });
    }
  }

  const timeoutSeconds = resolveAcpRuntimeTimeoutSeconds(params.runTimeoutSeconds);
  const runtimeOptions =
    model || thinking || timeoutSeconds
      ? {
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
          ...(timeoutSeconds ? { timeoutSeconds } : {}),
        }
      : undefined;
  return { ok: true, runtimeOptions, modelExplicit };
}

export async function initializeAcpSpawnRuntime(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  targetAgentId: string;
  runtimeMode: AcpRuntimeSessionMode;
  resumeSessionId?: string;
  runtimeOptions?: AcpSpawnRuntimeOptions;
  modelExplicit?: boolean;
  cwd?: string;
}): Promise<AcpSpawnInitializedRuntime> {
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.targetAgentId });
  let sessionEntry = loadSessionEntry({
    storePath,
    sessionKey: params.sessionKey,
    clone: false,
  });
  const sessionId = sessionEntry?.sessionId;
  if (sessionId) {
    sessionEntry = await persistAcpSpawnSessionFileBestEffort({
      sessionId,
      sessionKey: params.sessionKey,
      storePath,
      sessionEntry,
      agentId: params.targetAgentId,
      stage: "spawn",
    });
  }

  const initialized = await getAcpSessionManager().initializeSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agent: params.targetAgentId,
    mode: params.runtimeMode,
    resumeSessionId: params.resumeSessionId,
    runtimeOptions: params.runtimeOptions,
    modelExplicit: params.modelExplicit,
    cwd: params.cwd,
    backendId: params.cfg.acp?.backend,
  });

  return {
    initialized,
    runtimeCloseHandle: {
      runtime: initialized.runtime,
      handle: initialized.handle,
    },
    sessionId,
    sessionEntry,
    storePath,
  };
}

export async function bindPreparedAcpThread(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  targetAgentId: string;
  label?: string;
  preparedBinding: PreparedSpawnThreadBinding;
  initializedRuntime: AcpSpawnInitializedRuntime;
}): Promise<{
  binding: SessionBindingRecord;
  sessionEntry: SessionEntry | undefined;
}> {
  const binding = await getSessionBindingService().bind({
    targetSessionKey: params.sessionKey,
    targetKind: "session",
    conversation: {
      channel: params.preparedBinding.channel,
      accountId: params.preparedBinding.accountId,
      conversationId: params.preparedBinding.conversationId,
      ...(params.preparedBinding.parentConversationId
        ? { parentConversationId: params.preparedBinding.parentConversationId }
        : {}),
    },
    placement: params.preparedBinding.placement,
    metadata: {
      threadName: resolveThreadBindingThreadName({
        agentId: params.targetAgentId,
        label: params.label || params.targetAgentId,
      }),
      agentId: params.targetAgentId,
      label: params.label || undefined,
      boundBy: "system",
      introText: resolveThreadBindingIntroText({
        agentId: params.targetAgentId,
        label: params.label || undefined,
        idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
          cfg: params.cfg,
          channel: params.preparedBinding.channel,
          accountId: params.preparedBinding.accountId,
        }),
        maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
          cfg: params.cfg,
          channel: params.preparedBinding.channel,
          accountId: params.preparedBinding.accountId,
        }),
        sessionCwd: resolveAcpSessionCwd(params.initializedRuntime.initialized.meta),
        sessionDetails: resolveAcpThreadSessionDetailLines({
          sessionKey: params.sessionKey,
          meta: params.initializedRuntime.initialized.meta,
        }),
      }),
    },
  });
  if (!binding.conversation.conversationId) {
    throw new Error(
      params.preparedBinding.placement === "child"
        ? `Failed to create and bind a ${params.preparedBinding.channel} thread for this ACP session.`
        : `Failed to bind the current ${params.preparedBinding.channel} conversation for this ACP session.`,
    );
  }

  let sessionEntry = params.initializedRuntime.sessionEntry;
  if (params.initializedRuntime.sessionId && params.preparedBinding.placement === "child") {
    const boundThreadId = normalizeOptionalString(binding.conversation.conversationId);
    if (boundThreadId) {
      sessionEntry = await persistAcpSpawnSessionFileBestEffort({
        sessionId: params.initializedRuntime.sessionId,
        sessionKey: params.sessionKey,
        storePath: params.initializedRuntime.storePath,
        sessionEntry,
        agentId: params.targetAgentId,
        threadId: boundThreadId,
        stage: "thread-bind",
      });
    }
  }

  return { binding, sessionEntry };
}
import fs from "node:fs/promises";
