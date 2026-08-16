import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

export function createGatewaySidecarStopOwner(params: {
  getRegistered: () => GatewayPostReadySidecarHandle[];
  setRegistered: (sidecars: GatewayPostReadySidecarHandle[]) => void;
}): () => Promise<void> {
  let activeStop: Promise<void> | null = null;
  return () => {
    if (activeStop) {
      return activeStop;
    }
    // Install single-flight before any stop can synchronously publish another owner.
    const stopping = Promise.resolve().then(async () => {
      const failedSidecars = new Set<GatewayPostReadySidecarHandle>();
      let failure: unknown;
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
            failure ??= rejected?.reason;
            for (const sidecar of pending) {
              failedSidecars.add(sidecar);
            }
          }
        }
        if (failedSidecars.size > 0) {
          // Preserve ownership after the bounded shutdown retry. A later close can try again.
          params.setRegistered([...failedSidecars, ...params.getRegistered()]);
          throw failure;
        }
      } finally {
        activeStop = null;
      }
    });
    activeStop = stopping;
    return stopping;
  };
}

export function mergeGatewaySidecarOwners(params: {
  registered: readonly GatewayPostReadySidecarHandle[];
  published: readonly GatewayPostReadySidecarHandle[];
}): GatewayPostReadySidecarHandle[] {
  return [...new Set([...params.registered, ...params.published])];
}
