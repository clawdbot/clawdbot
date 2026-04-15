import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { registerMatrixCliMetadata } from "./cli-metadata.js";

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
    specifier: "./runtime-api.js",
    exportName: "setMatrixRuntime",
  },
  registerCliMetadata: registerMatrixCliMetadata,
  registerFull(api) {
    void import("./plugin-entry.handlers.runtime.js")
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
      const { handleVerifyRecoveryKey } = await import("./plugin-entry.handlers.runtime.js");
      await handleVerifyRecoveryKey(ctx);
    });

    api.registerGatewayMethod("matrix.verify.bootstrap", async (ctx) => {
      const { handleVerificationBootstrap } = await import("./plugin-entry.handlers.runtime.js");
      await handleVerificationBootstrap(ctx);
    });

    api.registerGatewayMethod("matrix.verify.status", async (ctx) => {
      const { handleVerificationStatus } = await import("./plugin-entry.handlers.runtime.js");
      await handleVerificationStatus(ctx);
    });
  },
});
