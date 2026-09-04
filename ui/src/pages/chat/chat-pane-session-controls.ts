import { html } from "lit";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
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
import { renderChatModelAccountControl } from "./components/chat-model-account-control.ts";
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
  expectedSessionId?: string;
  nextMode: ChatPermissionPickerProps["mode"];
  ownsSelection: () => boolean;
  pending: boolean;
  retainUntilRevision?: number;
};

const pendingPermissionChanges = new WeakMap<ChatPageHost, Map<string, PendingPermissionChange>>();
const permissionOutcomeOwners = new WeakMap<ChatPageHost, Map<string, symbol>>();

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
  onModelAccounts?: () => void;
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
    onModelAccounts,
  } = params;
  const sessionKey = state.sessionKey;
  const client = state.client;
  const accountSelection = state.chatAccountSelection;
  const connectionEpoch = state.connectionEpoch;
  const agentScope = scopedAgentParamsForSession(state, sessionKey);
  const expectedSessionId = selectedSession?.sessionId?.trim();
  const permissionScopeKey = JSON.stringify([sessionKey, agentScope.agentId]);
  const permissionChanges =
    pendingPermissionChanges.get(state) ?? new Map<string, PendingPermissionChange>();
  pendingPermissionChanges.set(state, permissionChanges);
  const ownsRoute = () =>
    state.connected &&
    state.sessionKey === sessionKey &&
    state.client === client &&
    state.connectionEpoch === connectionEpoch &&
    scopedAgentParamsForSession(state, sessionKey).agentId === agentScope.agentId;
  const ownsSelection = () => {
    const currentSessionId =
      state.sessionsResult?.sessions.find((row) => areUiSessionKeysEquivalent(row.key, sessionKey))
        ?.sessionId ?? selectedSession?.sessionId;
    return ownsRoute() && currentSessionId === expectedSessionId;
  };
  let pendingChange = permissionChanges.get(permissionScopeKey);
  if (pendingChange && pendingChange.expectedSessionId !== expectedSessionId) {
    permissionChanges.delete(permissionScopeKey);
    pendingChange = undefined;
  }
  if (
    pendingChange?.retainUntilRevision !== undefined &&
    state.sessions.canonicalListRevision > pendingChange.retainUntilRevision
  ) {
    permissionChanges.delete(permissionScopeKey);
    pendingChange = undefined;
  }
  const currentChange = pendingChange?.ownsSelection() ? pendingChange : undefined;
  const permissionPending = Boolean(
    currentChange?.pending || selectedSession?.permissionModePending,
  );
  const modelCatalogState = resolveChatModelCatalogState(state);
  const thinkingLevelOverride = state.sessions.think(sessionKey, agentScope.agentId);
  const thinkingSession = thinkingLevelOverride
    ? { ...selectedSession, thinkingLevel: thinkingLevelOverride }
    : selectedSession;
  return {
    composerControls: html`
      <div class="chat-composer-model-control">
        ${renderChatModelControls({
          renderAccountControl: (accountModel) =>
            renderChatModelAccountControl({
              owner: state,
              client,
              selection: accountSelection,
              model: accountModel,
              disabled:
                !modelAccess.allowed ||
                !state.connected ||
                !accountModel ||
                selectedSession?.modelSelectionLocked === true ||
                state.chatLoading ||
                state.chatSending ||
                Boolean(state.chatRunId) ||
                state.chatStream !== null ||
                Boolean(state.chatModelSwitchPromises[sessionKey]),
              ownsSelection: () =>
                ownsSelection() && state.chatAccountSelection === accountSelection,
              onSelect: (account) =>
                ownsSelection() && modelAccess.allowed
                  ? switchChatModel(state, `${accountModel}@${account.authProfileId}`, sessionKey)
                  : Promise.resolve(false),
              onManage: onModelAccounts,
              onRequestUpdate: () => state.requestUpdate?.(),
            }),
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
      disabled: !permissionAccess.allowed,
      disabledReason: permissionAccess.allowed ? undefined : permissionAccess.reason,
      mode: currentChange ? currentChange.nextMode : selectedSession?.permissionMode,
      pending: permissionPending,
      onSelect: async (permissionMode) => {
        const activeChange = permissionChanges.get(permissionScopeKey);
        if (
          !permissionAccess.allowed ||
          !ownsSelection() ||
          selectedSession?.permissionModePending ||
          (activeChange?.pending && activeChange.ownsSelection())
        ) {
          return;
        }
        // Keep the selected mode visible while the exact runtime update settles.
        // The pending owner rejects duplicates; the shared settings tail serializes later work.
        const change: PendingPermissionChange = {
          expectedSessionId,
          nextMode: permissionMode ?? undefined,
          ownsSelection,
          pending: true,
        };
        const outcomeOwner = Symbol(permissionScopeKey);
        const outcomeOwners = permissionOutcomeOwners.get(state) ?? new Map<string, symbol>();
        permissionOutcomeOwners.set(state, outcomeOwners);
        outcomeOwners.set(permissionScopeKey, outcomeOwner);
        const ownsOutcome = () => outcomeOwners.get(permissionScopeKey) === outcomeOwner;
        permissionChanges.set(permissionScopeKey, change);
        state.requestUpdate?.();
        try {
          state.chatError = state.lastError = null;
          const patched = await patchChatSessionSettings(
            state,
            sessionKey,
            { permissionMode },
            { ...agentScope, expectedSessionId },
          );
          if (!ownsSelection()) {
            return;
          }
          if (!patched) {
            throw new Error("Session capability is unavailable");
          }
          if (patched.listRefreshError && ownsOutcome()) {
            state.chatError = state.lastError = t("chat.permissionControls.refreshFailed", {
              error: patched.listRefreshError,
            });
          }
        } catch (error) {
          if (!ownsRoute() || !ownsOutcome()) {
            return;
          }
          const revision = state.sessions.canonicalListRevision;
          await state.sessions.refreshReplacement(agentScope.agentId);
          if (!ownsRoute() || !ownsOutcome()) {
            return;
          }
          if (ownsSelection() && state.sessions.canonicalListRevision === revision) {
            change.pending = false;
            change.retainUntilRevision = revision;
          }
          state.chatError = state.lastError = t("chat.permissionControls.updateFailed", {
            error: String(error),
          });
        } finally {
          if (ownsOutcome()) {
            outcomeOwners.delete(permissionScopeKey);
          }
          if (
            permissionChanges.get(permissionScopeKey) === change &&
            change.retainUntilRevision === undefined
          ) {
            permissionChanges.delete(permissionScopeKey);
          }
          if (ownsRoute()) {
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
