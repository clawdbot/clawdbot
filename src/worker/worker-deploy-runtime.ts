import "../infra/sealed-runtime-bootstrap.js";
import { registerSealedRuntimeProcessEntrypoint } from "../infra/runtime-process-url.js";
import highlightJsRuntime from "./worker-deploy-highlight-runtime.mjs";
import { setWorkerDeployHighlightJs } from "./worker-deploy-runtime-registry.js";

registerSealedRuntimeProcessEntrypoint(
  "githubExec",
  new URL("./github-exec-launcher.mjs", import.meta.url),
);
setWorkerDeployHighlightJs(highlightJsRuntime);
