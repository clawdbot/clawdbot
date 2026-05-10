import { resolveChannelConfigWrites } from "openclaw/plugin-sdk/channel-config-writes";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { createFeishuCommentReplyDispatcher } from "./comment-dispatcher.js";
import {
  createChannelPairingController,
  type ClawdbotConfig,
  type RuntimeEnv,
} from "./comment-handler-runtime-api.js";
import { buildFeishuCommentTarget } from "./comment-target.js";
import { deliverCommentThreadText } from "./drive.js";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";
import {
  resolveDriveCommentEventTurn,
  type FeishuDriveCommentNoticeEvent,
} from "./monitor.comment.js";
import { resolveFeishuDmIngressAccess } from "./policy.js";
import { getFeishuRuntime } from "./runtime.js";
import type { DynamicAgentCreationConfig } from "./types.js";

type HandleFeishuCommentEventParams = {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  event: FeishuDriveCommentNoticeEvent;
  botOpenId?: string;
};

function buildCommentSessionKey(params: {
  core: ReturnType<typeof getFeishuRuntime>;
  route: ResolvedAgentRoute;
  fileType: string;
  fileToken: string;
}): string {
  return params.core.channel.routing.buildAgentSessionKey({
    agentId: params.route.agentId,
    channel: "feishu",
    accountId: params.route.accountId,
    peer: {
      kind: "direct",
      id: `comment-doc:${params.fileType}:${params.fileToken}`,
    },
    dmScope: "per-account-channel-peer",
  });
}

function parseTimestampMs(value: string | undefined): number {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export async function handleFeishuCommentEvent(
  params: HandleFeishuCommentEventParams,
): Promise<void> {
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
  const feishuCfg = account.config;
  const core = getFeishuRuntime();
  const log = params.runtime?.log ?? console.log;
  const error = params.runtime?.error ?? console.error;
  const runtime = (params.runtime ?? { log, error }) as RuntimeEnv;

  const turn = await resolveDriveCommentEventTurn({
    cfg: params.cfg,
    accountId: account.accountId,
    event: params.event,
    botOpenId: params.botOpenId,
    logger: log,
  });
  if (!turn) {
    log(
      `feishu[${account.accountId}]: drive comment notice skipped ` +
        `event=${params.event.event_id ?? "unknown"} comment=${params.event.comment_id ?? "unknown"}`,
    );
    return;
  }

  const commentTarget = buildFeishuCommentTarget({
    fileType: turn.fileType,
    fileToken: turn.fileToken,
    commentId: turn.commentId,
  });
  const dmPolicy = feishuCfg?.dmPolicy ?? "pairing";
  const configAllowFrom = feishuCfg?.allowFrom ?? [];
  const pairing = createChannelPairingController({
    core,
    channel: "feishu",
    accountId: account.accountId,
  });
  const dmIngress = await resolveFeishuDmIngressAccess({
    cfg: params.cfg,
    accountId: account.accountId,
    dmPolicy,
    allowFrom: configAllowFrom,
    readAllowFromStore: pairing.readAllowFromStore,
    senderOpenId: turn.senderId,
    senderUserId: turn.senderUserId,
    conversationId: turn.senderId,
    mayPair: true,
  });
  if (dmIngress.ingress.admission !== "dispatch") {
    if (dmIngress.ingress.admission === "pairing-required") {
      const client = createFeishuClient(account);
      await pairing.issueChallenge({
        senderId: turn.senderId,
        senderIdLine: `Your Feishu user id: ${turn.senderId}`,
        meta: { name: turn.senderId },
        onCreated: ({ code }) => {
          log(
            `feishu[${account.accountId}]: comment pairing request sender=${turn.senderId} code=${code}`,
          );
        },
        sendPairingReply: async (text) => {
          await deliverCommentThreadText(client, {
            file_token: turn.fileToken,
            file_type: turn.fileType,
            comment_id: turn.commentId,
            content: text,
            is_whole_comment: turn.isWholeComment,
          });
        },
        onReplyError: (err) => {
          log(
            `feishu[${account.accountId}]: comment pairing reply failed for ${turn.senderId}: ${String(err)}`,
          );
        },
      });
    } else {
      log(
        `feishu[${account.accountId}]: blocked unauthorized comment sender ${turn.senderId} ` +
          `(dmPolicy=${dmPolicy}, comment=${turn.commentId})`,
      );
    }
    return;
  }

  let effectiveCfg = params.cfg;
  let route = core.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: "feishu",
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: turn.senderId,
    },
  });
  if (route.matchedBy === "default") {
    const dynamicCfg = feishuCfg?.dynamicAgentCreation as DynamicAgentCreationConfig | undefined;
    if (dynamicCfg?.enabled) {
      const dynamicResult = await maybeCreateDynamicAgent({
        cfg: params.cfg,
        runtime: core,
        senderOpenId: turn.senderId,
        dynamicCfg,
        configWritesAllowed: resolveChannelConfigWrites({
          cfg: params.cfg,
          channelId: "feishu",
          accountId: account.accountId,
        }),
        log: (message) => log(message),
      });
      if (dynamicResult.created) {
        effectiveCfg = dynamicResult.updatedCfg;
        route = core.channel.routing.resolveAgentRoute({
          cfg: dynamicResult.updatedCfg,
          channel: "feishu",
          accountId: account.accountId,
          peer: {
            kind: "direct",
            id: turn.senderId,
          },
        });
        log(
          `feishu[${account.accountId}]: dynamic agent created for comment flow, route=${route.sessionKey}`,
        );
      }
    }
  }

  const commentSessionKey = buildCommentSessionKey({
    core,
    route,
    fileType: turn.fileType,
    fileToken: turn.fileToken,
  });
  const bodyForAgent = `[message_id: ${turn.messageId}]\n${turn.prompt}`;
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: bodyForAgent,
    BodyForAgent: bodyForAgent,
    RawBody: turn.targetReplyText ?? turn.rootCommentText ?? turn.prompt,
    CommandBody: turn.targetReplyText ?? turn.rootCommentText ?? turn.prompt,
    From: `feishu:${turn.senderId}`,
    To: commentTarget,
    SessionKey: commentSessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: turn.documentTitle
      ? `Feishu comment · ${turn.documentTitle}`
      : "Feishu comment",
    SenderName: turn.senderId,
    SenderId: turn.senderId,
    Provider: "feishu",
    Surface: "feishu-comment",
    MessageSid: turn.messageId,
    // For Feishu comment turns, MessageThreadId carries the inbound reply_id so
    // comment-aware tools can clean typing reaction before sending visible output.
    MessageThreadId: turn.replyId,
    Timestamp: parseTimestampMs(turn.timestamp),
    WasMentioned: turn.isMentioned,
    CommandAuthorized: false,
    OriginatingChannel: "feishu",
    OriginatingTo: commentTarget,
  });

  const storePath = core.channel.session.resolveStorePath(effectiveCfg.session?.store, {
    agentId: route.agentId,
  });

  const { dispatcher, replyOptions, markDispatchIdle, markRunComplete, cleanupTypingReaction } =
    createFeishuCommentReplyDispatcher({
      cfg: effectiveCfg,
      agentId: route.agentId,
      runtime,
      accountId: account.accountId,
      fileToken: turn.fileToken,
      fileType: turn.fileType,
      commentId: turn.commentId,
      replyId: turn.replyId,
      isWholeComment: turn.isWholeComment,
    });

  let dispatchSettledBeforeStart = false;
  try {
    log(
      `feishu[${account.accountId}]: dispatching drive comment to agent ` +
        `(session=${commentSessionKey} comment=${turn.commentId} type=${turn.noticeType})`,
    );
    const turnResult = await core.channel.turn.run({
      channel: "feishu",
      accountId: route.accountId,
      raw: turn,
      adapter: {
        ingest: () => ({
          id: turn.messageId,
          timestamp: parseTimestampMs(turn.timestamp),
          rawText: ctxPayload.RawBody ?? "",
          textForAgent: ctxPayload.BodyForAgent,
          textForCommands: ctxPayload.CommandBody,
          raw: turn,
        }),
        resolveTurn: () => ({
          channel: "feishu",
          accountId: route.accountId,
          routeSessionKey: commentSessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: core.channel.session.recordInboundSession,
          record: {
            onRecordError: (err) => {
              error(
                `feishu[${account.accountId}]: failed to record comment inbound session ${commentSessionKey}: ${String(err)}`,
              );
            },
          },
          onPreDispatchFailure: async () => {
            dispatchSettledBeforeStart = true;
            await core.channel.reply.settleReplyDispatcher({
              dispatcher,
              onSettled: () => {
                markRunComplete();
                markDispatchIdle();
              },
            });
          },
          runDispatch: () =>
            core.channel.reply.withReplyDispatcher({
              dispatcher,
              run: () =>
                core.channel.reply.dispatchReplyFromConfig({
                  ctx: ctxPayload,
                  cfg: effectiveCfg,
                  dispatcher,
                  replyOptions,
                }),
            }),
        }),
      },
    });
    const dispatchResult = turnResult.dispatched ? turnResult.dispatchResult : undefined;
    const queuedFinal = dispatchResult?.queuedFinal ?? false;
    const counts = dispatchResult?.counts ?? { tool: 0, block: 0, final: 0 };
    log(
      `feishu[${account.accountId}]: drive comment dispatch complete ` +
        `(queuedFinal=${queuedFinal}, replies=${counts.final}, session=${commentSessionKey})`,
    );
  } finally {
    if (!dispatchSettledBeforeStart) {
      markRunComplete();
      markDispatchIdle();
    }
    void cleanupTypingReaction();
  }
}
