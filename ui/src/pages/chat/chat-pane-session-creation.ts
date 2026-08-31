import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { resolveSessionCreateParams } from "../../lib/sessions/create.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  resolveAgentIdFromSessionKey,
} from "../../lib/sessions/session-key.ts";
import { cloneChatAttachmentsForIndependentOwner } from "./attachment-payload-store.ts";
import { clearChatHistory } from "./chat-history-actions.ts";
import { createChatModelSetupBanner } from "./chat-model-setup.ts";
import { ChatPaneRetainedPresentation } from "./chat-pane-retained-presentation.ts";
import {
  NEW_SESSION_ACTIVE_RUN_MESSAGE,
  NEW_SESSION_CREATE_FAILED_MESSAGE,
  NEW_SESSION_LIST_LOADING_MESSAGE,
  preparePaneSessionHandoff,
} from "./chat-pane-shared.ts";
import { setChatError } from "./chat-send-queue-state.ts";
import { canCreateChatSession } from "./chat-state-route.ts";

/** Creates or resets a conversation while guarding its asynchronous ownership. */
export abstract class ChatPaneSessionCreation extends ChatPaneRetainedPresentation {
  protected recoveringSession = false;

  protected abstract confirmConversationReset(): Promise<boolean>;

  protected sessionDisabledBanner(params: {
    catalogDisabledReason: string | null | undefined;
    modelSetupRequired: boolean;
    restartRecoveryTombstoned: boolean;
    selectedSessionArchived: boolean;
    selectedSessionId: string | undefined;
    sessionKey: string;
    unarchiveAccess: SessionMethodAccess;
  }) {
    if (params.catalogDisabledReason) {
      return undefined;
    }
    if (params.restartRecoveryTombstoned) {
      return this.restartRecoveryComposerBanner();
    }
    if (params.selectedSessionArchived) {
      return {
        kind: "composer-replacement" as const,
        text: t("chat.archivedSessionDisabled"),
        icon: "archive" as const,
        actionLabel: t("common.unarchive"),
        disabledReason: !params.selectedSessionId
          ? "Session lifecycle action requires a durable session identity."
          : params.unarchiveAccess.allowed
            ? undefined
            : params.unarchiveAccess.reason,
        onAction: () => {
          if (params.selectedSessionId && params.unarchiveAccess.allowed) {
            void this.restoreArchivedSession(params.sessionKey, params.selectedSessionId);
          }
        },
      };
    }
    return params.modelSetupRequired
      ? createChatModelSetupBanner(() => this.context.navigate("model-setup"))
      : undefined;
  }

  protected restartRecoveryComposerBanner() {
    const state = this.state;
    if (!state) {
      return undefined;
    }
    const agentId =
      scopedAgentParamsForSession(state, state.sessionKey).agentId ??
      resolveAgentIdFromSessionKey(state.sessionKey);
    const params = {
      ...(agentId ? { agentId } : {}),
      key: state.sessionKey,
    };
    const access = readSessionMethodAccess(this.context.gateway.snapshot, {
      method: "sessions.recover",
      params,
    });
    return {
      kind: "composer-replacement" as const,
      title: t("chat.restartRecoveryTitle"),
      text: t("chat.restartRecoveryDisabled"),
      tone: "neutral" as const,
      icon: "warning" as const,
      actionLabel: t("chat.resumeInNewSession"),
      actionStyle: "primary" as const,
      busy: this.recoveringSession,
      busyLabel: t("chat.resumingSession"),
      disabledReason: access.allowed || this.recoveringSession ? undefined : access.reason,
      onAction: () => {
        if (access.allowed && !this.recoveringSession) {
          void this.recoverSession();
        }
      },
    };
  }

  protected readonly recoverSession = async (): Promise<boolean> => {
    const state = this.state;
    if (!state || !state.client || !state.connected || this.recoveringSession) {
      return false;
    }
    const context = this.context;
    const sessions = context.sessions;
    const client = state.client;
    const connectionGeneration = this.connectionGeneration;
    const isCurrent = () =>
      this.isConnected &&
      this.state === state &&
      this.context === context &&
      this.context.sessions === sessions &&
      state.client === client &&
      state.connected &&
      this.connectedClient === client &&
      context.gateway.snapshot.client === client &&
      context.gateway.snapshot.phase === "connected" &&
      this.connectionGeneration === connectionGeneration;
    const sourceSessionKey = state.sessionKey;
    const agentId =
      scopedAgentParamsForSession(state, sourceSessionKey).agentId ??
      resolveAgentIdFromSessionKey(sourceSessionKey);
    const params = {
      ...(agentId ? { agentId } : {}),
      key: sourceSessionKey,
    };
    const access = readSessionMethodAccess(context.gateway.snapshot, {
      method: "sessions.recover",
      params,
    });
    if (!access.allowed) {
      setChatError(state, access.reason);
      state.requestUpdate?.();
      return false;
    }

    this.recoveringSession = true;
    this.requestUpdate();
    setChatError(state, null);
    try {
      const recovery = await sessions.recover(params);
      if (!isCurrent() || state.sessionKey !== sourceSessionKey) {
        return false;
      }
      if (!recovery) {
        if (isCurrent()) {
          setChatError(state, state.sessionsError ?? NEW_SESSION_CREATE_FAILED_MESSAGE);
          state.requestUpdate?.();
        }
        return false;
      }
      if (recovery.continuation.status === "rejected") {
        setChatError(state, formatUiError(recovery.continuation.error.message));
        state.requestUpdate?.();
        return false;
      }
      const nextSessionKey = recovery.key;
      if (this.onPaneSessionChange?.(this.paneId, nextSessionKey) === false) {
        return false;
      }
      preparePaneSessionHandoff(this.context, this.paneId, nextSessionKey, {
        attachments: [],
        draft: "",
      });
      return true;
    } finally {
      this.recoveringSession = false;
      this.requestUpdate();
    }
  };

  protected readonly createSession = async (): Promise<boolean> => {
    const state = this.state;
    if (!state || !state.client || !state.connected) {
      return false;
    }
    const context = this.context;
    const sessions = context.sessions;
    const client = state.client;
    const previousSessionKey = state.sessionKey;
    const preservesBoard = this.resolveBoardView().hasBoard;
    const createParams = {
      currentSessionKey: previousSessionKey,
      agentId:
        scopedAgentParamsForSession(state, previousSessionKey).agentId ??
        resolveAgentIdFromSessionKey(previousSessionKey),
    };
    const createRequestParams = {
      ...resolveSessionCreateParams(createParams.currentSessionKey, createParams.agentId),
    };
    const readCreateAccess = () =>
      readSessionMethodAccess(context.gateway.snapshot, {
        method: preservesBoard ? "sessions.reset" : "sessions.create",
        ...(preservesBoard
          ? { requiredScope: "operator.admin" as const }
          : { params: createRequestParams }),
      });
    const publishCreateAccessError = (reason: string) => {
      state.lastError = reason;
      state.chatError = reason;
      state.requestUpdate?.();
    };
    const connectionGeneration = this.connectionGeneration;
    const isCurrent = () =>
      this.isConnected &&
      this.state === state &&
      this.context === context &&
      this.context.sessions === sessions &&
      state.client === client &&
      state.connected &&
      this.connectedClient === client &&
      context.gateway.snapshot.client === client &&
      context.gateway.snapshot.phase === "connected" &&
      this.connectionGeneration === connectionGeneration;
    if (!canCreateChatSession(state)) {
      setChatError(state, NEW_SESSION_ACTIVE_RUN_MESSAGE);
      state.requestUpdate?.();
      return false;
    }
    if (state.sessionsLoading) {
      setChatError(state, NEW_SESSION_LIST_LOADING_MESSAGE);
      state.requestUpdate?.();
      return false;
    }
    const initialAccess = readCreateAccess();
    if (!initialAccess.allowed) {
      publishCreateAccessError(initialAccess.reason);
      return false;
    }
    if (
      !(await this.confirmConversationReset()) ||
      !isCurrent() ||
      !areUiSessionKeysEquivalent(state.sessionKey, previousSessionKey)
    ) {
      return false;
    }
    if (!canCreateChatSession(state)) {
      setChatError(state, NEW_SESSION_ACTIVE_RUN_MESSAGE);
      state.requestUpdate?.();
      return false;
    }
    const currentAccess = readCreateAccess();
    if (!currentAccess.allowed) {
      publishCreateAccessError(currentAccess.reason);
      return false;
    }

    setChatError(state, null);
    if (preservesBoard) {
      const resetResult = await clearChatHistory(state);
      return resetResult !== "failed";
    }
    const nextSessionKey = await sessions.create(createParams);
    if (!isCurrent()) {
      return false;
    }
    if (
      !nextSessionKey ||
      state.sessionKey !== previousSessionKey ||
      !canCreateChatSession(state)
    ) {
      if (!nextSessionKey) {
        setChatError(
          state,
          state.sessionsError ??
            (state.sessionsLoading
              ? NEW_SESSION_LIST_LOADING_MESSAGE
              : NEW_SESSION_CREATE_FAILED_MESSAGE),
        );
        state.requestUpdate?.();
      }
      return false;
    }
    if (this.onPaneSessionChange?.(this.paneId, nextSessionKey) === false) {
      return false;
    }
    preparePaneSessionHandoff(this.context, this.paneId, nextSessionKey, {
      attachments: cloneChatAttachmentsForIndependentOwner(state.chatAttachments),
      draft: state.chatMessage,
      ...(state.chatGoalDraftMode ? { goalMode: state.chatGoalDraftMode } : {}),
    });
    return true;
  };
}
