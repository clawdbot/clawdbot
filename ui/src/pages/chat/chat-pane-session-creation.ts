import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { resolveSessionCreateParams } from "../../lib/sessions/create.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  resolveAgentIdFromSessionKey,
} from "../../lib/sessions/session-key.ts";
import { cloneChatAttachmentsForIndependentOwner } from "./attachment-payload-store.ts";
import { clearChatHistory } from "./chat-history.ts";
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
  protected abstract confirmConversationReset(): Promise<boolean>;

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
    });
    return true;
  };
}
