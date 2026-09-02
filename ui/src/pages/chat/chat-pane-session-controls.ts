import { html } from "lit";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import {
  switchChatContextWindow,
  switchChatFastMode,
  switchChatModel,
  switchChatThinkingLevel,
} from "./chat-session.ts";
import { patchChatSessionSettings } from "./chat-settings-patches.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { refreshChatModelCatalogOnDemand } from "./chat-state-refresh.ts";
import type { ChatProps } from "./chat-view.ts";
import {
  renderChatModelControls,
  type ChatModelCatalogState,
} from "./components/chat-model-controls.ts";
import type { ChatPermissionPickerProps } from "./components/chat-permission-picker.ts";

type SessionActionAccess = ReturnType<typeof readChatSessionActionAccess>;
type SessionAction = keyof SessionActionAccess;
type SessionActionCallbacks = Pick<
  ChatProps,
  "onAbort" | "onClearHistory" | "onForkMessage" | "onRewindMessage"
>;

type PendingPermissionChange = {
  previousMode: ChatPermissionPickerProps["mode"];
  ownsSelection: () => boolean;
};

const pendingPermissionChanges = new WeakMap<ChatPageHost, Map<string, PendingPermissionChange>>();

export function readChatPaneMutationAccess(
  snapshot: ApplicationGatewaySnapshot,
  sessionKey: string,
) {
  return {
    model: readSessionMethodAccess(snapshot, {
      method: "sessions.patch",
      params: { key: sessionKey, model: null },
    }),
    effort: readSessionMethodAccess(snapshot, {
      method: "sessions.patch",
      params: { key: sessionKey, thinkingLevel: null },
    }),
    permission: readSessionMethodAccess(snapshot, {
      method: "sessions.patch",
      params: { key: sessionKey, permissionMode: "guarded" },
    }),
    unarchive: readSessionMethodAccess(snapshot, {
      method: "sessions.patch",
      params: { key: sessionKey, archived: false },
    }),
  };
}

function resolveChatModelCatalogState(
  state: Pick<
    ChatPageHost,
    "chatModelCatalog" | "chatModelCatalogError" | "chatModelsLoading" | "connected"
  >,
): ChatModelCatalogState {
  const hasSnapshot =
    state.chatModelCatalog.length > 0 || (!state.chatModelsLoading && !state.chatModelCatalogError);
  return {
    hasSnapshot,
    status: !state.connected
      ? "offline"
      : state.chatModelCatalogError
        ? "error"
        : state.chatModelsLoading
          ? "loading"
          : "ready",
  };
}

export function renderChatPaneComposerControls(params: {
  state: ChatPageHost;
  selectedSession: GatewaySessionRow | undefined;
  agentDefaultModel: string | undefined;
  agentDefaultPermissionMode?: ChatPermissionPickerProps["defaultMode"];
  modelAccess: SessionMethodAccess;
  effortAccess: SessionMethodAccess;
  permissionAccess: SessionMethodAccess;
  canSelectFull: boolean;
  onModelSetup: () => void;
}): {
  composerControls: NonNullable<ChatProps["composerControls"]>;
  permissionPicker: ChatPermissionPickerProps;
} {
  const {
    state,
    selectedSession,
    agentDefaultModel,
    agentDefaultPermissionMode,
    modelAccess,
    effortAccess,
    permissionAccess,
    canSelectFull,
    onModelSetup,
  } = params;
  const sessionKey = state.sessionKey;
  const client = state.client;
  const connectionEpoch = state.connectionEpoch;
  const agentScope = scopedAgentParamsForSession(state, sessionKey);
  const permissionScopeKey = JSON.stringify([sessionKey, agentScope.agentId]);
  const permissionChanges =
    pendingPermissionChanges.get(state) ?? new Map<string, PendingPermissionChange>();
  pendingPermissionChanges.set(state, permissionChanges);
  const ownsSelection = () =>
    state.connected &&
    state.sessionKey === sessionKey &&
    state.client === client &&
    state.connectionEpoch === connectionEpoch &&
    scopedAgentParamsForSession(state, sessionKey).agentId === agentScope.agentId;
  const pendingChange = permissionChanges.get(permissionScopeKey);
  const currentChange = pendingChange?.ownsSelection() ? pendingChange : undefined;
  const permissionApplying = Boolean(currentChange || selectedSession?.permissionModePending);
  const modelCatalogState = resolveChatModelCatalogState(state);
  const thinkingLevelOverride = state.sessions.think(sessionKey, agentScope.agentId);
  const thinkingSession = thinkingLevelOverride
    ? { ...selectedSession, thinkingLevel: thinkingLevelOverride }
    : selectedSession;
  return {
    composerControls: html`
      <div class="chat-composer-model-control">
        ${renderChatModelControls({
          activeRunId: state.chatRunId,
          agentDefaultModel,
          connected: state.connected,
          gatewayAvailable: Boolean(state.client),
          loading: state.chatLoading,
          modelCatalog: state.chatModelCatalog,
          modelCatalogState,
          modelOverrides: state.sessions.state.modelOverrides,
          thinkingSession,
          modelSelectionLocked: selectedSession?.modelSelectionLocked === true,
          modelSelectionTarget: state.sessionsResult?.defaults.modelSelectionTarget,
          modelSelectionRuntimeId: selectedSession?.agentRuntime?.id,
          modelPickerOpen: state.chatModelPickerOpenSessionKey === state.sessionKey,
          modelSwitching: Boolean(state.chatModelSwitchPromises[state.sessionKey]),
          modelsLoading: state.chatModelsLoading,
          modelMutationDisabledReason: modelAccess.allowed ? undefined : modelAccess.reason,
          effortMutationDisabledReason: effortAccess.allowed ? undefined : effortAccess.reason,
          sending: state.chatSending,
          sessionKey: state.sessionKey,
          selectedSession,
          sessionsResult: state.sessionsResult,
          stream: state.chatStream,
          onRequestUpdate: () => state.requestUpdate?.(),
          onModelSetup,
          onFastModeSelect: (next, targetSessionKey) =>
            effortAccess.allowed
              ? switchChatFastMode(state, next, targetSessionKey)
              : Promise.resolve(false),
          onContextWindowSelect: (next, targetSessionKey) =>
            effortAccess.allowed
              ? switchChatContextWindow(state, next, targetSessionKey)
              : Promise.resolve(false),
          onModelPickerOpen: () => refreshChatModelCatalogOnDemand(state),
          onModelPickerOpenChange: (open) => {
            state.chatModelPickerOpenSessionKey = open ? state.sessionKey : null;
          },
          onModelSelect: (next, targetSessionKey) =>
            modelAccess.allowed
              ? switchChatModel(state, next, targetSessionKey)
              : Promise.resolve(false),
          onThinkingSelect: (next, targetSessionKey) =>
            effortAccess.allowed
              ? switchChatThinkingLevel(state, next, targetSessionKey)
              : Promise.resolve(false),
        })}
      </div>
    `,
    permissionPicker: {
      canSelectFull,
      defaultMode: agentDefaultPermissionMode,
      applying: permissionApplying,
      disabled: !permissionAccess.allowed || permissionApplying,
      disabledReason: permissionAccess.allowed ? undefined : permissionAccess.reason,
      mode: currentChange ? currentChange.previousMode : selectedSession?.permissionMode,
      onSelect: async (permissionMode) => {
        if (
          !permissionAccess.allowed ||
          !ownsSelection() ||
          selectedSession?.permissionModePending ||
          permissionChanges.get(permissionScopeKey)?.ownsSelection()
        ) {
          return;
        }
        // Saved rows can arrive before the runtime ACK. Keep the initiating
        // picker on its previous mode until the exact update settles.
        const change: PendingPermissionChange = {
          previousMode: selectedSession?.permissionMode,
          ownsSelection,
        };
        permissionChanges.set(permissionScopeKey, change);
        state.requestUpdate?.();
        try {
          state.chatError = state.lastError = null;
          const patched = await patchChatSessionSettings(
            state,
            sessionKey,
            { permissionMode },
            agentScope,
          );
          if (!ownsSelection()) {
            return;
          }
          if (!patched) {
            throw new Error("Session capability is unavailable");
          }
        } catch (error) {
          if (!ownsSelection()) {
            return;
          }
          state.chatError = state.lastError = t("chat.permissionControls.updateFailed", {
            error: String(error),
          });
        } finally {
          if (permissionChanges.get(permissionScopeKey) === change) {
            permissionChanges.delete(permissionScopeKey);
          }
          if (ownsSelection()) {
            state.requestUpdate?.();
          }
        }
      },
    },
  };
}

export function createChatPaneSessionActionCallbacks(params: {
  getSnapshot: () => ApplicationGatewaySnapshot;
  hasLocalRun: () => boolean;
  sessionParticipationBlocked: boolean;
  onDenied: (reason: string) => void;
  onAbort: () => void;
  onRewind: (entryId: string) => Promise<boolean>;
  onFork: (entryId: string) => Promise<void>;
  onReset: () => void;
}): SessionActionCallbacks {
  const access = readChatSessionActionAccess(params.getSnapshot(), params.hasLocalRun());
  const requireCurrent = (action: SessionAction): boolean => {
    const current = readChatSessionActionAccess(params.getSnapshot(), params.hasLocalRun())[action];
    if (current.allowed) {
      return true;
    }
    params.onDenied(current.reason);
    return false;
  };
  return {
    onAbort:
      params.sessionParticipationBlocked || !access.abort.allowed
        ? undefined
        : () => {
            if (requireCurrent("abort")) {
              params.onAbort();
            }
          },
    onRewindMessage: access.rewind.allowed
      ? (entryId) => (requireCurrent("rewind") ? params.onRewind(entryId) : false)
      : undefined,
    onForkMessage: access.fork.allowed
      ? (entryId) => (requireCurrent("fork") ? params.onFork(entryId) : undefined)
      : undefined,
    onClearHistory: access.reset.allowed
      ? () => {
          if (requireCurrent("reset")) {
            params.onReset();
          }
        }
      : undefined,
  };
}
