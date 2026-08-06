import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

type GatewayLogger = ReturnType<typeof createSubsystemLogger>;

export async function createGatewayChatMetadataLifecycle(params: {
  getConfig: () => OpenClawConfig;
  minimalTestGateway: boolean;
  log: GatewayLogger;
}) {
  let context: GatewayRequestContext | undefined;
  const { createGatewayChatMetadataRuntime } =
    await import("./server-methods/chat-metadata-runtime.js");
  const runtime = createGatewayChatMetadataRuntime({
    getConfig: params.getConfig,
    getContext: () => {
      if (!context) {
        throw new Error("gateway request context is unavailable during chat metadata preparation");
      }
      return context;
    },
    ...(params.minimalTestGateway
      ? {
          beforeRefresh: async () => {
            const { refreshPreparedModelRuntimeSnapshots } =
              await import("../agents/prepared-model-runtime.js");
            await refreshPreparedModelRuntimeSnapshots(params.getConfig(), {
              gatewayLifecycle: true,
              catalogMode: "static",
              allowGatewaySubagentBinding: true,
            });
          },
          refreshOnRead: true,
        }
      : {}),
    log: params.log,
  });
  const refreshLogged = () => {
    void runtime.refresh().catch((error: unknown) => {
      params.log.warn(`chat metadata refresh failed: ${String(error)}`);
    });
  };
  const registerRefreshListeners = async (): Promise<GatewayPostReadySidecarHandle | undefined> => {
    if (params.minimalTestGateway) {
      return undefined;
    }
    const [{ registerPreparedModelRuntimePublicationListener }, { registerSkillsChangeListener }] =
      await Promise.all([
        import("../agents/prepared-model-runtime.js"),
        import("../skills/runtime/refresh.js"),
      ]);
    const unregisterPreparedModelRuntimePublication =
      registerPreparedModelRuntimePublicationListener((event) => {
        if (event.phase === "invalidated") {
          runtime.invalidate();
          return;
        }
        if (event.phase === "failed") {
          runtime.fail(event.error);
          return;
        }
        refreshLogged();
      });
    const unregisterSkillsChange = registerSkillsChangeListener(() => {
      runtime.invalidate();
      refreshLogged();
    });
    return {
      stop: async () => {
        unregisterPreparedModelRuntimePublication();
        unregisterSkillsChange();
      },
    };
  };

  return {
    attachContext: async (
      next: GatewayRequestContext,
      sidecars: GatewayPostReadySidecarHandle[],
    ) => {
      context = next;
      const sidecar = await registerRefreshListeners();
      if (sidecar) {
        sidecars.push(sidecar);
      }
    },
    read: runtime.read,
    readStartup: runtime.readStartup,
    refresh: runtime.refresh,
  };
}
