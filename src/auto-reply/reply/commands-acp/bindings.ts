// ACP session binding helpers — conversation and thread bindings for spawned sessions.
import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "@openclaw/acp-core/runtime/session-identifiers";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveChannelDefaultBindingPlacement } from "../../../channels/conversation-resolution.js";
import { getChannelPlugin, normalizeChannelId } from "../../../channels/plugins/index.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../../../channels/thread-bindings-messages.js";
import {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
} from "../../../channels/thread-bindings-policy.js";
import type { SessionAcpMeta } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { normalizeConversationRef } from "../../../infra/outbound/session-binding-normalization.js";
import {
  getSessionBindingService,
  type SessionBindingPlacement,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import type { ReplyPayload } from "../../types.js";
import type { HandleCommandsParams } from "../commands-types.js";
import { resolveAcpCommandBindingContext } from "./context.js";

function resolveAcpBindingLabelNoun(params: {
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

export type SpawnedAcpSessionBinding = {
  binding: SessionBindingRecord;
  placement: SessionBindingPlacement;
  labelNoun: string;
};

export async function bindSpawnedAcpSession(params: {
  commandParams: HandleCommandsParams;
  sessionKey: string;
  agentId: string;
  label?: string;
  mode: "conversation" | "thread-here" | "thread-auto";
  sessionMeta?: SessionAcpMeta;
}): Promise<{ ok: true; bound: SpawnedAcpSessionBinding } | { ok: false; error: string }> {
  const { commandParams } = params;
  const currentConversation = params.mode === "conversation";
  const bindingContext = resolveAcpCommandBindingContext(commandParams);
  const { channel, accountId, conversationId, threadId } = bindingContext;
  if (!channel) {
    return {
      ok: false,
      error: `ACP ${currentConversation ? "current-conversation" : "thread"} binding requires a channel context.`,
    };
  }

  const policy = resolveThreadBindingSpawnPolicy({
    cfg: commandParams.cfg,
    channel,
    accountId,
    kind: "acp",
  });
  if (!policy.enabled) {
    return {
      ok: false,
      error: formatThreadBindingDisabledError({ ...policy, kind: "acp" }),
    };
  }
  // --bind here attaches the current conversation without enabling child-thread spawning.
  if (!currentConversation && !policy.spawnEnabled) {
    return {
      ok: false,
      error: formatThreadBindingSpawnDisabledError({ ...policy, kind: "acp" }),
    };
  }

  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    channel: policy.channel,
    accountId: policy.accountId,
  });
  const bindingLabel = currentConversation ? "Conversation" : "Thread";
  if (!capabilities.adapterAvailable || !capabilities.bindSupported) {
    return {
      ok: false,
      error: `${bindingLabel} bindings are unavailable for ${channel}.`,
    };
  }
  const defaultPlacement = currentConversation
    ? "current"
    : (resolveChannelDefaultBindingPlacement(channel) ?? "current");
  if (params.mode === "thread-here") {
    const hasRequiredContext = defaultPlacement === "child" ? threadId : conversationId;
    if (!hasRequiredContext) {
      return {
        ok: false,
        error: `--thread here requires running /acp spawn inside an active ${channel} thread/conversation.`,
      };
    }
  }
  const placement = currentConversation || threadId ? "current" : defaultPlacement;
  if (!capabilities.placements.includes(placement)) {
    return {
      ok: false,
      error: `${bindingLabel} bindings do not support ${placement} placement for ${channel}.`,
    };
  }
  if (!conversationId) {
    return {
      ok: false,
      error: currentConversation
        ? `--bind here requires running /acp spawn inside an active ${channel} conversation.`
        : `Could not resolve a ${channel} conversation for ACP thread spawn.`,
    };
  }

  const senderId = normalizeOptionalString(commandParams.command.senderId) ?? "";
  const conversationRef = normalizeConversationRef({
    channel: policy.channel,
    accountId: policy.accountId,
    conversationId,
    parentConversationId: bindingContext.parentConversationId,
  });
  const labelNoun = resolveAcpBindingLabelNoun({ placement, threadId, conversationId });
  if (placement === "current") {
    const existingBinding = bindingService.resolveByConversation(conversationRef);
    const boundBy = normalizeOptionalString(existingBinding?.metadata?.boundBy) ?? "";
    if (existingBinding && boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
      return { ok: false, error: `Only ${boundBy} can rebind this ${labelNoun}.` };
    }
  }

  try {
    const binding = await bindingService.bind({
      targetSessionKey: params.sessionKey,
      targetKind: "session",
      conversation: conversationRef,
      placement,
      metadata: buildSpawnedAcpBindingMetadata({
        cfg: commandParams.cfg,
        channel: policy.channel,
        accountId: policy.accountId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        label: params.label || params.agentId,
        senderId,
        sessionMeta: params.sessionMeta,
      }),
    });
    return { ok: true, bound: { binding, placement, labelNoun } };
  } catch (error) {
    return {
      ok: false,
      error:
        formatErrorMessage(error) ||
        (currentConversation
          ? `Failed to bind the current ${channel} conversation to the new ACP session.`
          : `Failed to bind a ${channel} thread/conversation to the new ACP session.`),
    };
  }
}
