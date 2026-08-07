import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import {
  readSessionMethodAccess,
  type SessionMethodAccess,
} from "../../lib/session-method-access.ts";
import { readChatSessionActionAccess } from "./chat-session-action-access.ts";
import { switchChatFastMode, switchChatModel, switchChatThinkingLevel } from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { ChatProps } from "./chat-view.ts";
import { renderChatControls } from "./components/chat-controls.ts";

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
    runtimePatch: readSessionMethodAccess(snapshot, {
      method: "sessions.patch",
      params: { key: sessionKey, model: null },
    }),
    unarchive: readSessionMethodAccess(snapshot, {
      method: "sessions.patch",
      params: { key: sessionKey, archived: false },
    }),
  };
}

export function renderChatPaneComposerControls(params: {
  paneId: string;
  state: ChatPageHost;
  selectedSession: GatewaySessionRow | undefined;
  agentDefaultModel: string | undefined;
  mutationAccess: SessionMethodAccess;
  preferencesBrowserOnly: boolean;
}) {
  const {
    paneId,
    state,
    selectedSession,
    agentDefaultModel,
    mutationAccess,
    preferencesBrowserOnly,
  } = params;
  const mutationAllowed = () => mutationAccess.allowed;
  return renderChatControls({
    paneId,
    model: {
      activeRunId: state.chatRunId,
      agentDefaultModel,
      connected: state.connected,
      gatewayAvailable: Boolean(state.client),
      loading: state.chatLoading,
      modelCatalog: state.chatModelCatalog,
      modelOverrides: state.sessions.state.modelOverrides,
      modelSelectionLocked: selectedSession?.modelSelectionLocked === true,
      modelSelectionRuntimeId: selectedSession?.agentRuntime?.id,
      modelSwitching: Boolean(state.chatModelSwitchPromises[state.sessionKey]),
      modelsLoading: state.chatModelsLoading,
      mutationDisabledReason: mutationAccess.allowed ? undefined : mutationAccess.reason,
      sending: state.chatSending,
      sessionKey: state.sessionKey,
      sessionsResult: state.sessionsResult,
      stream: state.chatStream,
      onRequestUpdate: () => state.requestUpdate?.(),
      onFastModeSelect: (next, targetSessionKey) =>
        mutationAllowed()
          ? switchChatFastMode(state, next, targetSessionKey)
          : Promise.resolve(false),
      onModelSelect: (next, targetSessionKey) =>
        mutationAllowed() ? switchChatModel(state, next, targetSessionKey) : Promise.resolve(false),
      onThinkingSelect: (next, targetSessionKey) =>
        mutationAllowed()
          ? switchChatThinkingLevel(state, next, targetSessionKey)
          : Promise.resolve(false),
    },
    onboarding: state.onboarding,
    preferencesBrowserOnly,
    settings: state.settings,
    viewMenuOpen: state.chatViewMenuOpen,
    onSettingsChange: state.applySettings,
    onViewMenuOpenChange: (open, options) => {
      state.setChatViewMenuOpen(open, options);
    },
  });
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
