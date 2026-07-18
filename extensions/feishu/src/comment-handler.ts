// Feishu plugin module implements comment handler behavior.
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
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

type HandleFeishuCommentEventParams = {
  cfg: ClawdbotConfig;
  accountId: string;
  runtime?: RuntimeEnv;
  event: FeishuDriveCommentNoticeEvent;
  botOpenId?: string;
  abortSignal?: AbortSignal;
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
  return parseStrictNonNegativeInteger(value) ?? Date.now();
}

export async function handleFeishuCommentEvent(
  params: HandleFeishuCommentEventParams,
): Promise<void> {
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
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
    abortSignal: params.abortSignal,
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
  const pairing = createChannelPairingController({
    core,
    channel: "feishu",
    accountId: account.accountId,
  });
  const resolveCommentAuthorization = async (candidateCfg: ClawdbotConfig, mayPair: boolean) => {
    const candidateAccount = resolveFeishuRuntimeAccount({
      cfg: candidateCfg,
      accountId: account.accountId,
    });
    const candidateDmPolicy = candidateAccount.config.dmPolicy ?? "pairing";
    const ingress = await resolveFeishuDmIngressAccess({
      cfg: candidateCfg,
      accountId: candidateAccount.accountId,
      dmPolicy: candidateDmPolicy,
      allowFrom: candidateAccount.config.allowFrom ?? [],
      readAllowFromStore: pairing.readAllowFromStore,
      senderOpenId: turn.senderId,
      senderUserId: turn.senderUserId,
      conversationId: turn.senderId,
      mayPair,
    });
    return { account: candidateAccount, cfg: candidateCfg, dmPolicy: candidateDmPolicy, ingress };
  };
  const rejectCommentAuthorization = async (
    authorization: Awaited<ReturnType<typeof resolveCommentAuthorization>>,
  ) => {
    if (authorization.ingress.ingress.admission === "pairing-required") {
      const client = createFeishuClient(authorization.account);
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
          `(dmPolicy=${authorization.dmPolicy}, comment=${turn.commentId})`,
      );
    }
  };
  const commentAuthorization = await resolveCommentAuthorization(params.cfg, true);
  if (commentAuthorization.ingress.ingress.admission !== "dispatch") {
    await rejectCommentAuthorization(commentAuthorization);
    return;
  }

  let effectiveCfg = params.cfg;
  const currentCfg = core.config.current() as ClawdbotConfig;
  if (currentCfg !== effectiveCfg) {
    const currentAuthorization = await resolveCommentAuthorization(currentCfg, true);
    if (currentAuthorization.ingress.ingress.admission !== "dispatch") {
      await rejectCommentAuthorization(currentAuthorization);
      return;
    }
    effectiveCfg = currentCfg;
  }
  let route = core.channel.routing.resolveAgentRoute({
    cfg: effectiveCfg,
    channel: "feishu",
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: turn.senderId,
    },
  });
  if (route.matchedBy === "default") {
    const dynamicResult = await maybeCreateDynamicAgent({
      cfg: effectiveCfg,
      runtime: core,
      accountId: account.accountId,
      senderOpenId: turn.senderId,
      canCreateForConfig: async (candidateCfg) => {
        const authorization = await resolveCommentAuthorization(candidateCfg, false);
        return authorization.ingress.ingress.admission === "dispatch";
      },
      log: (message) => log(message),
    });
    if (dynamicResult.created || dynamicResult.updatedCfg !== effectiveCfg) {
      const refreshedAuthorization = await resolveCommentAuthorization(
        dynamicResult.updatedCfg,
        false,
      );
      if (refreshedAuthorization.ingress.ingress.admission !== "dispatch") {
        log(
          `feishu[${account.accountId}]: current policy rejected stale comment sender ${turn.senderId} ` +
            `before adopting refreshed dynamic route (dmPolicy=${refreshedAuthorization.dmPolicy}, comment=${turn.commentId})`,
        );
        return;
      }
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
      if (dynamicResult.created) {
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
  const rawBody = turn.targetReplyText ?? turn.rootCommentText ?? turn.prompt;
  const conversationLabel = turn.documentTitle
    ? `Feishu comment · ${turn.documentTitle}`
    : "Feishu comment";
  const ctxPayload = buildChannelInboundEventContext({
    channel: "feishu",
    accountId: route.accountId,
    surface: "feishu-comment",
    messageId: turn.messageId,
    timestamp: parseTimestampMs(turn.timestamp),
    from: `feishu:${turn.senderId}`,
    sender: { id: turn.senderId, name: turn.senderId },
    conversation: { kind: "direct", id: commentTarget, label: conversationLabel },
    route: {
      agentId: route.agentId,
      dmScope: route.dmScope,
      accountId: route.accountId,
      routeSessionKey: commentSessionKey,
      dispatchSessionKey: commentSessionKey,
    },
    reply: {
      to: commentTarget,
      originatingTo: commentTarget,
      // Comment-aware tools use the inbound reply id as the native thread id.
      messageThreadId: turn.replyId,
    },
    message: { body: bodyForAgent, bodyForAgent, rawBody, commandBody: rawBody },
    access: {
      commands: { authorized: false },
      mentions: { canDetectMention: true, wasMentioned: turn.isMentioned ?? false },
    },
  });

  const { dispatcherOptions, delivery, cleanupTypingReaction } = createFeishuCommentReplyDispatcher(
    {
      cfg: effectiveCfg,
      agentId: route.agentId,
      runtime,
      accountId: account.accountId,
      fileToken: turn.fileToken,
      fileType: turn.fileType,
      commentId: turn.commentId,
      replyId: turn.replyId,
      isWholeComment: turn.isWholeComment,
    },
  );

  try {
    log(
      `feishu[${account.accountId}]: dispatching drive comment to agent ` +
        `(session=${commentSessionKey} comment=${turn.commentId} type=${turn.noticeType})`,
    );
    const turnResult = await core.channel.inbound.run({
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
          cfg: effectiveCfg,
          channel: "feishu",
          accountId: route.accountId,
          route: { agentId: route.agentId, sessionKey: commentSessionKey },
          ctxPayload,
          record: {
            onRecordError: (err) => {
              error(
                `feishu[${account.accountId}]: failed to record comment inbound session ${commentSessionKey}: ${String(err)}`,
              );
            },
          },
          dispatcherOptions,
          delivery,
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
    void cleanupTypingReaction();
  }
}
