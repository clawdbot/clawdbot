import type { RouteId } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { retireSessionPaneHandoffs } from "../../pages/chat/chat-pane-shared.ts";
import { deleteStoredChatSessionSnapshots } from "../../pages/chat/session-snapshot-invalidation.runtime.ts";
import { showToast } from "../toast.ts";
import { retireDurableComposerDrafts } from "./composer-draft-store.runtime.ts";
import { retireStoredComposerDrafts } from "./outbox-store-retirement.ts";
import { storedChatOutboxScopeKey } from "./outbox-store.ts";

type DeletedComposerDraftTarget = {
  key: string;
  agentId?: string;
  retireBeforeRevision: number;
};

export async function retireDeletedComposerDrafts(
  context: ApplicationContext<RouteId>,
  targets: readonly DeletedComposerDraftTarget[],
): Promise<void> {
  let failureReported = false;
  const reportFailure = () => {
    if (!failureReported) {
      failureReported = true;
      showToast({ message: t("sessionsView.draftCleanupFailed") });
    }
  };
  void deleteStoredChatSessionSnapshots(
    {
      assistantAgentId: context.gateway.snapshot.assistantAgentId,
      agentsList: context.agents.state.agentsList,
      hello: context.gateway.snapshot.hello,
    },
    targets,
  ).catch(reportFailure);
  try {
    const client = context.gateway.snapshot.client;
    if (!client) {
      reportFailure();
      return;
    }
    const stored = retireStoredComposerDrafts(
      { settings: { gatewayUrl: client.gatewayUrl } },
      targets,
    );
    retireSessionPaneHandoffs(context, targets);
    for (const retirement of stored.retirements) {
      context.chatAttachmentHandoff.retireScope(
        storedChatOutboxScopeKey(retirement.scope),
        retirement.retireBeforeRevision,
      );
    }
    let failed = stored.storageFailed;
    if (!client.recoveryScopeReady || !client.recoveryScope) {
      failed = true;
    } else {
      const durable = await retireDurableComposerDrafts(
        { gatewayOwner: stored.gatewayOwner, recoveryScope: client.recoveryScope },
        stored.retirements.map((retirement) => ({
          scopeKey: `chat:v3:${storedChatOutboxScopeKey(retirement.scope)}`,
          minimumRevision: retirement.minimumRevision,
          retireBeforeRevision: retirement.retireBeforeRevision,
        })),
      );
      failed ||= durable === "storage-failed";
    }
    if (failed) {
      reportFailure();
    }
  } catch {
    reportFailure();
  }
}
