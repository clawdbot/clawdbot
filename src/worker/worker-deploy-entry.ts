import { flushCompileCache } from "node:module";
import "./worker-deploy-runtime.js";
import workerDeployBrowserRuntime from "./worker-deploy-browser-runtime.js";
import { runWorkerProcess } from "./worker-process.js";

const args = process.argv.slice(2);
const internalWorkerIpc = args.includes("--internal-worker-ipc");
const internalWorkerPrewarm = args.includes("--internal-worker-prewarm");
const managed = args.includes("--internal-worker-session");
if (
  new Set(args).size !== args.length ||
  args.some(
    (arg) =>
      !["--internal-worker-ipc", "--internal-worker-prewarm", "--internal-worker-session"].includes(
        arg,
      ),
  ) ||
  (internalWorkerPrewarm && args.length !== 1)
) {
  throw new Error("worker deploy entry received unsupported arguments");
}

if (internalWorkerPrewarm) {
  flushCompileCache();
} else {
  await runWorkerProcess({
    internalWorkerIpc,
    managed,
    browserRuntime: workerDeployBrowserRuntime,
  });
}
