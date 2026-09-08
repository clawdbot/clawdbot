import { createRequire } from "node:module";
import path from "node:path";

// Bun's accepted ws sockets lack pause(); keep the installed receiver's backpressure.
const require = createRequire(import.meta.url);
export const websocket: typeof import("ws") = require(
  path.join(path.dirname(require.resolve("ws/package.json")), "index.js"),
);
