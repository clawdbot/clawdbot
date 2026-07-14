import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { loadSettings, type UiSettings } from "../../app/settings.ts";
import {
  createRealtimeTalkConversationState,
  updateRealtimeTalkConversation,
  type RealtimeTalkConversationEntry,
  type RealtimeTalkConversationState,
} from "./realtime-talk-conversation.ts";
import { RealtimeTalkLevelSignal } from "./realtime-talk-level.ts";
import { RealtimeTalkSession, type RealtimeTalkStatus } from "./realtime-talk.ts";

export type ChatRealtimeState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  settings: UiSettings;
  sessionKey: string;
  lastError?: string | null;
  chatError?: string | null;
  realtimeTalkActive: boolean;
  realtimeTalkStatus: RealtimeTalkStatus;
  realtimeTalkDetail: string | null;
  realtimeTalkInputLevel: RealtimeTalkLevelSignal;
  realtimeTalkConversation: RealtimeTalkConversationEntry[];
  realtimeTalkSession: RealtimeTalkSession | null;
  realtimeTalkConversationState: RealtimeTalkConversationState;
  requestUpdate: () => void;
  resetRealtimeTalkConversation: () => void;
  toggleRealtimeTalk: () => Promise<void>;
};

export function createInitialChatRealtimeState() {
  return {
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle" as RealtimeTalkStatus,
    realtimeTalkDetail: null,
    realtimeTalkInputLevel: new RealtimeTalkLevelSignal(),
    realtimeTalkConversation: [],
    realtimeTalkSession: null,
    realtimeTalkConversationState: createRealtimeTalkConversationState(),
  };
}

export function resetChatRealtimeConversation(state: ChatRealtimeState) {
  state.realtimeTalkConversationState = createRealtimeTalkConversationState();
  state.realtimeTalkConversation = [];
}

export function dismissRealtimeTalkError(state: ChatRealtimeState) {
  if (state.realtimeTalkStatus !== "error") {
    return;
  }
  state.realtimeTalkSession?.stop();
  state.realtimeTalkSession = null;
  state.realtimeTalkActive = false;
  state.realtimeTalkStatus = "idle";
  state.realtimeTalkDetail = null;
  state.realtimeTalkInputLevel.set(0);
  state.resetRealtimeTalkConversation();
}

export function attachChatRealtimeActions(state: ChatRealtimeState) {
  state.resetRealtimeTalkConversation = () => {
    resetChatRealtimeConversation(state);
  };
  state.toggleRealtimeTalk = async () => {
    if (state.realtimeTalkSession) {
      state.realtimeTalkSession.stop();
      state.realtimeTalkSession = null;
      state.realtimeTalkActive = false;
      state.realtimeTalkStatus = "idle";
      state.realtimeTalkDetail = null;
      state.realtimeTalkInputLevel.set(0);
      state.resetRealtimeTalkConversation();
      state.requestUpdate();
      return;
    }
    if (!state.client || !state.connected) {
      state.lastError = "Gateway not connected";
      state.chatError = state.lastError;
      state.requestUpdate();
      return;
    }
    // Re-read persisted settings so a microphone picked on the Settings page
    // applies to the next talk session without a reload.
    const inputDeviceId = loadSettings().realtimeTalkInputDeviceId?.trim() || undefined;
    state.realtimeTalkActive = true;
    state.realtimeTalkStatus = "connecting";
    state.realtimeTalkDetail = null;
    state.realtimeTalkInputLevel.set(0);
    state.resetRealtimeTalkConversation();
    const session = new RealtimeTalkSession(
      state.client,
      state.sessionKey,
      {
        onStatus: (status, detail) => {
          if (state.realtimeTalkSession !== session) {
            return;
          }
          state.realtimeTalkStatus = status;
          state.realtimeTalkDetail = detail ?? null;
          state.realtimeTalkActive = status !== "idle";
          if (status === "idle" || status === "error") {
            state.realtimeTalkInputLevel.set(0);
          }
          state.requestUpdate();
        },
        onInputLevel: (level) => {
          if (state.realtimeTalkSession !== session) {
            return;
          }
          state.realtimeTalkInputLevel.set(level);
        },
        onTranscript: (entry) => {
          if (state.realtimeTalkSession !== session) {
            return;
          }
          state.realtimeTalkConversationState = updateRealtimeTalkConversation(
            state.realtimeTalkConversationState,
            entry,
          );
          state.realtimeTalkConversation = state.realtimeTalkConversationState.entries;
          state.requestUpdate();
        },
      },
      {},
      { inputDeviceId },
    );
    state.realtimeTalkSession = session;
    try {
      await session.start();
    } catch (error) {
      if (state.realtimeTalkSession !== session) {
        return;
      }
      session.stop();
      state.realtimeTalkSession = null;
      state.realtimeTalkActive = false;
      state.realtimeTalkStatus = "error";
      state.realtimeTalkDetail = error instanceof Error ? error.message : String(error);
      state.realtimeTalkInputLevel.set(0);
      state.requestUpdate();
    }
  };
}
