import { html } from "lit";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { t } from "../../i18n/index.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import { showToast } from "../../lib/toast.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import {
  switchChatContextWindow,
  switchChatFastMode,
  switchChatModel,
  switchChatThinkingLevel,
} from "./chat-session.ts";
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
  "onAbort" | "onClearHistory" | "onCompact" | "onForkMessage" | "onRewindMessage"
>;

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

export function resolveChatModelCatalogState(
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
          ? hasSnapshot
            ? "refreshing"
            : "loading"
          : "ready",
  };
}

export function renderChatPaneComposerControls(params: {
  state: ChatPageHost;
  selectedSession: GatewaySessionRow | undefined;
  agentDefaultModel: string | undefined;
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
    modelAccess,
    effortAccess,
    permissionAccess,
    canSelectFull,
    onModelSetup,
  } = params;
  const modelCatalogState = resolveChatModelCatalogState(state);
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
          modelSelectionLocked: selectedSession?.modelSelectionLocked === true,
          modelSelectionRuntimeId: selectedSession?.agentRuntime?.id,
          modelSwitching: Boolean(state.chatModelSwitchPromises[state.sessionKey]),
          modelsLoading: state.chatModelsLoading,
          modelMutationDisabledReason: modelAccess.allowed ? undefined : modelAccess.reason,
          effortMutationDisabledReason: effortAccess.allowed ? undefined : effortAccess.reason,
          sending: state.chatSending,
          sessionKey: state.sessionKey,
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
      disabled: !permissionAccess.allowed,
      disabledReason: permissionAccess.allowed ? undefined : permissionAccess.reason,
      mode: selectedSession?.permissionMode,
      sessionRoot: selectedSession?.sessionRoot,
      onSelect: async (permissionMode) => {
        if (!permissionAccess.allowed) {
          return;
        }
        const runWasActive =
          Boolean(state.chatRunId) ||
          Boolean(selectedSession && isSessionRunActive(selectedSession));
        try {
          state.chatError = null;
          await state.sessions.patch(
            state.sessionKey,
            { permissionMode },
            scopedAgentParamsForSession(state, state.sessionKey),
          );
          if (runWasActive) {
            showToast({
              durationMs: 5_000,
              message: t("chat.permissionControls.nextRun"),
              variant: "info",
              key: `permission-mode:${state.sessionKey}`,
              scope: { kind: "session", sessionKey: state.sessionKey },
            });
          }
        } catch (error) {
          state.chatError = t("chat.permissionControls.updateFailed", {
            error: String(error),
          });
          state.requestUpdate?.();
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
  onCompact: () => void;
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
    onCompact: access.compact.allowed
      ? () => {
          if (requireCurrent("compact")) {
            params.onCompact();
          }
        }
      : undefined,
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
