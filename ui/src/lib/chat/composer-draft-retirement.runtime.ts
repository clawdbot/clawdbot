import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { deleteStoredChatSessionSnapshots } from "../../pages/chat/session-snapshot-invalidation.runtime.ts";
import { retireDurableComposerDrafts } from "./composer-draft-store.runtime.ts";
import { retireStoredComposerDrafts, storedChatOutboxScopeKey } from "./outbox-store.ts";

type DeletedComposerDraftTarget = {
  key: string;
  agentId?: string;
  retireBeforeRevision: number;
};

export async function retireDeletedComposerDrafts(params: {
  client: GatewayBrowserClient | null;
  snapshotHost: Parameters<typeof deleteStoredChatSessionSnapshots>[0];
  targets: readonly DeletedComposerDraftTarget[];
  onFailure: () => void;
}): Promise<void> {
  void deleteStoredChatSessionSnapshots(params.snapshotHost, params.targets);
  const client = params.client;
  if (!client) {
    params.onFailure();
    return;
  }
  const stored = retireStoredComposerDrafts(
    { settings: { gatewayUrl: client.gatewayUrl } },
    params.targets,
  );
  let failed = stored.storageFailed;
  if (!client.recoveryScopeReady || !client.recoveryScope) {
    failed = true;
  } else {
    const durable = await retireDurableComposerDrafts(
      { gatewayOwner: stored.gatewayOwner, recoveryScope: client.recoveryScope },
      stored.retirements.map((retirement) => ({
        scopeKey: storedChatOutboxScopeKey(retirement.scope),
        minimumRevision: retirement.minimumRevision,
        retireBeforeRevision: retirement.retireBeforeRevision,
      })),
    );
    failed ||= durable === "storage-failed";
  }
  if (failed) {
    params.onFailure();
  }
}
