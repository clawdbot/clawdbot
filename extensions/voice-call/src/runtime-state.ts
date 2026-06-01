import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

export type VoiceCallStateRuntime = Pick<PluginRuntime, "state">;

const {
  setRuntime: setVoiceCallStateRuntime,
  clearRuntime: clearVoiceCallStateRuntime,
  tryGetRuntime: getOptionalVoiceCallStateRuntime,
} = createPluginRuntimeStore<VoiceCallStateRuntime>({
  pluginId: "voice-call-state",
  errorMessage: "Voice Call state runtime not initialized",
});

export { clearVoiceCallStateRuntime, getOptionalVoiceCallStateRuntime, setVoiceCallStateRuntime };
