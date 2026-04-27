import {
  defineBundledChannelEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import { registerMatrixCliMetadata } from "./cli-metadata.js";
import { registerMatrixSubagentHooks } from "./subagent-hooks-api.js";

type MatrixHandlersRuntimeModule = typeof import("./plugin-entry.handlers.runtime.js");

let matrixHandlersRuntimePromise: Promise<MatrixHandlersRuntimeModule> | null = null;

function loadMatrixHandlersRuntimeModule() {
  matrixHandlersRuntimePromise ??= import("./plugin-entry.handlers.runtime.js");
  return matrixHandlersRuntimePromise;
}

export function registerMatrixFullRuntime(api: OpenClawPluginApi): void {
  api.registerGatewayMethod("matrix.verify.recoveryKey", async (ctx) => {
    const { handleVerifyRecoveryKey } = await loadMatrixHandlersRuntimeModule();
    await handleVerifyRecoveryKey(ctx);
  });

  api.registerGatewayMethod("matrix.verify.bootstrap", async (ctx) => {
    const { handleVerificationBootstrap } = await loadMatrixHandlersRuntimeModule();
    await handleVerificationBootstrap(ctx);
  });

  api.registerGatewayMethod("matrix.verify.status", async (ctx) => {
    const { handleVerificationStatus } = await loadMatrixHandlersRuntimeModule();
    await handleVerificationStatus(ctx);
  });

  registerMatrixSubagentHooks(api);
}

export default defineBundledChannelEntry({
  id: "matrix",
  name: "Matrix",
  description: "Matrix channel plugin (matrix-js-sdk)",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "matrixPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setMatrixRuntime",
  },
  registerCliMetadata: registerMatrixCliMetadata,
  registerFull: registerMatrixFullRuntime,
});
