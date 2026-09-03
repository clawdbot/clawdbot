import { configureFsSafeNative } from "../infra/fs-safe-defaults.js";
import { resolveSecureTempRoot } from "../infra/secure-temp-root.js";
import highlightJsRuntime from "./worker-deploy-highlight-runtime.mjs";
import json5Runtime from "./worker-deploy-json5-runtime.mjs";
import { setWorkerDeployRuntime } from "./worker-deploy-runtime-registry.js";

// The sealed worker has no dependency tree. Keep filesystem operations on its
// hash-bound JavaScript rather than loading optional native code from the host.
configureFsSafeNative({ mode: "off" });

setWorkerDeployRuntime({
  highlightJs: highlightJsRuntime,
  json5: json5Runtime,
  resolveSecureTempRoot,
});
