import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { MatrixClient } from "../sdk.js";
import { MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY } from "../send/types.js";

export type MatrixDraftStreamHandle = {
  update: (text: string) => void;
  stop: () => Promise<string | undefined>;
  discardPending: () => Promise<void>;
  eventId: () => string | undefined;
  mustDeliverFinalNormally: () => boolean;
  matchesPreparedText: (text: string) => boolean;
  finalizeLive: () => Promise<boolean>;
  reset: () => void;
};

export async function redactMatrixDraftEvent(
  client: MatrixClient,
  roomId: string,
  draftEventId: string,
): Promise<void> {
  await client.redactEvent(roomId, draftEventId).catch(() => {});
}

export function buildMatrixFinalizedPreviewContent(): Record<string, unknown> {
  return { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true };
}

export const loadMatrixSendModule = createLazyRuntimeModule(() => import("../send.js"));

export const loadAcpBindingRuntime = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/acp-binding-runtime"),
);

export const loadSessionBindingRuntime = createLazyRuntimeModule(
  () => import("openclaw/plugin-sdk/session-binding-runtime"),
);

export const loadMatrixReactionEvents = createLazyRuntimeModule(
  () => import("./reaction-events.js"),
);

export const loadMatrixDraftStream = createLazyRuntimeModule(() => import("../draft-stream.js"));

export async function matrixTextWouldActivateMentions(
  client: MatrixClient,
  text: string,
): Promise<boolean> {
  const { resolveMatrixMentionsForBody } = await loadMatrixSendModule();
  const mentions = await resolveMatrixMentionsForBody({ client, body: text });
  return mentions.room === true || (mentions.user_ids?.length ?? 0) > 0;
}
