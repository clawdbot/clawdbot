// ACP session binding helpers — conversation and thread bindings for spawned sessions.
import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "@openclaw/acp-core/runtime/session-identifiers";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getChannelPlugin, normalizeChannelId } from "../../../channels/plugins/index.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../../../channels/thread-bindings-messages.js";
import {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  requiresNativeThreadContextForThreadHere,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingPlacementForCurrentContext,
  resolveThreadBindingSpawnPolicy,
} from "../../../channels/thread-bindings-policy.js";
import type { SessionAcpMeta } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { normalizeConversationRef } from "../../../infra/outbound/session-binding-normalization.js";
import {
  getSessionBindingService,
  type ConversationRef,
  type SessionBindingPlacement,
  type SessionBindingRecord,
  type SessionBindingService,
} from "../../../infra/outbound/session-binding-service.js";
import type { ReplyPayload } from "../../types.js";
import type { HandleCommandsParams } from "../commands-types.js";
import { resolveAcpCommandAccountId, resolveAcpCommandBindingContext } from "./context.js";
import type { AcpSpawnBindMode, AcpSpawnThreadMode } from "./shared.js";

export function resolveAcpBindingLabelNoun(params: {
  conversationId?: string;
  placement: "current" | "child";
  threadId?: string;
}): string {
  if (params.placement === "child") {
    return "thread";
  }
  if (!params.threadId) {
    return "conversation";
  }
  return params.conversationId === params.threadId ? "thread" : "conversation";
}

export async function resolveBoundReplyPayload(params: {
  binding: SessionBindingRecord;
  placement: "current" | "child";
}): Promise<Pick<ReplyPayload, "channelData" | "delivery" | "presentation"> | undefined> {
  const channelId = normalizeChannelId(params.binding.conversation.channel);
  if (!channelId) {
    return undefined;
  }
  const buildPayload = getChannelPlugin(channelId)?.conversationBindings?.buildBoundReplyPayload;
  if (!buildPayload) {
    return undefined;
  }
  const resolved = await buildPayload({
    operation: "acp-spawn",
    placement: params.placement,
    conversation: params.binding.conversation,
  });
  return resolved ?? undefined;
}

function buildSpawnedAcpBindingMetadata(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  sessionKey: string;
  agentId: string;
  label: string;
  senderId: string;
  sessionMeta?: SessionAcpMeta;
}): Record<string, unknown> {
  return {
    threadName: resolveThreadBindingThreadName({
      agentId: params.agentId,
      label: params.label,
    }),
    agentId: params.agentId,
    label: params.label,
    boundBy: params.senderId || "unknown",
    introText: resolveThreadBindingIntroText({
      agentId: params.agentId,
      label: params.label,
      idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
        cfg: params.cfg,
        channel: params.channel,
        accountId: params.accountId,
      }),
      maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
        cfg: params.cfg,
        channel: params.channel,
        accountId: params.accountId,
      }),
      sessionCwd: resolveAcpSessionCwd(params.sessionMeta),
      sessionDetails: resolveAcpThreadSessionDetailLines({
        sessionKey: params.sessionKey,
        meta: params.sessionMeta,
      }),
    }),
  };
}

async function bindSpawnedAcpSession(params: {
  bindingService: SessionBindingService;
  sessionKey: string;
  conversationRef: ConversationRef;
  placement: SessionBindingPlacement;
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  agentId: string;
  label: string;
  senderId: string;
  sessionMeta?: SessionAcpMeta;
  bindError: string;
}): Promise<{ ok: true; binding: SessionBindingRecord } | { ok: false; error: string }> {
  try {
    const binding = await params.bindingService.bind({
      targetSessionKey: params.sessionKey,
      targetKind: "session",
      conversation: params.conversationRef,
      placement: params.placement,
      metadata: buildSpawnedAcpBindingMetadata({
        cfg: params.cfg,
        channel: params.channel,
        accountId: params.accountId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        label: params.label,
        senderId: params.senderId,
        sessionMeta: params.sessionMeta,
      }),
    });
    return {
      ok: true,
      binding,
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    return {
      ok: false,
      error: message || params.bindError,
    };
  }
}

export async function bindSpawnedAcpSessionToCurrentConversation(params: {
  commandParams: HandleCommandsParams;
  sessionKey: string;
  agentId: string;
  label?: string;
  bindMode: AcpSpawnBindMode;
  sessionMeta?: SessionAcpMeta;
}): Promise<{ ok: true; binding: SessionBindingRecord } | { ok: false; error: string }> {
  if (params.bindMode === "off") {
    return {
      ok: false,
      error: "internal: conversation binding is disabled for this spawn",
    };
  }

  const bindingContext = resolveAcpCommandBindingContext(params.commandParams);
  const channel = bindingContext.channel;
  if (!channel) {
    return {
      ok: false,
      error: "ACP current-conversation binding requires a channel context.",
    };
  }

  const accountId = resolveAcpCommandAccountId(params.commandParams);
  const bindingPolicy = resolveThreadBindingSpawnPolicy({
    cfg: params.commandParams.cfg,
    channel,
    accountId,
    kind: "acp",
  });
  if (!bindingPolicy.enabled) {
    return {
      ok: false,
      error: formatThreadBindingDisabledError({
        channel: bindingPolicy.channel,
        accountId: bindingPolicy.accountId,
        kind: "acp",
      }),
    };
  }

  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    channel: bindingPolicy.channel,
    accountId: bindingPolicy.accountId,
  });
  if (!capabilities.adapterAvailable || !capabilities.bindSupported) {
    return {
      ok: false,
      error: `Conversation bindings are unavailable for ${channel}.`,
    };
  }
  if (!capabilities.placements.includes("current")) {
    return {
      ok: false,
      error: `Conversation bindings do not support current placement for ${channel}.`,
    };
  }

  const currentConversationId = normalizeOptionalString(bindingContext.conversationId) ?? "";
  if (!currentConversationId) {
    return {
      ok: false,
      error: `--bind here requires running /acp spawn inside an active ${channel} conversation.`,
    };
  }

  const senderId = normalizeOptionalString(params.commandParams.command.senderId) ?? "";
  const conversationRef = normalizeConversationRef({
    channel: bindingPolicy.channel,
    accountId: bindingPolicy.accountId,
    conversationId: currentConversationId,
    parentConversationId: bindingContext.parentConversationId,
  });
  const existingBinding = bindingService.resolveByConversation(conversationRef);
  const boundBy = normalizeOptionalString(existingBinding?.metadata?.boundBy) ?? "";
  if (existingBinding && boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
    const currentLabel = resolveAcpBindingLabelNoun({
      placement: "current",
      threadId: bindingContext.threadId,
      conversationId: currentConversationId,
    });
    return {
      ok: false,
      error: `Only ${boundBy} can rebind this ${currentLabel}.`,
    };
  }

  const label = params.label || params.agentId;
  return bindSpawnedAcpSession({
    bindingService,
    sessionKey: params.sessionKey,
    conversationRef,
    placement: "current",
    cfg: params.commandParams.cfg,
    channel: bindingPolicy.channel,
    accountId: bindingPolicy.accountId,
    agentId: params.agentId,
    label,
    senderId,
    sessionMeta: params.sessionMeta,
    bindError: `Failed to bind the current ${channel} conversation to the new ACP session.`,
  });
}

export async function bindSpawnedAcpSessionToThread(params: {
  commandParams: HandleCommandsParams;
  sessionKey: string;
  agentId: string;
  label?: string;
  threadMode: AcpSpawnThreadMode;
  sessionMeta?: SessionAcpMeta;
}): Promise<{ ok: true; binding: SessionBindingRecord } | { ok: false; error: string }> {
  const { commandParams, threadMode } = params;
  if (threadMode === "off") {
    return {
      ok: false,
      error: "internal: thread binding is disabled for this spawn",
    };
  }

  const bindingContext = resolveAcpCommandBindingContext(commandParams);
  const channel = bindingContext.channel;
  if (!channel) {
    return {
      ok: false,
      error: "ACP thread binding requires a channel context.",
    };
  }

  const accountId = resolveAcpCommandAccountId(commandParams);
  const spawnPolicy = resolveThreadBindingSpawnPolicy({
    cfg: commandParams.cfg,
    channel,
    accountId,
    kind: "acp",
  });
  if (!spawnPolicy.enabled) {
    return {
      ok: false,
      error: formatThreadBindingDisabledError({
        channel: spawnPolicy.channel,
        accountId: spawnPolicy.accountId,
        kind: "acp",
      }),
    };
  }
  if (!spawnPolicy.spawnEnabled) {
    return {
      ok: false,
      error: formatThreadBindingSpawnDisabledError({
        channel: spawnPolicy.channel,
        accountId: spawnPolicy.accountId,
        kind: "acp",
      }),
    };
  }

  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    channel: spawnPolicy.channel,
    accountId: spawnPolicy.accountId,
  });
  if (!capabilities.adapterAvailable) {
    return {
      ok: false,
      error: `Thread bindings are unavailable for ${channel}.`,
    };
  }
  if (!capabilities.bindSupported) {
    return {
      ok: false,
      error: `Thread bindings are unavailable for ${channel}.`,
    };
  }

  const currentThreadId = bindingContext.threadId ?? "";
  const currentConversationId = normalizeOptionalString(bindingContext.conversationId) ?? "";
  const requiresThreadIdForHere = requiresNativeThreadContextForThreadHere(channel);
  if (
    threadMode === "here" &&
    ((requiresThreadIdForHere && !currentThreadId) ||
      (!requiresThreadIdForHere && !currentConversationId))
  ) {
    return {
      ok: false,
      error: `--thread here requires running /acp spawn inside an active ${channel} thread/conversation.`,
    };
  }

  const placement = resolveThreadBindingPlacementForCurrentContext({
    channel,
    threadId: currentThreadId || undefined,
  });
  if (!capabilities.placements.includes(placement)) {
    return {
      ok: false,
      error: `Thread bindings do not support ${placement} placement for ${channel}.`,
    };
  }
  if (!currentConversationId) {
    return {
      ok: false,
      error: `Could not resolve a ${channel} conversation for ACP thread spawn.`,
    };
  }

  const senderId = normalizeOptionalString(commandParams.command.senderId) ?? "";
  const conversationRef = normalizeConversationRef({
    channel: spawnPolicy.channel,
    accountId: spawnPolicy.accountId,
    conversationId: currentConversationId,
    parentConversationId: bindingContext.parentConversationId,
  });
  if (placement === "current") {
    const existingBinding = bindingService.resolveByConversation(conversationRef);
    const boundBy = normalizeOptionalString(existingBinding?.metadata?.boundBy) ?? "";
    if (existingBinding && boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
      const currentLabel = resolveAcpBindingLabelNoun({
        placement,
        threadId: currentThreadId || undefined,
        conversationId: currentConversationId,
      });
      return {
        ok: false,
        error: `Only ${boundBy} can rebind this ${currentLabel}.`,
      };
    }
  }

  const label = params.label || params.agentId;
  return bindSpawnedAcpSession({
    bindingService,
    sessionKey: params.sessionKey,
    conversationRef,
    placement,
    cfg: commandParams.cfg,
    channel: spawnPolicy.channel,
    accountId: spawnPolicy.accountId,
    agentId: params.agentId,
    label,
    senderId,
    sessionMeta: params.sessionMeta,
    bindError: `Failed to bind a ${channel} thread/conversation to the new ACP session.`,
  });
}
