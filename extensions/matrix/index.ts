import {
  defineBundledChannelEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { registerMatrixCliMetadata } from "./cli-metadata.js";

type MatrixHandlersRuntimeModule = typeof import("./plugin-entry.handlers.runtime.js");
type MatrixSubagentHooksModule = typeof import("./src/matrix/subagent-hooks.js");

let matrixHandlersRuntimePromise: Promise<MatrixHandlersRuntimeModule> | null = null;
let matrixSubagentHooksPromise: Promise<MatrixSubagentHooksModule> | null = null;

function loadMatrixHandlersRuntimeModule() {
  matrixHandlersRuntimePromise ??= import("./plugin-entry.handlers.runtime.js");
  return matrixHandlersRuntimePromise;
}

function loadMatrixSubagentHooksModule() {
  matrixSubagentHooksPromise ??= import("./src/matrix/subagent-hooks.js");
  return matrixSubagentHooksPromise;
}

export function registerMatrixFullRuntime(api: OpenClawPluginApi): void {
  void loadMatrixHandlersRuntimeModule()
    .then(({ ensureMatrixCryptoRuntime }) =>
      ensureMatrixCryptoRuntime({ log: api.logger.info }).catch((err: unknown) => {
        const message = formatErrorMessage(err);
        api.logger.warn?.(`matrix: crypto runtime bootstrap failed: ${message}`);
      }),
    )
    .catch((err: unknown) => {
      const message = formatErrorMessage(err);
      api.logger.warn?.(`matrix: failed loading crypto bootstrap runtime: ${message}`);
    });

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

  api.on("subagent_spawning", async (event) => {
    const { handleMatrixSubagentSpawning } = await loadMatrixSubagentHooksModule();
    return await handleMatrixSubagentSpawning(api, event);
  });
  api.on("subagent_ended", async (event) => {
    const { handleMatrixSubagentEnded } = await loadMatrixSubagentHooksModule();
    await handleMatrixSubagentEnded(event);
  });
  api.on("subagent_delivery_target", async (event) => {
    const { handleMatrixSubagentDeliveryTarget } = await loadMatrixSubagentHooksModule();
    return handleMatrixSubagentDeliveryTarget(event);
  });
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
