import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { saveSettings, type UiSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import type { RealtimeTalkOptions } from "./components/chat-realtime-controls.ts";
import {
  createRealtimeTalkConversationState,
  updateRealtimeTalkConversation,
  type RealtimeTalkConversationEntry,
  type RealtimeTalkConversationState,
} from "./realtime-talk-conversation.ts";
import { discoverRealtimeTalkInputs, type RealtimeTalkInputDevice } from "./realtime-talk-input.ts";
import { RealtimeTalkLevelSignal } from "./realtime-talk-level.ts";
import {
  RealtimeTalkSession,
  type RealtimeTalkLaunchOptions,
  type RealtimeTalkStatus,
} from "./realtime-talk.ts";

const realtimeTalkInputDeviceIds = new Map<string, string>();

function realtimeTalkInputScope(state: Pick<ChatRealtimeState, "settings">): string {
  return state.settings.gatewayUrl.trim();
}

function currentRealtimeTalkInput(state: ChatRealtimeState): string {
  const scope = realtimeTalkInputScope(state);
  if (realtimeTalkInputDeviceIds.has(scope)) {
    return realtimeTalkInputDeviceIds.get(scope) ?? "";
  }
  const inputDeviceId = state.realtimeTalkInputDeviceId.trim();
  realtimeTalkInputDeviceIds.set(scope, inputDeviceId);
  return inputDeviceId;
}

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
  realtimeTalkOptions: RealtimeTalkOptions;
  realtimeTalkInputDevices: RealtimeTalkInputDevice[];
  realtimeTalkInputDeviceId: string;
  realtimeTalkInputLoading: boolean;
  realtimeTalkInputError: string | null;
  realtimeTalkInputRefreshId: number;
  realtimeTalkSession: RealtimeTalkSession | null;
  realtimeTalkConversationState: RealtimeTalkConversationState;
  requestUpdate: () => void;
  updateRealtimeTalkOptions: (next: Partial<RealtimeTalkOptions>) => void;
  refreshRealtimeTalkInputs: (requestPermission?: boolean) => Promise<void>;
  selectRealtimeTalkInput: (deviceId: string) => void;
  resetRealtimeTalkConversation: () => void;
  toggleRealtimeTalk: () => Promise<void>;
};

function createDefaultRealtimeTalkOptions(): RealtimeTalkOptions {
  return {
    model: "",
    voice: "",
    vadThreshold: "",
  };
}

function parseVadThresholdOption(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  const threshold = Number(normalized);
  return Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 ? threshold : undefined;
}

export function createInitialChatRealtimeState(inputDeviceId = "") {
  return {
    realtimeTalkActive: false,
    realtimeTalkStatus: "idle" as RealtimeTalkStatus,
    realtimeTalkDetail: null,
    realtimeTalkInputLevel: new RealtimeTalkLevelSignal(),
    realtimeTalkConversation: [],
    realtimeTalkOptions: createDefaultRealtimeTalkOptions(),
    realtimeTalkInputDevices: [] as RealtimeTalkInputDevice[],
    realtimeTalkInputDeviceId: inputDeviceId,
    realtimeTalkInputLoading: false,
    realtimeTalkInputError: null,
    realtimeTalkInputRefreshId: 0,
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

async function refreshRealtimeTalkInputs(
  state: ChatRealtimeState,
  requestPermission: boolean,
): Promise<void> {
  const refreshId = ++state.realtimeTalkInputRefreshId;
  state.realtimeTalkInputLoading = true;
  state.realtimeTalkInputError = null;
  state.requestUpdate();
  try {
    const result = await discoverRealtimeTalkInputs(requestPermission);
    if (refreshId !== state.realtimeTalkInputRefreshId) {
      return;
    }
    state.realtimeTalkInputDevices = result.devices;
    state.realtimeTalkInputDeviceId = currentRealtimeTalkInput(state);
    const selectedDeviceMissing =
      requestPermission &&
      result.warning === null &&
      state.realtimeTalkInputDeviceId.length > 0 &&
      result.devices.length > 0 &&
      !result.devices.some((device) => device.deviceId === state.realtimeTalkInputDeviceId);
    state.realtimeTalkInputError = selectedDeviceMissing
      ? t("chat.composer.selectedMicrophoneUnavailable")
      : result.warning;
  } catch (error) {
    if (refreshId !== state.realtimeTalkInputRefreshId) {
      return;
    }
    state.realtimeTalkInputDevices = [];
    state.realtimeTalkInputError = error instanceof Error ? error.message : String(error);
  } finally {
    if (refreshId === state.realtimeTalkInputRefreshId) {
      state.realtimeTalkInputLoading = false;
      state.requestUpdate();
    }
  }
}

export function attachChatRealtimeActions(state: ChatRealtimeState) {
  state.resetRealtimeTalkConversation = () => {
    resetChatRealtimeConversation(state);
  };
  state.updateRealtimeTalkOptions = (next) => {
    state.realtimeTalkOptions = { ...state.realtimeTalkOptions, ...next };
    state.requestUpdate();
  };
  state.refreshRealtimeTalkInputs = (requestPermission = false) =>
    refreshRealtimeTalkInputs(state, requestPermission);
  state.selectRealtimeTalkInput = (deviceId) => {
    const normalizedDeviceId = deviceId.trim();
    realtimeTalkInputDeviceIds.set(realtimeTalkInputScope(state), normalizedDeviceId);
    state.realtimeTalkInputDeviceId = normalizedDeviceId;
    state.settings = {
      ...state.settings,
      realtimeTalkInputDeviceId: normalizedDeviceId || undefined,
    };
    saveSettings(state.settings);
    state.realtimeTalkInputError = null;
    state.requestUpdate();
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
    const inputDeviceId = currentRealtimeTalkInput(state) || undefined;
    const options = state.realtimeTalkOptions;
    const launchOptions: RealtimeTalkLaunchOptions = {
      model: options.model.trim() || undefined,
      voice: options.voice.trim() || undefined,
      vadThreshold: parseVadThresholdOption(options.vadThreshold),
    };
    state.realtimeTalkInputDeviceId = inputDeviceId ?? "";
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
      launchOptions,
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
