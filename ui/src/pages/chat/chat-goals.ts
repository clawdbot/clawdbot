import type {
  SessionsGoalClearParams,
  SessionsGoalMutationResult,
  SessionsGoalUpdateParams,
} from "../../../../packages/gateway-protocol/src/schema/sessions-goal.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import type { ChatGoalAction, ChatGoalDraft } from "../../lib/chat/chat-types.ts";
import { storageTargetForGateway } from "../../lib/chat/outbox-store.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { scopedAgentIdForSession, visibleSessionMatches } from "../../lib/sessions/index.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type { ChatHost } from "./chat-send-contract.ts";
import { setChatError } from "./chat-send-queue-state.ts";
import type { ChatSendSubmitOptions } from "./chat-send-submit.ts";
import { refreshChatSessionListForTarget } from "./chat-session.ts";
import { adoptStartedChatRun } from "./run-lifecycle.ts";

type ChatGoalHost = ChatHost & {
  handleSendChat: (
    messageOverride?: string,
    options?: ChatSendSubmitOptions,
    submissionAction?: Event,
  ) => Promise<boolean | void>;
};

type GoalOperation = {
  signature: string;
  params: SessionsGoalUpdateParams | SessionsGoalClearParams;
  pending: boolean;
};

const goalOperations = new WeakMap<ChatHost, GoalOperation>();

export async function submitChatGoalDraft(
  host: ChatGoalHost,
  draft: ChatGoalDraft,
  submissionAction?: Event,
): Promise<boolean> {
  if (!draft.objective.trim()) {
    return false;
  }
  if (draft.sessionId && draft.sessionId !== host.currentSessionId) {
    setChatError(host, t("chat.goals.sessionChanged"));
    return false;
  }
  if (draft.action === "edit") {
    return mutateChatGoal(host, {
      action: "edit",
      goalId: draft.goalId,
      objective: draft.objective,
    });
  }
  // The composer commits its literal objective before calling the normal admission owner.
  if (host.chatMessage !== draft.objective) {
    return false;
  }
  return Boolean(
    await host.handleSendChat(
      undefined,
      {
        intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() },
      },
      submissionAction,
    ),
  );
}

export async function mutateChatGoal(
  host: ChatHost,
  action: { goalId: string } & ({ action: ChatGoalAction } | { action: "edit"; objective: string }),
): Promise<boolean> {
  const client = host.client;
  if (!client || !host.connected) {
    setChatError(host, t("chat.goals.offline"));
    return false;
  }
  const sessionKey = host.sessionKey;
  const agentId = scopedAgentIdForSession(host, sessionKey);
  const sessionId = host.currentSessionId ?? undefined;
  const epoch = host.connectionEpoch;
  const targetIsCurrent = () =>
    host.client === client &&
    host.connected &&
    host.connectionEpoch === epoch &&
    (host.currentSessionId ?? undefined) === sessionId &&
    visibleSessionMatches(host, sessionKey, agentId);
  const signature = JSON.stringify([
    storageTargetForGateway(host.settings?.gatewayUrl).gatewayOwner,
    client.recoveryScope,
    sessionKey,
    agentId,
    sessionId,
    action,
  ]);
  let operation = goalOperations.get(host);
  if (operation?.pending) {
    setChatError(host, t("chat.goals.actionPending"));
    return false;
  }
  if (!operation || operation.signature !== signature) {
    const identity = {
      sessionKey,
      ...(agentId ? { agentId } : {}),
      ...(sessionId ? { sessionId } : {}),
      goalId: action.goalId,
      operationId: generateUUID(),
      issuedAtMs: Date.now(),
    };
    operation = {
      signature,
      params:
        action.action === "clear"
          ? identity
          : action.action === "edit"
            ? { ...identity, action: "edit", objective: action.objective }
            : { ...identity, action: action.action },
      pending: false,
    };
    goalOperations.set(host, operation);
  }
  operation.pending = true;
  setChatError(host, null);
  host.requestUpdate?.();
  try {
    const result = await client.request<SessionsGoalMutationResult>(
      action.action === "clear" ? "sessions.goal.clear" : "sessions.goal.update",
      operation.params,
    );
    if (goalOperations.get(host) === operation) {
      goalOperations.delete(host);
    }
    if (targetIsCurrent()) {
      if (result.replayed) {
        // Receipt snapshots describe the original decision, not the current goal or run.
        void refreshChatSessionListForTarget(host, { sessionKey, agentId }).catch(
          (error: unknown) => {
            if (targetIsCurrent()) {
              setChatError(host, formatUiError(error));
              host.requestUpdate?.();
            }
          },
        );
        return true;
      }
      const row = host.sessions.state.result?.sessions.find((entry) =>
        areUiSessionKeysEquivalent(entry.key, sessionKey),
      );
      // A newer event or a replacement goal wins over a delayed mutation response.
      if (
        row?.goal?.id === action.goalId &&
        (!result.goal || result.goal.updatedAt >= row.goal.updatedAt)
      ) {
        host.sessions.patchRowLocal(row.key, { goal: result.goal });
      }
      if (result.status === "started" && result.runId) {
        adoptStartedChatRun(host, result.runId, Date.now());
      }
    }
    return true;
  } catch (error) {
    // Retain the same operation identity if its ACK was lost; Retry must not resume twice.
    if (
      error instanceof GatewayRequestError &&
      !error.retryable &&
      goalOperations.get(host) === operation
    ) {
      goalOperations.delete(host);
    }
    if (targetIsCurrent()) {
      setChatError(host, formatUiError(error));
    }
    return false;
  } finally {
    operation.pending = false;
    host.requestUpdate?.();
  }
}
