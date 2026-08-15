/** Runtime API exports for Canvas plugin host and CLI helpers. */
export {
  canvasConfigSchema,
  isCanvasHostEnabled,
  isCanvasPluginEnabled,
  parseCanvasPluginConfig,
  resolveCanvasHostConfig,
  type CanvasHostConfig,
  type CanvasPluginConfig,
} from "./src/config.js";
export {
  A2UI_PATH,
  CANVAS_HOST_PATH,
  CANVAS_WS_PATH,
  handleA2uiHttpRequest,
} from "./src/host/a2ui.js";
export { createCanvasHostHandler, type CanvasHostHandler } from "./src/host/server.js";
export {
  registerNodesCanvasCommands,
  type CanvasCliDependencies,
  type CanvasNodesRpcOpts,
} from "./src/cli.js";
export { canvasSnapshotTempPath, parseCanvasSnapshotPayload } from "./src/cli-helpers.js";
export { resolveCanvasHostUrl } from "./src/host-url.js";
