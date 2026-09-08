import { createRequire } from "node:module";
import path from "node:path";
import type WebSocketClient from "ws";

const require = createRequire(import.meta.url);

// Bun's built-in ws adapter ignores maxPayload; use the plugin's declared receiver.
export type WebSocket = WebSocketClient;
export const WebSocket: typeof WebSocketClient = require(
  path.join(path.dirname(require.resolve("ws/package.json")), "index.js"),
);
