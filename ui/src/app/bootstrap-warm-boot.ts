import { clearStoredChatSnapshots } from "../pages/chat/session-snapshot-invalidation.runtime.ts";
import { markPrewarmedChatSnapshotReady } from "../pages/chat/session-snapshot-prewarm.ts";
import type { ApplicationGateway } from "./gateway.ts";

export function subscribeWarmBootConnection(
  gateway: ApplicationGateway,
  profileId: string | null | undefined,
): () => void {
  const bootConnectionRevision = gateway.connectionRevision;
  let pendingBootProfileId = profileId;
  return gateway.subscribe((snapshot) => {
    if (snapshot.phase === "connected") {
      markPrewarmedChatSnapshotReady();
    }
    if (gateway.connectionRevision !== bootConnectionRevision) {
      pendingBootProfileId = undefined;
    }
    if (snapshot.phase !== "connected" || pendingBootProfileId === undefined) {
      return;
    }
    const profileMismatch = pendingBootProfileId !== (snapshot.selfUser?.id ?? null);
    pendingBootProfileId = undefined;
    if (profileMismatch) {
      // Invalidate visible history and its cursor before pane subscribers resume startup.
      void clearStoredChatSnapshots();
      void import("../lib/sessions/session-roster-cache.runtime.ts").then(
        ({ clearCachedBootState }) => clearCachedBootState(),
      );
    }
  });
}
