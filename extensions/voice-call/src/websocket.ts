import { createRequire } from "node:module";
import path from "node:path";

// Load the installed receiver so Bun preserves ws frame limits and close behavior.
const require = createRequire(import.meta.url);
export const { WebSocket, WebSocketServer }: typeof import("ws") = require(
  path.join(path.dirname(require.resolve("ws/package.json")), "index.js"),
);

export type WebSocket = import("ws").WebSocket;
export type WebSocketServer = import("ws").WebSocketServer;
