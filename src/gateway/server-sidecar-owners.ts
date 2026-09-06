import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

export function createGatewaySidecarStopOwner(params: {
  getRegistered: () => GatewayPostReadySidecarHandle[];
  setRegistered: (sidecars: GatewayPostReadySidecarHandle[]) => void;
}) {
  let activeStop: Promise<void> | null = null;
  let failure: Error | undefined;
  let phase: "open" | "closing" | "sealed" = "open";
  const publish = (sidecars: readonly GatewayPostReadySidecarHandle[]) => {
    if (phase === "sealed") {
      throw new Error("cannot publish a Gateway sidecar after shutdown sealed its owner");
    }
    params.setRegistered([...new Set([...params.getRegistered(), ...sidecars])]);
    if (phase === "closing") {
      void stop().catch(() => {});
    }
  };
  const beginClose = () => {
    if (phase === "open") {
      phase = "closing";
    }
  };
  const stop = () => {
    beginClose();
    if (activeStop) {
      return activeStop;
    }
    // Install single-flight before any stop can synchronously publish another owner.
    const stopping = Promise.resolve().then(async () => {
      const failedSidecars = new Set<GatewayPostReadySidecarHandle>();
      failure = undefined;
      try {
        while (params.getRegistered().some((sidecar) => !failedSidecars.has(sidecar))) {
          const sidecars = [
            ...new Set(params.getRegistered().filter((sidecar) => !failedSidecars.has(sidecar))),
          ];
          const ownedSidecars = new Set(sidecars);
          params.setRegistered(
            params.getRegistered().filter((sidecar) => !ownedSidecars.has(sidecar)),
          );
          let pending = sidecars;
          let results: PromiseSettledResult<void>[] = [];
          for (let attempt = 0; attempt < 2; attempt += 1) {
            results = await Promise.allSettled(
              pending.map(async (sidecar) => await sidecar.stop()),
            );
            pending = pending.filter((_sidecar, index) => results[index]?.status === "rejected");
            if (pending.length === 0) {
              break;
            }
          }
          // A late publisher can report a handle already being stopped. Keep its new owners,
          // but remove duplicate ownership of this batch before draining the next batch.
          params.setRegistered(
            params.getRegistered().filter((sidecar) => !ownedSidecars.has(sidecar)),
          );
          if (pending.length > 0) {
            const rejected = results.find((result) => result.status === "rejected");
            failure ??=
              rejected?.reason instanceof Error
                ? rejected.reason
                : new Error(String(rejected?.reason));
            for (const sidecar of pending) {
              failedSidecars.add(sidecar);
            }
          }
        }
        if (failure) {
          // Preserve ownership after the bounded shutdown retry. A later close can try again.
          params.setRegistered([...failedSidecars, ...params.getRegistered()]);
          throw failure;
        }
      } finally {
        activeStop = null;
      }
    });
    activeStop = stopping;
    void stopping.catch(() => {});
    return stopping;
  };

  const sealAndJoin = async () => {
    for (let pending = activeStop; pending; pending = activeStop) {
      try {
        await pending;
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    phase = "sealed";
    // A settled failed stop still owns its handles and original failure until a retry succeeds.
    if (failure || params.getRegistered().length > 0) {
      throw failure ?? new Error("Gateway sidecar cleanup did not complete");
    }
  };

  return { publish, beginClose, stop, sealAndJoin };
}
