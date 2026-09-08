// Workboard plugin module implements gateway behavior.
import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { OpenClawPluginApi } from "../api.js";
import { redactClaimToken } from "./card-redaction.js";
import {
  assertNoCursorAdvance,
  createWorkboardDispatchHandler,
  listWorkboardCards,
  readId,
  registerWorkboardResultMethods,
  respondError,
} from "./gateway-helpers.js";
import {
  registerWorkboardWorkspaceBoardMethod,
  registerWorkboardWorkspaceBulkMethod,
  registerWorkboardWorkspaceCardMethods,
  registerWorkboardWorkspaceWorkflowMethods,
} from "./gateway-workspace-methods.js";
import { registerWorkboardStoreLifecycle } from "./store-lifecycle.js";
import { WorkboardStore } from "./store.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;

function redactDiagnosticsRows(result: Awaited<ReturnType<WorkboardStore["diagnostics"]>>) {
  return {
    ...result,
    diagnostics: result.diagnostics.map((row) => ({
      ...row,
      card: redactClaimToken(row.card),
    })),
  };
}

async function redactCardResult(card: Promise<WorkboardCard>) {
  return { card: redactClaimToken(await card) };
}

export function registerWorkboardGatewayMethods(params: {
  api: OpenClawPluginApi;
  store?: WorkboardStore;
}) {
  const { api: hostApi } = params;
  const store = params.store ?? WorkboardStore.openSqlite();
  if (!params.store) {
    registerWorkboardStoreLifecycle(hostApi, store);
  }
  const api: OpenClawPluginApi = {
    ...hostApi,
    registerGatewayMethod: (method, handler, options) =>
      hostApi.registerGatewayMethod(
        method,
        async (request) => {
          try {
            return await store.runOperation(() => handler(request));
          } catch (error) {
            respondError(request.respond, error);
          }
        },
        options,
      ),
  };
  const dispatchCards = createWorkboardDispatchHandler({
    api,
    store,
    redactCard: redactClaimToken,
  });

  registerWorkboardResultMethods(api, [
    [
      "workboard.cards.list",
      READ_SCOPE,
      async ({ params: requestParams }) =>
        await listWorkboardCards(store, requestParams.boardId, redactClaimToken),
    ],
  ]);

  registerWorkboardWorkspaceCardMethods({ api, store, redactCard: redactClaimToken });

  api.registerGatewayMethod(
    "workboard.cards.start",
    async (context) => await dispatchCards(context, { supportsMaxStarts: false, directCard: true }),
    { scope: WRITE_SCOPE },
  );

  registerWorkboardResultMethods(api, [
    [
      "workboard.cards.move",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(
          store.move(readId(requestParams), requestParams.status, requestParams.position),
        ),
    ],
    [
      "workboard.cards.delete",
      WRITE_SCOPE,
      ({ params: requestParams }) => store.delete(readId(requestParams)),
    ],
    [
      "workboard.cards.comment",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(store.addComment(readId(requestParams), requestParams)),
    ],
    [
      "workboard.cards.link",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(store.addLink(readId(requestParams), requestParams)),
    ],
    [
      "workboard.cards.linkDependency",
      WRITE_SCOPE,
      ({ params: requestParams }) => {
        const parentId = requestParams.parentId;
        const childId = requestParams.childId;
        if (typeof parentId !== "string" || typeof childId !== "string") {
          throw new Error("parentId and childId are required.");
        }
        return redactCardResult(store.linkCards(parentId, childId));
      },
    ],
    [
      "workboard.cards.proof",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(store.addProof(readId(requestParams), requestParams)),
    ],
    [
      "workboard.cards.artifact",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(store.addArtifact(readId(requestParams), requestParams)),
    ],
    [
      "workboard.cards.claim",
      WRITE_SCOPE,
      async ({ params: requestParams }) => {
        const claimed = await store.claim(readId(requestParams), requestParams);
        return { ...claimed, card: redactClaimToken(claimed.card) };
      },
    ],
    [
      "workboard.cards.heartbeat",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(store.heartbeat(readId(requestParams), requestParams)),
    ],
    [
      "workboard.cards.release",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(store.releaseClaim(readId(requestParams), requestParams)),
    ],
    [
      "workboard.cards.promote",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(store.promote(readId(requestParams), requestParams, null)),
    ],
    [
      "workboard.cards.reassign",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(store.reassign(readId(requestParams), requestParams, null)),
    ],
    [
      "workboard.cards.reclaim",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(store.reclaim(readId(requestParams), requestParams, null)),
    ],
    [
      "workboard.cards.complete",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(store.complete(readId(requestParams), requestParams, null)),
    ],
    [
      "workboard.cards.block",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(store.block(readId(requestParams), requestParams, null)),
    ],
    [
      "workboard.cards.unblock",
      WRITE_SCOPE,
      ({ params: requestParams }) => redactCardResult(store.unblock(readId(requestParams))),
    ],
  ]);

  registerWorkboardWorkspaceBulkMethod({ api, store, redactCard: redactClaimToken });

  registerWorkboardResultMethods(api, [
    [
      "workboard.cards.diagnostics",
      READ_SCOPE,
      async () => redactDiagnosticsRows(await store.diagnostics()),
    ],
    [
      "workboard.cards.diagnostics.refresh",
      WRITE_SCOPE,
      async () => redactDiagnosticsRows(await store.refreshDiagnostics()),
    ],
  ]);

  api.registerGatewayMethod(
    "workboard.cards.dispatch",
    async (context) => await dispatchCards(context, { supportsMaxStarts: false }),
    { scope: WRITE_SCOPE },
  );

  api.registerGatewayMethod(
    "workboard.cards.dispatchWithOptions",
    async (context) => await dispatchCards(context, { supportsMaxStarts: true }),
    { scope: WRITE_SCOPE },
  );

  registerWorkboardResultMethods(api, [
    ["workboard.boards.list", READ_SCOPE, () => store.listBoards()],
  ]);

  registerWorkboardWorkspaceBoardMethod({ api, store, redactCard: redactClaimToken });

  registerWorkboardResultMethods(api, [
    [
      "workboard.boards.archive",
      WRITE_SCOPE,
      async ({ params: requestParams }) => ({
        board: await store.archiveBoard(requestParams.id, requestParams.archived),
      }),
    ],
    [
      "workboard.boards.delete",
      WRITE_SCOPE,
      ({ params: requestParams }) => store.deleteBoard(requestParams.id),
    ],
    [
      "workboard.cards.stats",
      READ_SCOPE,
      ({ params: requestParams }) => store.stats({ boardId: requestParams.boardId }),
    ],
    [
      "workboard.cards.runs",
      READ_SCOPE,
      async ({ params: requestParams }) => {
        const result = await store.runs(readId(requestParams));
        return { ...result, card: redactClaimToken(result.card) };
      },
    ],
  ]);

  registerWorkboardWorkspaceWorkflowMethods({ api, store, redactCard: redactClaimToken });

  registerWorkboardResultMethods(api, [
    [
      "workboard.notifications.subscribe",
      WRITE_SCOPE,
      async ({ params: requestParams }) => ({
        subscription: await store.subscribeNotifications(requestParams),
      }),
    ],
    [
      "workboard.notifications.list",
      READ_SCOPE,
      ({ params: requestParams }) => store.listNotificationSubscriptions(requestParams),
    ],
    [
      "workboard.notifications.delete",
      WRITE_SCOPE,
      ({ params: requestParams }) => store.deleteNotificationSubscription(readId(requestParams)),
    ],
    [
      "workboard.notifications.events",
      READ_SCOPE,
      ({ params: requestParams }) => {
        assertNoCursorAdvance(requestParams);
        return store.notificationEvents(requestParams);
      },
    ],
    [
      "workboard.notifications.advance",
      WRITE_SCOPE,
      ({ params: requestParams }) => store.advanceNotificationEvents(requestParams),
    ],
    [
      "workboard.cards.attachments.list",
      READ_SCOPE,
      async ({ params: requestParams }) => {
        const result = await store.listAttachments(readId(requestParams));
        return { ...result, card: redactClaimToken(result.card) };
      },
    ],
    [
      "workboard.cards.attachments.get",
      READ_SCOPE,
      async ({ params: requestParams }) => {
        const attachment = await store.getAttachment(readId(requestParams));
        if (!attachment) {
          throw new Error(`attachment not found: ${readId(requestParams)}`);
        }
        return attachment;
      },
    ],
    [
      "workboard.cards.attachments.add",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(store.addAttachment(readId(requestParams), requestParams)),
    ],
    [
      "workboard.cards.attachments.delete",
      WRITE_SCOPE,
      ({ params: requestParams }) => {
        const attachmentId = requestParams.attachmentId;
        if (typeof attachmentId !== "string" || !attachmentId.trim()) {
          throw new Error("attachmentId is required.");
        }
        return redactCardResult(store.deleteAttachment(readId(requestParams), attachmentId.trim()));
      },
    ],
    [
      "workboard.cards.workerLog",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(store.addWorkerLog(readId(requestParams), requestParams)),
    ],
    [
      "workboard.cards.protocolViolation",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(store.recordProtocolViolation(readId(requestParams), requestParams)),
    ],
    [
      "workboard.cards.archive",
      WRITE_SCOPE,
      ({ params: requestParams }) =>
        redactCardResult(store.archive(readId(requestParams), requestParams.archived)),
    ],
    [
      "workboard.cards.export",
      READ_SCOPE,
      async () => {
        const exported = await store.exportCards();
        return { ...exported, cards: exported.cards.map(redactClaimToken) };
      },
    ],
  ]);
}
