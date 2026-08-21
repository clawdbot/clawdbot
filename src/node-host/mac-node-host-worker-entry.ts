import { flushCompileCache } from "node:module";
import "../worker/worker-deploy-runtime.js";
import { VERSION } from "../version.js";
import { createMacNodeHostPluginRegistry } from "./mac-node-host-plugin-runtime.js";
import { runNodeHostWorker } from "./worker.js";

declare const MAC_NODE_HOST_WORKER_SOURCE_COMMIT: string;

const sourceCommit = MAC_NODE_HOST_WORKER_SOURCE_COMMIT;
const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--build-metadata") {
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      kind: "openclaw-macos-node-host-worker",
      sourceCommit,
      version: VERSION,
    })}\n`,
  );
} else if (args.length === 0) {
  await runNodeHostWorker({ sourceCommit, createPluginRegistry: createMacNodeHostPluginRegistry });
  flushCompileCache();
} else {
  throw new Error("macOS node-host worker received unsupported arguments");
}
