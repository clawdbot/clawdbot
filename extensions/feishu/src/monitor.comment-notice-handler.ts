// Feishu plugin module implements monitor.comment notice handler behavior.
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { handleFeishuCommentEvent } from "./comment-handler.js";
import {
  buildFeishuFlushIngressLifecycle,
  FeishuIngressPermanentError,
  type FeishuIngressLifecycle,
} from "./feishu-ingress.js";
import { parseFeishuDriveCommentNoticeEventPayload } from "./monitor.comment.js";
import { botOpenIds } from "./monitor.state.js";
import { createSequentialQueue } from "./sequential-queue.js";

function buildCommentNoticeQueueKey(event: {
  notice_meta?: {
    file_type?: string;
    file_token?: string;
  };
}): string {
  const fileType = event.notice_meta?.file_type?.trim() || "unknown";
  const fileToken = event.notice_meta?.file_token?.trim() || "unknown";
  return `comment-doc:${fileType}:${fileToken}`;
}

export function createFeishuDriveCommentNoticeHandler(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  fireAndForget?: boolean;
  getBotOpenId?: (accountId: string) => string | undefined;
  abortSignal?: AbortSignal;
  resolveIngressLifecycle?: (data: unknown) => FeishuIngressLifecycle | undefined;
}): (data: unknown) => Promise<void> {
  const { cfg, accountId, runtime, fireAndForget, abortSignal } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const enqueue = createSequentialQueue();
  const getBotOpenId = params.getBotOpenId ?? ((id) => botOpenIds.get(id));

  const runFeishuHandler = async (task: () => Promise<void>) => {
    const promise = task().catch((err: unknown) => {
      error(`feishu[${accountId}]: error handling drive comment notice: ${String(err)}`);
    });
    if (!fireAndForget) {
      await promise;
    }
  };

  const handleNotice = async (
    data: unknown,
    turnAdoptionLifecycle?: FeishuIngressLifecycle,
  ): Promise<void> => {
    const event = parseFeishuDriveCommentNoticeEventPayload(data);
    if (!event) {
      if (turnAdoptionLifecycle) {
        throw new FeishuIngressPermanentError(
          "invalid-event",
          "Feishu durable comment event payload is malformed.",
        );
      }
      error(`feishu[${accountId}]: ignoring malformed drive comment notice payload`);
      return;
    }
    log(
      `feishu[${accountId}]: received drive comment notice ` +
        `event=${event.event_id ?? "unknown"} ` +
        `type=${event.notice_meta?.notice_type ?? "unknown"} ` +
        `file=${event.notice_meta?.file_type ?? "unknown"}:${event.notice_meta?.file_token ?? "unknown"} ` +
        `comment=${event.comment_id ?? "unknown"} ` +
        `reply=${event.reply_id ?? "none"} ` +
        `from=${event.notice_meta?.from_user_id?.open_id ?? "unknown"} ` +
        `mentioned=${event.is_mentioned === true ? "yes" : "no"}`,
    );
    await enqueue(buildCommentNoticeQueueKey(event), async () => {
      if (turnAdoptionLifecycle?.abortSignal.aborted) {
        await turnAdoptionLifecycle.onAbandoned();
        return;
      }
      await handleFeishuCommentEvent({
        cfg,
        accountId,
        event,
        botOpenId: getBotOpenId(accountId),
        runtime,
        abortSignal,
        turnAdoptionLifecycle,
      });
    });
  };

  return async (data: unknown) => {
    const ingressLifecycle = params.resolveIngressLifecycle?.(data);
    if (!ingressLifecycle) {
      await runFeishuHandler(async () => await handleNotice(data));
      return;
    }
    const { lifecycle, settle } = buildFeishuFlushIngressLifecycle([
      { lifecycle: ingressLifecycle },
    ]);
    await handleNotice(data, lifecycle);
    await settle();
  };
}
