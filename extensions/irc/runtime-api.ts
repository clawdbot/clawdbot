// Keep the bundled runtime entry narrow so generic runtime activation does not
// import the broad IRC API barrel just to install runtime state.
export { setIrcRuntime } from "./src/runtime.js";
