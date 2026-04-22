// Keep bundled registration fast: runtime wiring only needs the store setter,
// while runtime-api.js remains the broad compatibility barrel.
export { setDiscordRuntime } from "./src/runtime.js";
