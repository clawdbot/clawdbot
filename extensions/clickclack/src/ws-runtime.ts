import { createRequire } from "node:module";
import path from "node:path";
import type WebSocketClient from "ws";

const require = createRequire(import.meta.url);

// Use the declared transport so Bun preserves ws payload and handshake options.
export type WebSocket = WebSocketClient;
export const WebSocket: typeof WebSocketClient = require(
  path.join(path.dirname(require.resolve("ws/package.json")), "index.js"),
);
