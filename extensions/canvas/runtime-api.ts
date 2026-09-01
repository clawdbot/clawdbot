/** Runtime API exports for Canvas presenter routes and CLI registration. */
export {
  canvasConfigSchema,
  isCanvasHostEnabled,
  parseCanvasPluginConfig,
  resolveCanvasHostConfig,
  type CanvasHostConfig,
  type CanvasPluginConfig,
} from "./src/config.js";
export { A2UI_PATH, CANVAS_HOST_PATH, handleA2uiHttpRequest } from "./src/host/a2ui.js";
export {
  registerNodesCanvasCommands,
  type CanvasCliDependencies,
  type CanvasNodesRpcOpts,
} from "./src/cli.js";
