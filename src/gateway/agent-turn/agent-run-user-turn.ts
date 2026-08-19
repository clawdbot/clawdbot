import { randomUUID } from "node:crypto";
import {
  claimExecApprovalFollowupRuntimeHandoff,
  finalizeExecApprovalFollowupRuntimeHandoff,
  releaseExecApprovalFollowupRuntimeHandoff,
} from "../../agents/bash-tools.exec-approval-followup-state.js";
import {
  buildExecApprovalContinuationPrompt,
  EXEC_APPROVAL_FOLLOWUP_HANDOFF_MESSAGE,
  type ExecApprovalContinuationPromptRange,
} from "../../agents/bash-tools.exec-approval-output.js";
import type { ExecElevatedDefaults } from "../../agents/bash-tools.exec-types.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { deleteMediaBuffer } from "../../media/store.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
  type UserTurnInput,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import {
  INLINE_IMAGE_DURABLE_OMISSION_MARKER,
  persistInboundImagesForTranscript,
  type ChatImageContent,
  type OffloadedRef,
} from "../chat-attachments.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import { resolveSessionRuntimeCwd } from "../server-methods/agent-session-reset.js";
import { gatewayClientSenderFields } from "../server-methods/gateway-client-identity.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import {
  clientHasAdminScope,
  shouldSuppressAgentPromptPersistence,
  type RestoredCronContinuation,
} from "./agent-handler-helpers.js";
import type { AgentTurnContext, AgentTurnPrincipal } from "./types.js";

export type PreparedAgentRunUserTurn = {
  bashElevated?: ExecElevatedDefaults;
  claimedExecApprovalFollowupHandoffId?: string;
  execApprovalFollowupHandoffClaimId: string;
  execApprovalContinuationPromptRange?: ExecApprovalContinuationPromptRange;
  execApprovalContinuationTranscriptPromptRange?: ExecApprovalContinuationPromptRange;
  message: string;
  recorder?: UserTurnTranscriptRecorder;
  senderIsOwner: boolean;
  suppressPromptPersistence: boolean;
};

export async function prepareAgentRunUserTurn(params: {
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  cfgForAgent?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  resolvedSessionKey?: string;
  requestedSessionKeyRaw?: string;
  admittedSessionId: string;
  activeSessionAgentId: string;
  resolvedThreadId?: string | number;
  suppressVisibleSessionEffects: boolean;
  requestedPromptPersistenceSuppression: boolean;
  restoredCronContinuation?: RestoredCronContinuation;
  canUseInternalRuntimeHandoff: boolean;
  execApprovalFollowupApprovalId?: string;
  message: string;
  effectiveTranscriptInputText: string;
  images: ChatImageContent[];
  offloadedRefs: OffloadedRef[];
  inputProvenance?: InputProvenance;
  runId: string;
  client: AgentTurnPrincipal | null;
  context: AgentTurnContext;
}): Promise<PreparedAgentRunUserTurn> {
  const execApprovalFollowupHandoffClaimId = randomUUID();
  let claimedExecApprovalFollowupHandoffId: string | undefined;
  let durableMediaIds: string[] = [];
  try {
    let execApprovalFollowupRuntimeHandoff =
      params.canUseInternalRuntimeHandoff && params.execApprovalFollowupApprovalId
        ? claimExecApprovalFollowupRuntimeHandoff({
            handoffId: params.request.internalRuntimeHandoffId,
            approvalId: params.execApprovalFollowupApprovalId,
            idempotencyKey: params.runId,
            sessionKey: params.resolvedSessionKey,
            claimId: execApprovalFollowupHandoffClaimId,
          })
        : undefined;
    if (
      !execApprovalFollowupRuntimeHandoff &&
      params.canUseInternalRuntimeHandoff &&
      params.execApprovalFollowupApprovalId &&
      params.requestedSessionKeyRaw &&
      params.requestedSessionKeyRaw !== params.resolvedSessionKey
    ) {
      execApprovalFollowupRuntimeHandoff = claimExecApprovalFollowupRuntimeHandoff({
        handoffId: params.request.internalRuntimeHandoffId,
        approvalId: params.execApprovalFollowupApprovalId,
        idempotencyKey: params.runId,
        sessionKey: params.requestedSessionKeyRaw,
        claimId: execApprovalFollowupHandoffClaimId,
      });
    }
    if (execApprovalFollowupRuntimeHandoff) {
      claimedExecApprovalFollowupHandoffId = params.request.internalRuntimeHandoffId;
    }

    let message = params.message;
    let effectiveTranscriptInputText = params.effectiveTranscriptInputText;
    let execApprovalContinuationPromptRange: ExecApprovalContinuationPromptRange | undefined;
    let execApprovalContinuationTranscriptPromptRange:
      | ExecApprovalContinuationPromptRange
      | undefined;
    if (execApprovalFollowupRuntimeHandoff?.resultText !== undefined) {
      const continuation = buildExecApprovalContinuationPrompt(
        execApprovalFollowupRuntimeHandoff.resultText,
      );
      message = continuation.message;
      effectiveTranscriptInputText = continuation.message;
      execApprovalContinuationPromptRange = continuation.resultRange;
      execApprovalContinuationTranscriptPromptRange = continuation.resultRange;
    } else if (message === EXEC_APPROVAL_FOLLOWUP_HANDOFF_MESSAGE) {
      throw new Error("exec approval followup runtime handoff is unavailable");
    }

    const senderIsOwner = params.restoredCronContinuation
      ? true
      : clientHasAdminScope(params.client);
    const suppressPromptPersistence =
      params.requestedPromptPersistenceSuppression ||
      shouldSuppressAgentPromptPersistence({
        inputProvenance: params.inputProvenance,
        internalEvents: params.request.internalEvents,
      });
    let recorder: UserTurnTranscriptRecorder | undefined;
    if (
      params.resolvedSessionKey &&
      !params.suppressVisibleSessionEffects &&
      !suppressPromptPersistence
    ) {
      const persistedMedia = await persistInboundImagesForTranscript({
        images: params.images,
        offloadedRefs: params.offloadedRefs,
        log: params.context.logGateway,
        logContext: "agent",
      });
      durableMediaIds = persistedMedia.entries.map((entry) => entry.id);
      const media = persistedMedia.entries.map((entry) => entry.fact);
      const slots = persistedMedia.entries.flatMap((entry, factIndex) =>
        entry.imageKind ? [{ kind: entry.imageKind, factIndex }] : [],
      );
      const input: UserTurnInput = {
        text:
          persistedMedia.omission === "inline-image-save-failed"
            ? [effectiveTranscriptInputText, INLINE_IMAGE_DURABLE_OMISSION_MARKER]
                .filter(Boolean)
                .join("\n")
            : effectiveTranscriptInputText,
        timestamp: Date.now(),
        idempotencyKey: buildRunUserTurnIdempotencyKey(params.runId),
        ...gatewayClientSenderFields(params.client),
        senderIsOwner,
        ...(params.inputProvenance ? { provenance: params.inputProvenance } : {}),
        ...(media.length > 0 ? { media } : {}),
        ...(slots.length > 0 ? { mediaImageLayout: { slots } } : {}),
      };
      recorder = createUserTurnTranscriptRecorder({
        input,
        target: () => {
          const loaded = loadSessionEntry(params.resolvedSessionKey!, {
            agentId: params.activeSessionAgentId,
            clone: false,
          });
          const latestEntry = loaded.entry;
          const loadedSessionId = latestEntry?.sessionId?.trim();
          // Session creation is persisted before this phase. No matching entry
          // means the admitted lifecycle instance changed and must fail closed.
          if (!latestEntry || loadedSessionId !== params.admittedSessionId) {
            return undefined;
          }
          return {
            sessionId: latestEntry.sessionId,
            expectedSessionId: params.admittedSessionId,
            sessionKey: params.resolvedSessionKey!,
            sessionEntry: latestEntry,
            sessionStore: loaded.store,
            storePath: loaded.storePath,
            agentId: params.activeSessionAgentId,
            cwd: resolveSessionRuntimeCwd({ sessionEntry: latestEntry }),
            ...(params.resolvedThreadId != null ? { threadId: params.resolvedThreadId } : {}),
            config: params.cfgForAgent ?? params.cfg,
          };
        },
        errorContext: "gateway agent user turn transcript",
        beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
        onPersistenceError: (error) => {
          params.context.logGateway.warn(
            `gateway agent user transcript persistence failed: ${formatForLog(error)}`,
          );
        },
      });
      if (!(await recorder.persistApproved())) {
        throw new Error("agent turn was not durably admitted");
      }
    }

    return {
      ...(execApprovalFollowupRuntimeHandoff?.bashElevated
        ? { bashElevated: execApprovalFollowupRuntimeHandoff.bashElevated }
        : {}),
      ...(claimedExecApprovalFollowupHandoffId ? { claimedExecApprovalFollowupHandoffId } : {}),
      execApprovalFollowupHandoffClaimId,
      ...(execApprovalContinuationPromptRange ? { execApprovalContinuationPromptRange } : {}),
      ...(execApprovalContinuationTranscriptPromptRange
        ? { execApprovalContinuationTranscriptPromptRange }
        : {}),
      message,
      ...(recorder ? { recorder } : {}),
      senderIsOwner,
      suppressPromptPersistence,
    };
  } catch (error) {
    releaseExecApprovalFollowupRuntimeHandoff({
      handoffId: claimedExecApprovalFollowupHandoffId,
      claimId: execApprovalFollowupHandoffClaimId,
    });
    await Promise.allSettled(durableMediaIds.map((id) => deleteMediaBuffer(id, "inbound")));
    throw error;
  }
}

export function finalizePreparedAgentRunUserTurn(prepared: PreparedAgentRunUserTurn): void {
  const handoffId = prepared.claimedExecApprovalFollowupHandoffId;
  if (!handoffId) {
    return;
  }
  if (
    !finalizeExecApprovalFollowupRuntimeHandoff({
      handoffId,
      claimId: prepared.execApprovalFollowupHandoffClaimId,
    })
  ) {
    throw new Error("exec approval followup runtime handoff expired before dispatch");
  }
}

export function releasePreparedAgentRunUserTurn(prepared: PreparedAgentRunUserTurn): void {
  releaseExecApprovalFollowupRuntimeHandoff({
    handoffId: prepared.claimedExecApprovalFollowupHandoffId,
    claimId: prepared.execApprovalFollowupHandoffClaimId,
  });
}
