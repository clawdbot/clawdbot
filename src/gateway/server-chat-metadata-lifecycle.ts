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
  let preparedModelRuntimeAvailable = false;
  let preparedModelRuntimeEventVersion = 0;
  const { ChatMetadataSnapshotUnavailableError, createGatewayChatMetadataRuntime } =
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
    onChanged: () => context?.broadcast("chat.metadata.changed", {}, { dropIfSlow: true }),
    log: params.log,
  });
  const refreshLogged = () => {
    void runtime.refresh().catch((error: unknown) => {
      params.log.warn(`chat metadata refresh failed: ${String(error)}`);
    });
  };
  const invalidateForSubordinateChange = () => {
    runtime.invalidate();
    // Auth and skill facts are subordinate to the prepared model owner. During replacement the
    // publication event owns the one catch-up refresh after every related fact is committed.
    if (preparedModelRuntimeAvailable) {
      refreshLogged();
    }
  };
  const registerRefreshListeners = async (): Promise<GatewayPostReadySidecarHandle | undefined> => {
    if (params.minimalTestGateway) {
      return undefined;
    }
    const [
      { registerRuntimeAuthProfileStoreMutationListener },
      { registerPreparedModelRuntimePublicationListener },
      { registerSkillsChangeListener },
    ] = await Promise.all([
      import("../agents/auth-profiles/runtime-snapshots.js"),
      import("../agents/prepared-model-runtime.js"),
      import("../skills/runtime/refresh.js"),
    ]);
    const unregisterPreparedModelRuntimePublication =
      registerPreparedModelRuntimePublicationListener((event) => {
        if (event.phase === "catalog-published") {
          invalidateForSubordinateChange();
          return;
        }
        preparedModelRuntimeEventVersion += 1;
        if (event.phase === "invalidated") {
          preparedModelRuntimeAvailable = false;
          runtime.invalidate();
          return;
        }
        if (event.phase === "failed") {
          preparedModelRuntimeAvailable = false;
          runtime.fail(event.error);
          return;
        }
        preparedModelRuntimeAvailable = true;
        refreshLogged();
      });
    const unregisterSkillsChange = registerSkillsChangeListener(() => {
      invalidateForSubordinateChange();
    });
    const unregisterRuntimeAuthProfileStoreMutation =
      registerRuntimeAuthProfileStoreMutationListener(() => {
        invalidateForSubordinateChange();
      });
    return {
      stop: async () => {
        unregisterRuntimeAuthProfileStoreMutation();
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
        // Publications that complete before listener registration would otherwise be missed.
        // During ordinary startup the owner is published after attachment, so an unavailable
        // snapshot here is expected and the publication listener performs the first refresh.
        const eventVersion = preparedModelRuntimeEventVersion;
        await runtime.refresh().then(
          () => {
            // A successful catch-up proves availability when publication completed before the
            // listener was registered. Do not overwrite a newer invalidation or failure event.
            if (preparedModelRuntimeEventVersion === eventVersion) {
              preparedModelRuntimeAvailable = true;
            }
          },
          (error: unknown) => {
            if (!(error instanceof ChatMetadataSnapshotUnavailableError)) {
              // Capture reached a published owner before this later metadata build failed. Keep
              // stable auth/skill changes able to retry unless a newer owner event says otherwise.
              if (preparedModelRuntimeEventVersion === eventVersion) {
                preparedModelRuntimeAvailable = true;
              }
              params.log.warn(`chat metadata catch-up refresh failed: ${String(error)}`);
            }
          },
        );
      }
    },
    read: runtime.read,
    readStartup: runtime.readStartup,
    refresh: runtime.refresh,
  };
}
