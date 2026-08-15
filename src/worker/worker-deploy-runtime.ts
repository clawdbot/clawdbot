import { resolveSecureTempRoot } from "@openclaw/fs-safe/temp";
import { registerHighlightJsRuntime } from "../agents/utils/syntax-highlight.js";
import { registerSecureTempRootRuntime } from "../infra/tmp-openclaw-dir.js";
import { registerJson5Runtime } from "../utils/parse-json-compat.js";
import highlightJsRuntime from "./worker-deploy-highlight-runtime.mjs";
import json5Runtime from "./worker-deploy-json5-runtime.mjs";

registerHighlightJsRuntime(highlightJsRuntime);
registerJson5Runtime(json5Runtime);
registerSecureTempRootRuntime(resolveSecureTempRoot);
