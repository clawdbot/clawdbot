import { randomUUID } from "node:crypto";
import { getAcpSessionManager } from "../../../acp/control-plane/manager.js";
import { resolveAcpSessionResolutionError } from "../../../acp/control-plane/manager.utils.js";
import {
  cleanupFailedAcpSpawn,
  type AcpSpawnRuntimeCloseHandle,
} from "../../../acp/control-plane/spawn.js";
import {
  isAcpEnabledByPolicy,
  resolveAcpAgentPolicyError,
  resolveAcpDispatchPolicyError,
  resolveAcpDispatchPolicyMessage,
} from "../../../acp/policy.js";
import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "../../../acp/runtime/session-identifiers.js";
import { resolveAcpSpawnRuntimePolicyError } from "../../../agents/acp-spawn.js";
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
import { updateSessionStore } from "../../../config/sessions.js";
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
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import type { ReplyPayload } from "../../types.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
import {
  resolveAcpCommandAccountId,
  resolveAcpCommandBindingContext,
  resolveAcpCommandConversationId,
  resolveAcpCommandThreadId,
} from "./context.js";
import {
  ACP_STEER_OUTPUT_LIMIT,
  collectAcpErrorText,
  parseSpawnInput,
  parseSteerInput,
  resolveCommandRequestId,
  stopWithText,
  type AcpSpawnBindMode,
  type AcpSpawnThreadMode,
  withAcpCommandErrorBoundary,
} from "./shared.js";
import { resolveAcpTargetSessionKey } from "./targets.js";

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

async function resolveBoundReplyPayload(params: {
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

async function bindSpawnedAcpSessionToCurrentConversation(params: {
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

async function bindSpawnedAcpSessionToThread(params: {
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

async function cleanupFailedSpawn(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  shouldDeleteSession: boolean;
  initializedRuntime?: AcpSpawnRuntimeCloseHandle;
}) {
  await cleanupFailedAcpSpawn({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    shouldDeleteSession: params.shouldDeleteSession,
    deleteTranscript: false,
    runtimeCloseHandle: params.initializedRuntime,
  });
}

async function persistSpawnedSessionLabel(params: {
  commandParams: HandleCommandsParams;
  sessionKey: string;
  label?: string;
}): Promise<void> {
  const label = normalizeOptionalString(params.label);
  if (!label) {
    return;
  }

  const now = Date.now();
  if (params.commandParams.sessionStore) {
    const existing = params.commandParams.sessionStore[params.sessionKey];
    if (existing) {
      params.commandParams.sessionStore[params.sessionKey] = {
        ...existing,
        label,
        updatedAt: now,
      };
    }
  }
  if (!params.commandParams.storePath) {
    return;
  }
  await updateSessionStore(params.commandParams.storePath, (store) => {
    const existing = store[params.sessionKey];
    if (!existing) {
      return;
    }
    store[params.sessionKey] = {
      ...existing,
      label,
      updatedAt: now,
    };
  });
}

export async function handleAcpSpawnAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  if (!isAcpEnabledByPolicy(params.cfg)) {
    return stopWithText("ACP is disabled by policy (`acp.enabled=false`).");
  }

  const parsed = parseSpawnInput(params, restTokens);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }

  const spawn = parsed.value;
  const runtimePolicyError = resolveAcpSpawnRuntimePolicyError({
    cfg: params.cfg,
    requesterSessionKey: params.sessionKey,
  });
  if (runtimePolicyError) {
    return stopWithText(`⚠️ ${runtimePolicyError}`);
  }
  const agentPolicyError = resolveAcpAgentPolicyError(params.cfg, spawn.agentId);
  if (agentPolicyError) {
    return stopWithText(
      collectAcpErrorText({
        error: agentPolicyError,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "ACP target agent is not allowed by policy.",
      }),
    );
  }

  const acpManager = getAcpSessionManager();
  const sessionKey = `agent:${spawn.agentId}:acp:${randomUUID()}`;

  let initializedBackend = "";
  let initializedMeta: SessionAcpMeta | undefined;
  let initializedRuntime: AcpSpawnRuntimeCloseHandle | undefined;
  try {
    const initialized = await acpManager.initializeSession({
      cfg: params.cfg,
      sessionKey,
      agent: spawn.agentId,
      mode: spawn.mode,
      cwd: spawn.cwd,
    });
    initializedRuntime = {
      runtime: initialized.runtime,
      handle: initialized.handle,
    };
    initializedBackend = initialized.handle.backend || initialized.meta.backend;
    initializedMeta = initialized.meta;
  } catch (err) {
    return stopWithText(
      collectAcpErrorText({
        error: err,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Could not initialize ACP session runtime.",
      }),
    );
  }

  let binding: SessionBindingRecord | null = null;
  if (spawn.bind !== "off") {
    const bound = await bindSpawnedAcpSessionToCurrentConversation({
      commandParams: params,
      sessionKey,
      agentId: spawn.agentId,
      label: spawn.label,
      bindMode: spawn.bind,
      sessionMeta: initializedMeta,
    });
    if (!bound.ok) {
      await cleanupFailedSpawn({
        cfg: params.cfg,
        sessionKey,
        shouldDeleteSession: true,
        initializedRuntime,
      });
      return stopWithText(`⚠️ ${bound.error}`);
    }
    binding = bound.binding;
  } else if (spawn.thread !== "off") {
    const bound = await bindSpawnedAcpSessionToThread({
      commandParams: params,
      sessionKey,
      agentId: spawn.agentId,
      label: spawn.label,
      threadMode: spawn.thread,
      sessionMeta: initializedMeta,
    });
    if (!bound.ok) {
      await cleanupFailedSpawn({
        cfg: params.cfg,
        sessionKey,
        shouldDeleteSession: true,
        initializedRuntime,
      });
      return stopWithText(`⚠️ ${bound.error}`);
    }
    binding = bound.binding;
  }

  try {
    await persistSpawnedSessionLabel({
      commandParams: params,
      sessionKey,
      label: spawn.label,
    });
  } catch (err) {
    await cleanupFailedSpawn({
      cfg: params.cfg,
      sessionKey,
      shouldDeleteSession: true,
      initializedRuntime,
    });
    const message = formatErrorMessage(err);
    return stopWithText(`⚠️ ACP spawn failed: ${message}`);
  }

  const parts = [
    `✅ Spawned ACP session ${sessionKey} (${spawn.mode}, backend ${initializedBackend}).`,
  ];
  if (binding) {
    const currentConversationId =
      normalizeOptionalString(resolveAcpCommandConversationId(params)) ?? "";
    const boundConversationId = binding.conversation.conversationId.trim();
    const bindingPlacement =
      currentConversationId && boundConversationId === currentConversationId ? "current" : "child";
    const placementLabel = resolveAcpBindingLabelNoun({
      conversationId: currentConversationId,
      placement: bindingPlacement,
      threadId: resolveAcpCommandThreadId(params),
    });
    if (bindingPlacement === "current") {
      parts.push(`Bound this ${placementLabel} to ${sessionKey}.`);
    } else {
      parts.push(`Created ${placementLabel} ${boundConversationId} and bound it to ${sessionKey}.`);
    }
    const boundReplyPayload = await resolveBoundReplyPayload({
      binding,
      placement: bindingPlacement,
    });
    if (boundReplyPayload) {
      return {
        shouldContinue: false,
        reply: {
          text: parts.join(" "),
          ...boundReplyPayload,
        },
      };
    }
  } else {
    parts.push(
      "Session is unbound (use /acp spawn ... --bind here to bind this conversation, or /focus <session-key> where supported).",
    );
  }

  const dispatchNote = resolveAcpDispatchPolicyMessage(params.cfg);
  if (dispatchNote) {
    parts.push(`ℹ️ ${dispatchNote}`);
  }

  return stopWithText(parts.join(" "));
}

function resolveAcpSessionForCommandOrStop(params: {
  acpManager: ReturnType<typeof getAcpSessionManager>;
  cfg: OpenClawConfig;
  sessionKey: string;
}): CommandHandlerResult | null {
  const resolved = params.acpManager.resolveSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const error = resolveAcpSessionResolutionError(resolved);
  if (error) {
    return stopWithText(
      collectAcpErrorText({
        error,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: error.message,
      }),
    );
  }
  return null;
}

async function resolveAcpTokenTargetSessionKeyOrStop(params: {
  commandParams: HandleCommandsParams;
  restTokens: string[];
}): Promise<string | CommandHandlerResult> {
  const token = normalizeOptionalString(params.restTokens.join(" "));
  const target = await resolveAcpTargetSessionKey({
    commandParams: params.commandParams,
    token,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }
  return target.sessionKey;
}

async function withResolvedAcpSessionTarget(params: {
  commandParams: HandleCommandsParams;
  restTokens: string[];
  run: (ctx: {
    acpManager: ReturnType<typeof getAcpSessionManager>;
    sessionKey: string;
  }) => Promise<CommandHandlerResult>;
}): Promise<CommandHandlerResult> {
  const acpManager = getAcpSessionManager();
  const targetSessionKey = await resolveAcpTokenTargetSessionKeyOrStop({
    commandParams: params.commandParams,
    restTokens: params.restTokens,
  });
  if (typeof targetSessionKey !== "string") {
    return targetSessionKey;
  }
  const guardFailure = resolveAcpSessionForCommandOrStop({
    acpManager,
    cfg: params.commandParams.cfg,
    sessionKey: targetSessionKey,
  });
  if (guardFailure) {
    return guardFailure;
  }
  return await params.run({
    acpManager,
    sessionKey: targetSessionKey,
  });
}

export async function handleAcpCancelAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await withResolvedAcpSessionTarget({
    commandParams: params,
    restTokens,
    run: async ({ acpManager, sessionKey }) =>
      await withAcpCommandErrorBoundary({
        run: async () =>
          await acpManager.cancelSession({
            cfg: params.cfg,
            sessionKey,
            reason: "manual-cancel",
          }),
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "ACP cancel failed before completion.",
        onSuccess: () => stopWithText(`✅ Cancel requested for ACP session ${sessionKey}.`),
      }),
  });
}

async function runAcpSteer(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  instruction: string;
  requestId: string;
}): Promise<string> {
  const acpManager = getAcpSessionManager();
  let output = "";

  await acpManager.runTurn({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    text: params.instruction,
    mode: "steer",
    requestId: params.requestId,
    onEvent: (event) => {
      if (event.type !== "text_delta") {
        return;
      }
      if (event.stream && event.stream !== "output") {
        return;
      }
      if (event.text) {
        output += event.text;
        if (output.length > ACP_STEER_OUTPUT_LIMIT) {
          output = `${output.slice(0, ACP_STEER_OUTPUT_LIMIT)}…`;
        }
      }
    },
  });
  return output.trim();
}

export async function handleAcpSteerAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const dispatchPolicyError = resolveAcpDispatchPolicyError(params.cfg);
  if (dispatchPolicyError) {
    return stopWithText(
      collectAcpErrorText({
        error: dispatchPolicyError,
        fallbackCode: "ACP_DISPATCH_DISABLED",
        fallbackMessage: dispatchPolicyError.message,
      }),
    );
  }

  const parsed = parseSteerInput(restTokens);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  const acpManager = getAcpSessionManager();

  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token: parsed.value.sessionToken,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }

  const guardFailure = resolveAcpSessionForCommandOrStop({
    acpManager,
    cfg: params.cfg,
    sessionKey: target.sessionKey,
  });
  if (guardFailure) {
    return guardFailure;
  }

  return await withAcpCommandErrorBoundary({
    run: async () =>
      await runAcpSteer({
        cfg: params.cfg,
        sessionKey: target.sessionKey,
        instruction: parsed.value.instruction,
        requestId: `${resolveCommandRequestId(params)}:steer`,
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "ACP steer failed before completion.",
    onSuccess: (steerOutput) => {
      if (!steerOutput) {
        return stopWithText(`✅ ACP steer sent to ${target.sessionKey}.`);
      }
      return stopWithText(`✅ ACP steer sent to ${target.sessionKey}.\n${steerOutput}`);
    },
  });
}

export async function handleAcpCloseAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await withResolvedAcpSessionTarget({
    commandParams: params,
    restTokens,
    run: async ({ acpManager, sessionKey }) => {
      let runtimeNotice = "";
      try {
        const closed = await acpManager.closeSession({
          cfg: params.cfg,
          sessionKey,
          reason: "manual-close",
          allowBackendUnavailable: true,
          clearMeta: true,
        });
        runtimeNotice = closed.runtimeNotice ? ` (${closed.runtimeNotice})` : "";
      } catch (error) {
        return stopWithText(
          collectAcpErrorText({
            error,
            fallbackCode: "ACP_TURN_FAILED",
            fallbackMessage: "ACP close failed before completion.",
          }),
        );
      }

      const removedBindings = await getSessionBindingService().unbind({
        targetSessionKey: sessionKey,
        reason: "manual",
      });

      return stopWithText(
        `✅ Closed ACP session ${sessionKey}${runtimeNotice}. Removed ${removedBindings.length} binding${removedBindings.length === 1 ? "" : "s"}.`,
      );
    },
  });
}
