import { clearStoredChatSnapshots } from "../pages/chat/session-snapshot-invalidation.runtime.ts";
import { markPrewarmedChatSnapshotReady } from "../pages/chat/session-snapshot-prewarm.ts";
import { clearBootRecords } from "./boot-record.ts";
import type { ApplicationGateway } from "./gateway.ts";

export function clearWarmBootState(): void {
  // The boot record gates the next warm boot, so it must be gone before any
  // await: a reload during the lazy IndexedDB cleanup must fail closed.
  clearBootRecords();
  // Invalidate visible history and its cursor before pane subscribers resume startup.
  void clearStoredChatSnapshots();
  void import("../lib/sessions/session-roster-cache.runtime.ts").then(({ clearCachedBootState }) =>
    clearCachedBootState(),
  );
}

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
      clearWarmBootState();
    }
  });
}
