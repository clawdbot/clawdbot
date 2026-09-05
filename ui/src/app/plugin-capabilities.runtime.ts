import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PluginsUiDescriptorsResult } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

const requests = new WeakMap<GatewayBrowserClient, object>();

/** Load a complete published surface while preserving the current connection and session. */
export async function refreshPluginCapabilities(
  payload: unknown,
  client: GatewayBrowserClient,
  readCurrent: () => ApplicationGatewaySnapshot | null,
  publish: (snapshot: ApplicationGatewaySnapshot) => void,
  updateCanvas: (url: string | undefined) => void,
): Promise<void> {
  const generation = isRecord(payload) ? payload.generation : undefined;
  const current = readCurrent();
  if (
    !current ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    generation <= (current.pluginCapabilities?.generation ?? -1)
  ) {
    return;
  }
  const request = {};
  requests.set(client, request);
  let capabilities: Required<PluginsUiDescriptorsResult>;
  try {
    capabilities = await client.request("plugins.uiDescriptors", {});
  } catch (error) {
    if (requests.get(client) === request) {
      throw error;
    }
    return;
  }
  const snapshot = requests.get(client) === request ? readCurrent() : null;
  if (!snapshot?.hello) {
    return;
  }
  if (capabilities.generation < generation) {
    throw new Error("Plugin capabilities did not reach the applied generation.");
  }
  const canvasPluginSurfaceUrl = capabilities.pluginSurfaceUrls.canvas?.trim() || null;
  if (canvasPluginSurfaceUrl !== snapshot.canvasPluginSurfaceUrl) {
    updateCanvas(canvasPluginSurfaceUrl ?? undefined);
  }
  publish({
    ...snapshot,
    pluginCapabilities: capabilities,
    canvasPluginSurfaceUrl,
    hello: {
      ...snapshot.hello,
      features: { ...snapshot.hello.features, methods: capabilities.methods },
      controlUiTabs: capabilities.controlUiTabs,
      controlUiWidgetKinds: capabilities.controlUiWidgetKinds,
      pluginSurfaceUrls: capabilities.pluginSurfaceUrls,
    },
  });
}
