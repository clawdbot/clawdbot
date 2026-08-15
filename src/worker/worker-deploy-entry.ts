import "./worker-deploy-runtime.js";
import workerDeployBrowserRuntime from "./worker-deploy-browser-runtime.js";
import { runWorkerProcess } from "./worker-process.js";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--internal-worker-ipc")) {
  throw new Error("worker deploy entry received unsupported arguments");
}
const internalWorkerIpc = args[0] === "--internal-worker-ipc";

await runWorkerProcess({
  internalWorkerIpc,
  browserRuntime: workerDeployBrowserRuntime,
});
