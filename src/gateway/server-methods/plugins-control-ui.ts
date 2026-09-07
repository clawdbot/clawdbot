import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validatePluginsControlUiListParams,
  validatePluginsControlUiReloadParams,
  validatePluginsControlUiReportParams,
  validatePluginsControlUiStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { capturePluginLifecycleAuthority } from "../../plugins/registry-lifecycle.js";
import { getPluginRegistryForContext } from "../../plugins/runtime.js";
import {
  listControlUiPluginCatalog,
  listControlUiPluginActivations,
  reportControlUiPluginActivation,
  reloadControlUiPluginCatalog,
} from "../control-ui-plugin-assets.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function captureCatalogAuthority(): () => boolean {
  const registry = getPluginRegistryForContext();
  return registry
    ? (capturePluginLifecycleAuthority(registry) ?? (() => false))
    : () => getPluginRegistryForContext() === null;
}

export const pluginsControlUiHandlers: GatewayRequestHandlers = {
  "plugins.controlUi.report": ({ params, client, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsControlUiReportParams,
        "plugins.controlUi.report",
        respond,
      )
    ) {
      return;
    }
    const live =
      client?.connId &&
      context.getClientConnIds?.((candidate) => candidate === client).has(client.connId);
    if (!live || client.connect.client.id !== GATEWAY_CLIENT_IDS.CONTROL_UI) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Activation reports require a connected Control UI"),
      );
      return;
    }
    if (!reportControlUiPluginActivation(client, params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Activation report is for an inactive browser revision",
        ),
      );
      return;
    }
    respond(true, { ok: true });
  },
  "plugins.controlUi.status": ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsControlUiStatusParams,
        "plugins.controlUi.status",
        respond,
      )
    ) {
      return;
    }
    const clients: Array<{
      connId: string;
      activations: ReturnType<typeof listControlUiPluginActivations>;
    }> = [];
    context.getClientConnIds?.((client) => {
      if (client.connId && client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI) {
        clients.push({
          connId: client.connId,
          activations: listControlUiPluginActivations(client, params.pluginId),
        });
      }
      return false;
    });
    if (clients.length > 128) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Too many connected Control UI clients"),
      );
      return;
    }
    respond(true, {
      clients: clients.toSorted((left, right) => left.connId.localeCompare(right.connId)),
    });
  },
  "plugins.controlUi.list": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsControlUiListParams,
        "plugins.controlUi.list",
        respond,
      )
    ) {
      return;
    }
    try {
      const isCurrent = captureCatalogAuthority();
      const catalog = await listControlUiPluginCatalog();
      if (!isCurrent()) {
        throw new Error("plugin registry was replaced");
      }
      respond(true, catalog);
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Control UI plugin catalog is unavailable"),
      );
    }
  },
  "plugins.controlUi.reload": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validatePluginsControlUiReloadParams,
        "plugins.controlUi.reload",
        respond,
      )
    ) {
      return;
    }
    try {
      const isCurrent = captureCatalogAuthority();
      const catalog = await reloadControlUiPluginCatalog(params.pluginId);
      if (!isCurrent()) {
        throw new Error("plugin registry was replaced");
      }
      context.broadcast("plugins.controlUi.changed", { revision: catalog.revision });
      respond(true, catalog);
    } catch {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "Control UI reload failed. Confirm the plugin is active, build its browser assets, and retry.",
        ),
      );
    }
  },
};
