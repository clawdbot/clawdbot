// Voice Call plugin module implements runtime state behavior.
import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

// Process-local runtime store used by voice-call persistence helpers.

/** Runtime subset needed by voice-call state persistence. */
export type VoiceCallStateRuntime = {
  state: Pick<
    PluginRuntime["state"],
    | "resolveStateDir"
    | "openKeyedStore"
    | "openSyncKeyedStore"
    | "openChannelIngressQueue"
    | "openChannelIngressDrain"
  >;
};

const { setRuntime: setVoiceCallStateRuntime, tryGetRuntime: getOptionalVoiceCallStateRuntime } =
  createPluginRuntimeStore<VoiceCallStateRuntime>({
    pluginId: "voice-call-state",
    errorMessage: "Voice Call state runtime not initialized",
  });

export { getOptionalVoiceCallStateRuntime, setVoiceCallStateRuntime };
