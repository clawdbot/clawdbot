import crypto from "node:crypto";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  resolveChannelDefaultBindingPlacement,
  resolveInboundConversationResolution,
} from "../channels/conversation-resolution.js";
import {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  resolveThreadBindingSpawnPolicy,
} from "../channels/thread-bindings-policy.js";
import {
  DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT,
  DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
} from "../config/agent-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { resolveChildAdmission, type ChildAdmissionCap } from "./child-admission.js";
import { resolveSubagentCapabilities } from "./subagent-capabilities.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { countActiveRunsForSession } from "./subagent-registry.js";
import { resolveSubagentTargetPolicy } from "./subagent-target-policy.js";

type SpawnMode = "run" | "session";
type SpawnBackendKind = "subagent" | "acp";

export type PreparedSpawnThreadBinding = {
  channel: string;
  accountId: string;
  placement: "current" | "child";
  conversationId: string;
  parentConversationId?: string;
};

type SessionBindingService = ReturnType<typeof getSessionBindingService>;

export function resolveSpawnMode(params: {
  requestedMode?: SpawnMode;
  threadRequested: boolean;
}): SpawnMode {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  return params.threadRequested ? "session" : "run";
}

export function mintSpawnSessionKey(params: {
  targetAgentId: string;
  backend: SpawnBackendKind;
}): string {
  const kind = params.backend === "acp" ? "acp" : "subagent";
  return `agent:${params.targetAgentId}:${kind}:${crypto.randomUUID()}`;
}

export function resolveSpawnChannelAccountId(params: {
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
}): string | undefined {
  const channel = normalizeOptionalLowercaseString(params.channel);
  const explicitAccountId = normalizeOptionalString(params.accountId);
  if (explicitAccountId) {
    return explicitAccountId;
  }
  if (!channel) {
    return undefined;
  }
  const channels = params.cfg.channels as Record<string, { defaultAccount?: unknown } | undefined>;
  return normalizeOptionalString(channels?.[channel]?.defaultAccount) ?? "default";
}

export function resolveConversationRefForThreadBinding(params: {
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  groupId?: string;
}): { conversationId: string; parentConversationId?: string } | null {
  const resolution = resolveInboundConversationResolution({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    to: params.to,
    threadId: params.threadId,
    groupId: params.groupId,
    isGroup: true,
  });
  return resolution?.canonical ?? null;
}

function resolveRequesterBoundConversationRef(params: {
  bindingService: SessionBindingService;
  requesterSessionKey?: string;
  channel: string;
  accountId: string;
  fallback?: { conversationId: string; parentConversationId?: string } | null;
}): { conversationId: string; parentConversationId?: string } | null | undefined {
  const requesterSessionKey = normalizeOptionalString(params.requesterSessionKey);
  if (!requesterSessionKey) {
    return undefined;
  }
  const activeBindings = params.bindingService
    .listBySession(requesterSessionKey)
    .filter(
      (record) =>
        record.status !== "ended" &&
        record.conversation.channel === params.channel &&
        (record.conversation.accountId ?? params.accountId) === params.accountId,
    );
  if (activeBindings.length === 0) {
    return undefined;
  }
  if (activeBindings.length === 1) {
    const conversation = activeBindings[0]?.conversation;
    return conversation
      ? {
          conversationId: conversation.conversationId,
          ...(conversation.parentConversationId
            ? { parentConversationId: conversation.parentConversationId }
            : {}),
        }
      : undefined;
  }
  if (!params.fallback?.conversationId) {
    return null;
  }
  const matched = activeBindings.filter(
    (record) =>
      record.conversation.conversationId === params.fallback?.conversationId &&
      normalizeOptionalString(record.conversation.parentConversationId) ===
        normalizeOptionalString(params.fallback?.parentConversationId),
  );
  const conversation = matched.length === 1 ? matched[0]?.conversation : undefined;
  return conversation
    ? {
        conversationId: conversation.conversationId,
        ...(conversation.parentConversationId
          ? { parentConversationId: conversation.parentConversationId }
          : {}),
      }
    : null;
}

function buildThreadBindingUnavailableError(kind: SpawnBackendKind, mode: SpawnMode): string {
  if (kind === "acp") {
    return "thread=true for ACP sessions requires a channel context.";
  }
  if (mode === "session") {
    return (
      'sessions_spawn(mode="session") is only available on channels that expose thread bindings (e.g. Discord threads, Slack threads, Telegram forum topics). ' +
      "This request is not running on a channel that can bind a subagent thread. " +
      'Use mode="run" for one-shot subagent work, or sessions_send(sessionKey=...) to keep talking to a persistent session without thread binding.'
    );
  }
  return (
    "thread=true is only available on channels that expose thread bindings (e.g. Discord threads, Slack threads, Telegram forum topics). " +
    "This request is not running on a channel that can bind a subagent thread. " +
    "Retry without thread=true, or re-run sessions_spawn from a channel that supports threads."
  );
}

export function prepareSpawnThreadBinding(params: {
  cfg: OpenClawConfig;
  kind: SpawnBackendKind;
  mode: SpawnMode;
  bindingService: SessionBindingService;
  requesterSessionKey?: string;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  groupId?: string;
}): { ok: true; binding: PreparedSpawnThreadBinding } | { ok: false; error: string } {
  const channel = normalizeOptionalLowercaseString(params.channel);
  if (!channel) {
    return { ok: false, error: buildThreadBindingUnavailableError(params.kind, params.mode) };
  }
  const accountId = resolveSpawnChannelAccountId({
    cfg: params.cfg,
    channel,
    accountId: params.accountId,
  });
  const policy = resolveThreadBindingSpawnPolicy({
    cfg: params.cfg,
    channel,
    accountId,
    kind: params.kind,
  });
  if (!policy.enabled) {
    return {
      ok: false,
      error: formatThreadBindingDisabledError({
        channel: policy.channel,
        accountId: policy.accountId,
        kind: params.kind,
      }),
    };
  }
  if (!policy.spawnEnabled) {
    return {
      ok: false,
      error: formatThreadBindingSpawnDisabledError({
        channel: policy.channel,
        accountId: policy.accountId,
        kind: params.kind,
      }),
    };
  }
  const capabilities = params.bindingService.getCapabilities({
    channel: policy.channel,
    accountId: policy.accountId,
  });
  if (!capabilities.adapterAvailable) {
    return {
      ok: false,
      error:
        params.kind === "acp"
          ? `Thread bindings are unavailable for ${policy.channel}.`
          : buildThreadBindingUnavailableError(params.kind, params.mode),
    };
  }
  const placement =
    resolveChannelDefaultBindingPlacement(policy.channel) ??
    (capabilities.placements.includes("child") ? "child" : "current");
  if (!capabilities.bindSupported || !capabilities.placements.includes(placement)) {
    return {
      ok: false,
      error: `Thread bindings do not support ${placement} placement for ${policy.channel}.`,
    };
  }
  const fallback = resolveConversationRefForThreadBinding({
    cfg: params.cfg,
    channel: policy.channel,
    accountId: policy.accountId,
    to: params.to,
    threadId: params.threadId,
    groupId: params.groupId,
  });
  const requesterConversation =
    params.kind === "subagent"
      ? resolveRequesterBoundConversationRef({
          bindingService: params.bindingService,
          requesterSessionKey: params.requesterSessionKey,
          channel: policy.channel,
          accountId: policy.accountId,
          fallback,
        })
      : undefined;
  if (requesterConversation === null) {
    return {
      ok: false,
      error: `Could not resolve a unique ${policy.channel} requester conversation for subagent thread spawn.`,
    };
  }
  const conversation = requesterConversation ?? fallback;
  if (!conversation?.conversationId) {
    return {
      ok: false,
      error: `Could not resolve a ${policy.channel} conversation for ${params.kind} thread spawn.`,
    };
  }
  return {
    ok: true,
    binding: {
      channel: policy.channel,
      accountId: policy.accountId,
      placement,
      conversationId: conversation.conversationId,
      ...(conversation.parentConversationId
        ? { parentConversationId: conversation.parentConversationId }
        : {}),
    },
  };
}

export function resolveSpawnAdmission(params: {
  cfg: OpenClawConfig;
  enabled?: boolean;
  collector?: {
    liveChildren: number;
    totalChildren: number;
    maxChildrenPerGroup: number;
    maxTotalPerGroup: number;
  };
  requesterSessionKey: string;
  requesterAgentId: string;
  targetAgentId: string;
  requestedAgentId?: string;
  configuredAgentIds: string[];
  additionalActiveChildren?: number;
}):
  | {
      ok: true;
      maxSpawnDepth?: number;
      childSessionPatch?: {
        spawnDepth: number;
        subagentRole: "orchestrator" | "leaf" | null;
        subagentControlScope: "children" | "none";
      };
    }
  | { ok: false; governingCap?: ChildAdmissionCap; error: string } {
  if (params.enabled === false) {
    return { ok: true };
  }
  const callerDepth = getSubagentDepthFromSessionStore(params.requesterSessionKey, {
    cfg: params.cfg,
  });
  const maxSpawnDepth =
    params.cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  const collector = params.collector;
  // Build each mode's params in its own branch so collector counts can never
  // pair with the announce cap (or vice versa) through fallback chaining.
  const childAdmission = collector
    ? resolveChildAdmission({
        callerDepth,
        maxSpawnDepth,
        collect: true,
        activeChildren: collector.liveChildren,
        maxActiveChildren: collector.maxChildrenPerGroup,
        totalChildren: collector.totalChildren,
        maxTotalChildren: collector.maxTotalPerGroup,
      })
    : resolveChildAdmission({
        callerDepth,
        maxSpawnDepth,
        collect: false,
        activeChildren:
          countActiveRunsForSession(params.requesterSessionKey, { collect: false }) +
          (params.additionalActiveChildren ?? 0),
        maxActiveChildren:
          params.cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ??
          DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT,
      });
  if (!childAdmission.ok) {
    return childAdmission;
  }
  const requesterSubagentConfig = resolveAgentConfig(
    params.cfg,
    params.requesterAgentId,
  )?.subagents;
  const requireAgentId =
    requesterSubagentConfig?.requireAgentId ??
    params.cfg.agents?.defaults?.subagents?.requireAgentId ??
    false;
  if (requireAgentId && !params.requestedAgentId?.trim()) {
    return {
      ok: false,
      error:
        "sessions_spawn requires explicit agentId when requireAgentId is configured. Use agents_list to see allowed agent ids.",
    };
  }
  const targetPolicy = resolveSubagentTargetPolicy({
    requesterAgentId: params.requesterAgentId,
    targetAgentId: params.targetAgentId,
    requestedAgentId: params.requestedAgentId,
    allowAgents:
      requesterSubagentConfig?.allowAgents ?? params.cfg.agents?.defaults?.subagents?.allowAgents,
    configuredAgentIds: params.configuredAgentIds,
  });
  if (!targetPolicy.ok) {
    return { ok: false, error: targetPolicy.error };
  }
  const capabilities = resolveSubagentCapabilities({
    depth: callerDepth + 1,
    maxSpawnDepth,
  });
  return {
    ok: true,
    maxSpawnDepth,
    childSessionPatch: {
      spawnDepth: capabilities.depth,
      subagentRole: capabilities.role === "main" ? null : capabilities.role,
      subagentControlScope: capabilities.controlScope,
    },
  };
}

export function resolveSpawnSandboxError(
  params:
    | {
        backend: "acp";
        requesterSandboxed: boolean;
        sandbox: "inherit" | "require";
      }
    | {
        backend: "subagent";
        requesterSandboxed: boolean;
        childSandboxed: boolean;
        sandbox: "inherit" | "require";
      },
): string | undefined {
  if (params.backend === "acp") {
    if (params.requesterSandboxed) {
      return 'Sandboxed sessions cannot spawn ACP sessions because runtime="acp" runs on the host. Use runtime="subagent" from sandboxed sessions.';
    }
    return params.sandbox === "require"
      ? 'sessions_spawn sandbox="require" is unsupported for runtime="acp" because ACP sessions run outside the sandbox. Use runtime="subagent" or sandbox="inherit".'
      : undefined;
  }
  if (params.childSandboxed || (!params.requesterSandboxed && params.sandbox !== "require")) {
    return undefined;
  }
  return params.requesterSandboxed
    ? "Sandboxed sessions cannot spawn unsandboxed subagents. Set a sandboxed target agent or use the same agent runtime."
    : 'sessions_spawn sandbox="require" needs a sandboxed target runtime. Pick a sandboxed agentId or use sandbox="inherit".';
}
