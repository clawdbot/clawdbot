import type { ApplicationContext } from "../../app/context.ts";
import * as catalog from "./catalog-target.ts";
import type { DraftSubmissionFlow } from "./draft-submission-flow.ts";

const NEW_SESSION_DRAFT_PANE_ID = "new-session-draft";

export function retainDraft(
  context: ApplicationContext | undefined,
  submission: DraftSubmissionFlow,
  openedFor: string | null,
  messageOwnerKey: string,
) {
  submission.draftPersistence.persistNow();
  const owner = context?.gateway.snapshot.client;
  if (!context || !owner || submission.submitting || submission.pendingCloud.sessionKey) {
    return;
  }
  const routeKey = openedFor ?? catalog.routeKeyFromSearch(window.location.search);
  context.chatAttachmentHandoff.prepare({
    owner,
    paneId: NEW_SESSION_DRAFT_PANE_ID,
    scopeKey: routeKey,
    message: messageOwnerKey === routeKey ? submission.message : "",
    attachments: submission.attachmentDraft.take(),
    fallbacks: {},
  });
}

export function restoreDraft(
  context: ApplicationContext | undefined,
  submission: DraftSubmissionFlow,
  routeKey: string,
  ownedMessage: string,
) {
  submission.draftPersistence.selectRoute(routeKey);
  const owner = context?.gateway.snapshot.client;
  const draft =
    context && owner
      ? context.chatAttachmentHandoff.consume({
          owner,
          paneId: NEW_SESSION_DRAFT_PANE_ID,
          scopeKey: routeKey,
        })
      : null;
  if (ownedMessage || draft) {
    submission.restoreMessage(ownedMessage || draft?.message || "");
  }
  if (draft) {
    submission.attachmentDraft.replace(draft.attachments);
  }
  activateDraft(submission, routeKey);
  return routeKey;
}

export function activateDraft(submission: DraftSubmissionFlow, routeKey: string) {
  if (!submission.pendingCloud.sessionKey) {
    submission.draftPersistence.activateRoute(routeKey);
  }
}

export function restoreDraftOwner(
  submission: DraftSubmissionFlow,
  gatewayUrl: string,
  recoveryScope: string,
) {
  submission.restorePendingCloudRecovery(gatewayUrl, recoveryScope);
  submission.draftPersistence.setOwner(
    gatewayUrl,
    recoveryScope,
    Boolean(submission.pendingCloud.sessionKey),
  );
}
