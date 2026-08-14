import type { ControlModel } from "@openclaw/gateway-client/model";
import type { ControlModelCatalog } from "@openclaw/gateway-client/model/catalog";
import {
  createControlModelGatewayBridge,
  type ControlModelGatewayBridge,
} from "./control-model-gateway.ts";

export type ControlModelRuntime = Readonly<{
  loadCatalog(): Promise<ControlModelCatalog>;
  loadModel(): Promise<ControlModel>;
  notifyConnection(): void;
  resetLineage(): void;
  queueEvent: ControlModelGatewayBridge["queueEvent"];
  dispose(): void;
}>;

export function createControlModelRuntime(options: {
  getGatewaySnapshot: () => {
    phase: string;
    lastError: string | null;
    lastErrorCode: string | null;
  };
  getConnectionEpoch: () => number;
  getClient: () => Parameters<ControlModelGatewayBridge["queueEvent"]>[1] | null;
  isCurrentClient: ControlModelGatewayBridge["queueEvent"] extends (
    event: infer _Event,
    client: infer Client,
  ) => void
    ? (client: Client) => boolean
    : never;
}): ControlModelRuntime {
  const bridge = createControlModelGatewayBridge(options);
  let catalog: ControlModelCatalog | null = null;
  let catalogLoad: Promise<ControlModelCatalog> | null = null;
  let model: ControlModel | null = null;
  let modelLoad: Promise<ControlModel> | null = null;
  let disposed = false;
  const disposedError = new Error("Runtime disposed");

  const loadCatalog = (): Promise<ControlModelCatalog> => {
    if (disposed) {
      return Promise.reject(disposedError);
    }
    if (catalog) {
      catalog.start();
      return Promise.resolve(catalog);
    }
    if (!catalogLoad) {
      catalogLoad = import("@openclaw/gateway-client/model/catalog")
        .then(({ createControlModelCatalog }) => {
          if (disposed) {
            throw disposedError;
          }
          catalog = createControlModelCatalog({
            gateway: bridge.binding,
            autoRefreshSessionCatalog: false,
            bounds: { maxSessions: 1000 },
          });
          catalog.start();
          return catalog;
        })
        .catch((error: unknown) => {
          catalogLoad = null;
          throw error;
        });
    }
    return catalogLoad;
  };

  return {
    loadCatalog,
    loadModel: () => {
      if (disposed) {
        return Promise.reject(disposedError);
      }
      if (model) {
        model.start();
        return Promise.resolve(model);
      }
      if (!modelLoad) {
        modelLoad = loadCatalog()
          .then((loadedCatalog) =>
            import("@openclaw/gateway-client/model").then(
              ({ createControlModelConversationModel }) => {
                if (disposed) {
                  throw disposedError;
                }
                model = createControlModelConversationModel({
                  catalog: loadedCatalog,
                  gateway: bridge.binding,
                  autoRefreshSessionCatalog: false,
                  autoLoadConversationHistory: false,
                  bounds: { maxSessions: 1000, maxConversationMessages: 100 },
                });
                model.start();
                return model;
              },
            ),
          )
          .catch((error: unknown) => {
            modelLoad = null;
            throw error;
          });
      }
      return modelLoad;
    },
    notifyConnection: bridge.notifyConnection,
    resetLineage: bridge.resetLineage,
    queueEvent: bridge.queueEvent,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      model?.dispose();
      model = null;
      modelLoad = null;
      catalog?.dispose();
      catalog = null;
      catalogLoad = null;
      bridge.dispose();
    },
  };
}
