import { getActivePluginRegistry } from "../../plugins/runtime.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePluginsUiDescriptorsParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const pluginHostHookHandlers: GatewayRequestHandlers = {
  "plugins.uiDescriptors": ({ params, respond }) => {
    if (!validatePluginsUiDescriptorsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid plugins.uiDescriptors params: ${formatValidationErrors(validatePluginsUiDescriptorsParams.errors)}`,
        ),
      );
      return;
    }
    const descriptors = (getActivePluginRegistry()?.controlUiDescriptors ?? []).map((entry) =>
      Object.assign({}, entry.descriptor, {
        pluginId: entry.pluginId,
        pluginName: entry.pluginName,
      }),
    );
    respond(true, { ok: true, descriptors }, undefined);
  },
};
