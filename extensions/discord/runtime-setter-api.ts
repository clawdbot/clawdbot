// Keep bundled registration fast: runtime wiring only needs the store setter,
// while runtime-api.js remains the broad runtime surface.
export { setDiscordRuntime } from "./src/runtime.js";
