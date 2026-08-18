import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { retireDurableComposerDrafts } from "./composer-draft-store.runtime.ts";
import { retireStoredComposerDrafts, storedChatOutboxScopeKey } from "./outbox-store.ts";

type DeletedComposerDraftTarget = {
  key: string;
  agentId?: string;
  retireBeforeRevision: number;
};

export async function retireDeletedComposerDrafts(
  client: GatewayBrowserClient,
  targets: readonly DeletedComposerDraftTarget[],
  onFailure: () => void,
): Promise<void> {
  const stored = retireStoredComposerDrafts(
    { settings: { gatewayUrl: client.gatewayUrl } },
    targets,
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
    onFailure();
  }
}
