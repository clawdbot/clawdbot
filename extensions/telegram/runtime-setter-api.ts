// Keep bundled registration fast: the runtime setter is needed during plugin
// bootstrap, but the broad runtime-api barrel is only for compatibility callers.
export { setTelegramRuntime } from "./src/runtime.js";
