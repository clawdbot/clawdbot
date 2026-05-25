import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

const { setRuntime: setIMessageRuntime, tryGetRuntime: getOptionalIMessageRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "imessage",
    errorMessage: "iMessage runtime not initialized",
  });
// Only the optional accessor is exported: approval-reactions.ts opens a
// persistent keyed store best-effort and must never throw if the runtime has
// not yet bound. If a future caller genuinely needs a throwing accessor,
// re-export `getRuntime` here intentionally.
export { getOptionalIMessageRuntime, setIMessageRuntime };
