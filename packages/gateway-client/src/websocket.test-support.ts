import { createRequire } from "node:module";
import path from "node:path";

export { WebSocket } from "./websocket.js";

const require = createRequire(import.meta.url);
export const { WebSocketServer }: typeof import("ws") = require(
  path.join(path.dirname(require.resolve("ws/package.json")), "index.js"),
);

export type WebSocketServer = import("ws").WebSocketServer;
