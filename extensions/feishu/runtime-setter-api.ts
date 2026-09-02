// Narrow entry point for setFeishuRuntime. Keep setup/runtime registration
// from pulling in the broader Feishu runtime-api barrel.
export { setFeishuRuntime } from "./src/runtime.js";
