// AG-UI plugin runtime surface — lazily loaded by registerFull() in index.ts
// so the control-plane (discovery/config) path never has to execute this code.
export { aguiChannelPlugin } from "./src/channel.js";
export { createAguiHttpHandler, createOperatorAguiHttpHandler } from "./src/http-handler.js";
export { handleBeforeToolCall, handleToolResultPersist } from "./src/hooks.js";
export { registerAguiCli } from "./src/cli.js";
