import { resolveSecureTempRoot } from "../infra/secure-temp-root.js";
import highlightJsRuntime from "./worker-deploy-highlight-runtime.mjs";
import json5Runtime from "./worker-deploy-json5-runtime.mjs";
import { setWorkerDeployRuntime } from "./worker-deploy-runtime-registry.js";

setWorkerDeployRuntime({
  highlightJs: highlightJsRuntime,
  json5: json5Runtime,
  resolveSecureTempRoot,
});
