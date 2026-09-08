import { createRequire } from "node:module";
import path from "node:path";

// Use the installed Node transport so Bun preserves ws options and lifecycle behavior.
const require = createRequire(import.meta.url);
export const { WebSocket }: typeof import("ws") = require(
  path.join(path.dirname(require.resolve("ws/package.json")), "index.js"),
);

export type WebSocket = import("ws").WebSocket;
