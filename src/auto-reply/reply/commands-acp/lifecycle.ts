// Implements ACP lifecycle commands for start, stop, reset, and resume.
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
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
import { resolveSessionStorePathForAcp } from "../../../acp/runtime/session-meta.js";
import {
  closeAdmittedRunDelegatedAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../../agents/admitted-run-context.js";
import { resolveSpawnedWorkspaceInheritance } from "../../../agents/spawned-context.js";
import {
  resolveAcpSpawnRuntimePolicyError,
  resolveRuntimeCwdForAcpSpawn,
} from "../../../agents/subagents/spawn/acp-spawn.js";
import {
  readChannelContextAdmissionEvidence,
  type ChannelAdmissionEvidence,
} from "../../../channels/message-access/admission-evidence.js";
import { updateSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { SessionAcpMeta } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { consumeChannelRunAdmission } from "../channel-run-admission.js";
import { commandReply } from "../command-gates.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
import {
  bindSpawnedAcpSession,
  resolveBoundReplyPayload,
  type SpawnedAcpSessionBinding,
} from "./bindings.js";
import {
  ACP_STEER_OUTPUT_LIMIT,
  collectAcpErrorText,
  parseSpawnInput,
  parseSteerInput,
  resolveCommandRequestId,
  withAcpCommandErrorBoundary,
} from "./shared.js";
import { resolveAcpTargetSessionKey } from "./targets.js";
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
  // Cross-agent ACP keys belong to the target agent's store, which can differ
  // from the requester's store during spawn.
  const { storePath } = resolveSessionStorePathForAcp({
    cfg: params.commandParams.cfg,
    sessionKey: params.sessionKey,
  });

  // Only the requester store has an in-memory snapshot to keep coherent.
  if (params.commandParams.sessionStore && params.commandParams.storePath === storePath) {
    const existing = params.commandParams.sessionStore[params.sessionKey];
    if (existing) {
      params.commandParams.sessionStore[params.sessionKey] = {
        ...existing,
        label,
        updatedAt: now,
      };
    }
  }
  await updateSessionEntry(
    {
      storePath,
      sessionKey: params.sessionKey,
    },
    () => ({
      label,
      updatedAt: now,
    }),
  );
}

export async function handleAcpSpawnAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  if (!isAcpEnabledByPolicy(params.cfg)) {
    return commandReply("ACP is disabled by policy (`acp.enabled=false`).");
  }

  const parsed = parseSpawnInput(params, restTokens);
  if (!parsed.ok) {
    return commandReply(`⚠️ ${parsed.error}`);
  }

  const spawn = parsed.value;
  const runtimePolicyError = resolveAcpSpawnRuntimePolicyError({
    cfg: params.cfg,
    requesterSessionKey: params.sessionKey,
  });
  if (runtimePolicyError) {
    return commandReply(`⚠️ ${runtimePolicyError}`);
  }
  const agentPolicyError = resolveAcpAgentPolicyError(params.cfg, spawn.agentId);
  if (agentPolicyError) {
    return commandReply(
      collectAcpErrorText({
        error: agentPolicyError,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "ACP target agent is not allowed by policy.",
      }),
    );
  }

  const acpManager = getAcpSessionManager();
  const sessionKey = `agent:${spawn.agentId}:acp:${randomUUID()}`;
  const resolvedCwd = resolveSpawnedWorkspaceInheritance({
    config: params.cfg,
    targetAgentId: spawn.agentId,
    requesterSessionKey: params.sessionKey,
    explicitWorkspaceDir: spawn.cwd,
  });
  let runtimeCwd: string | undefined;
  try {
    runtimeCwd = await resolveRuntimeCwdForAcpSpawn({
      resolvedCwd,
      explicitCwd: spawn.cwd,
    });
  } catch (error) {
    return commandReply(
      collectAcpErrorText({
        error,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Could not resolve ACP session workspace.",
      }),
    );
  }

  let initializedBackend;
  let initializedMeta: SessionAcpMeta | undefined;
  let initializedRuntime: AcpSpawnRuntimeCloseHandle | undefined;
  try {
    const initialized = await acpManager.initializeSession({
      cfg: params.cfg,
      sessionKey,
      agent: spawn.agentId,
      mode: spawn.mode,
      cwd: runtimeCwd,
    });
    initializedRuntime = {
      runtime: initialized.runtime,
      handle: initialized.handle,
    };
    initializedBackend = initialized.handle.backend || initialized.meta.backend;
    initializedMeta = initialized.meta;
  } catch (err) {
    return commandReply(
      collectAcpErrorText({
        error: err,
        fallbackCode: "ACP_SESSION_INIT_FAILED",
        fallbackMessage: "Could not initialize ACP session runtime.",
      }),
    );
  }

  let boundSession: SpawnedAcpSessionBinding | undefined;
  if (spawn.bind !== "off" || spawn.thread !== "off") {
    const result = await bindSpawnedAcpSession({
      commandParams: params,
      sessionKey,
      agentId: spawn.agentId,
      label: spawn.label,
      mode:
        spawn.bind !== "off"
          ? "conversation"
          : spawn.thread === "here"
            ? "thread-here"
            : "thread-auto",
      sessionMeta: initializedMeta,
    });
    if (!result.ok) {
      await cleanupFailedSpawn({
        cfg: params.cfg,
        sessionKey,
        shouldDeleteSession: true,
        initializedRuntime,
      });
      return commandReply(`⚠️ ${result.error}`);
    }
    boundSession = result.bound;
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
    return commandReply(`⚠️ ACP spawn failed: ${message}`);
  }

  const parts = [
    `✅ Spawned ACP session ${sessionKey} (${spawn.mode}, backend ${initializedBackend}).`,
  ];
  if (boundSession) {
    const { binding, placement, labelNoun } = boundSession;
    const boundConversationId = binding.conversation.conversationId.trim();
    if (placement === "current") {
      parts.push(`Bound this ${labelNoun} to ${sessionKey}.`);
    } else {
      parts.push(`Created ${labelNoun} ${boundConversationId} and bound it to ${sessionKey}.`);
    }
    const boundReplyPayload = await resolveBoundReplyPayload({
      binding,
      placement,
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
      "Session is unbound (use /acp spawn ... --bind here to create a session bound to this conversation).",
    );
  }

  const dispatchNote = resolveAcpDispatchPolicyMessage(params.cfg);
  if (dispatchNote) {
    parts.push(`ℹ️ ${dispatchNote}`);
  }

  return commandReply(parts.join(" "));
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
    return commandReply(
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
    return commandReply(`⚠️ ${target.error}`);
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
        onSuccess: () => commandReply(`✅ Cancel requested for ACP session ${sessionKey}.`),
      }),
  });
}

async function runAcpSteer(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  instruction: string;
  requestId: string;
  channelAdmissionEvidence?: ChannelAdmissionEvidence;
}): Promise<string> {
  const acpManager = getAcpSessionManager();
  let output = "";
  const channelAdmission = consumeChannelRunAdmission(params.channelAdmissionEvidence);
  const admittedRunContext = await prepareAgentRunAdmission({
    cfg: params.cfg,
    operationalRunInstance: createOperationalRunInstanceRef(params.requestId),
    facts: {
      runId: params.requestId,
      agentId: resolveAgentIdFromSessionKey(params.sessionKey),
      ingress: {
        kind: "acp",
        boundary: "acp.command.steer",
        state: channelAdmission.ingressState,
      },
      ...channelAdmission.facts,
    },
    onAdmitted: channelAdmission.onAdmitted,
  }).admit("acp");

  try {
    await acpManager.runTurn({
      admittedRunContext,
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      provenance: "agent",
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
            output = `${truncateUtf16Safe(output, ACP_STEER_OUTPUT_LIMIT)}…`;
          }
        }
      },
    });
  } finally {
    closeAdmittedRunDelegatedAuthority(admittedRunContext);
  }
  return output.trim();
}

export async function handleAcpSteerAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const dispatchPolicyError = resolveAcpDispatchPolicyError(params.cfg);
  if (dispatchPolicyError) {
    return commandReply(
      collectAcpErrorText({
        error: dispatchPolicyError,
        fallbackCode: "ACP_DISPATCH_DISABLED",
        fallbackMessage: dispatchPolicyError.message,
      }),
    );
  }

  const parsed = parseSteerInput(restTokens);
  if (!parsed.ok) {
    return commandReply(`⚠️ ${parsed.error}`);
  }
  const acpManager = getAcpSessionManager();

  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token: parsed.value.sessionToken,
  });
  if (!target.ok) {
    return commandReply(`⚠️ ${target.error}`);
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
        channelAdmissionEvidence: readChannelContextAdmissionEvidence(params.rootCtx ?? params.ctx),
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "ACP steer failed before completion.",
    onSuccess: (steerOutput) => {
      if (!steerOutput) {
        return commandReply(`✅ ACP steer sent to ${target.sessionKey}.`);
      }
      return commandReply(`✅ ACP steer sent to ${target.sessionKey}.\n${steerOutput}`);
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
      let runtimeNotice;
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
        return commandReply(
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

      return commandReply(
        `✅ Closed ACP session ${sessionKey}${runtimeNotice}. Removed ${removedBindings.length} binding${removedBindings.length === 1 ? "" : "s"}.`,
      );
    },
  });
}
