// Sms plugin module implements inbound behavior.
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeSmsPhoneNumber } from "./phone.js";
import { sendSmsTextChunks } from "./send.js";
import type { ResolvedSmsAccount, SmsInboundMessage } from "./types.js";

const CHANNEL_ID = "sms";

type SmsLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type SmsChannelRuntime = Pick<
  PluginRuntime["channel"],
  "commands" | "inbound" | "media" | "pairing" | "reply" | "routing" | "session"
>;

async function authorizeSmsSender(params: {
  cfg: OpenClawConfig;
  account: ResolvedSmsAccount;
  channelRuntime: SmsChannelRuntime;
  from: string;
  rawBody: string;
}) {
  const commandRequested = params.channelRuntime.commands.shouldComputeCommandAuthorized(
    params.rawBody,
    params.cfg,
  );
  return await resolveStableChannelMessageIngress({
    channelId: CHANNEL_ID,
    accountId: params.account.accountId,
    cfg: params.cfg,
    identity: {
      key: "phone",
      entryIdPrefix: "sms-entry",
    },
    readStoreAllowFrom: async () =>
      await params.channelRuntime.pairing.readAllowFromStore({
        channel: CHANNEL_ID,
        accountId: params.account.accountId,
      }),
    subject: { stableId: params.from },
    conversation: {
      kind: "direct",
      id: "direct",
    },
    event: { mayPair: true },
    dmPolicy: params.account.dmPolicy,
    allowFrom: params.account.allowFrom,
    command: commandRequested
      ? {
          cfg: params.cfg,
          modeWhenAccessGroupsOff: "configured",
        }
      : undefined,
  });
}

async function issueSmsPairingChallenge(params: {
  account: ResolvedSmsAccount;
  channelRuntime: SmsChannelRuntime;
  from: string;
  log?: SmsLog;
}) {
  const issueChallenge = createChannelPairingChallengeIssuer({
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    upsertPairingRequest: async (input) =>
      await params.channelRuntime.pairing.upsertPairingRequest({
        channel: CHANNEL_ID,
        accountId: params.account.accountId,
        ...input,
      }),
  });
  await issueChallenge({
    senderId: params.from,
    senderIdLine: `Your SMS phone number: ${params.from}`,
    sendPairingReply: async (text) => {
      await sendSmsTextChunks({
        account: params.account,
        to: params.from,
        text,
      });
    },
    onCreated: () => {
      params.log?.info?.(`SMS pairing request created for ${params.from}`);
    },
    onReplyError: (err) => {
      params.log?.warn?.(`SMS pairing reply failed for ${params.from}: ${String(err)}`);
    },
  });
}

export async function dispatchSmsInboundEvent(params: {
  cfg: OpenClawConfig;
  account: ResolvedSmsAccount;
  msg: SmsInboundMessage;
  channelRuntime: SmsChannelRuntime;
  receivedAt: number;
  turnAdoptionLifecycle?: NonNullable<
    Parameters<SmsChannelRuntime["inbound"]["run"]>[0]["turnAdoptionLifecycle"]
  >;
  log?: SmsLog;
}): Promise<void> {
  const from = normalizeSmsPhoneNumber(params.msg.from);
  const auth = await authorizeSmsSender({
    cfg: params.cfg,
    account: params.account,
    channelRuntime: params.channelRuntime,
    from,
    rawBody: params.msg.body,
  });
  if (!auth.senderAccess.allowed) {
    if (auth.senderAccess.decision === "pairing") {
      await issueSmsPairingChallenge({
        account: params.account,
        channelRuntime: params.channelRuntime,
        from,
        log: params.log,
      });
      return;
    }
    params.log?.warn?.(`SMS sender ${from} is not authorized`);
    return;
  }

  const materialized =
    params.msg.media.length > 0 || (params.msg.unavailableMediaCount ?? 0) > 0
      ? await (
          await import("./media.js")
        ).materializeSmsInboundMedia({
          account: params.account,
          msg: params.msg,
          mediaRuntime: params.channelRuntime,
          abortSignal: params.turnAdoptionLifecycle?.abortSignal,
          log: params.log,
        })
      : { body: params.msg.body, media: [], cleanup: async () => undefined };
  let adoptionState: "pending" | "deferred" | "adopted" | "abandoned" = "pending";
  try {
    const turnAdoptionLifecycle =
      materialized.media.length > 0 && params.turnAdoptionLifecycle
        ? {
            ...params.turnAdoptionLifecycle,
            onAdopted: async () => {
              try {
                await params.turnAdoptionLifecycle?.onAdopted();
                adoptionState = "adopted";
              } catch (error) {
                await materialized.cleanup();
                throw error;
              }
            },
            onDeferred: () => {
              const deferred = params.turnAdoptionLifecycle?.onDeferred?.();
              if (deferred !== false) {
                adoptionState = "deferred";
              }
              return deferred;
            },
            onAbandoned: () => {
              adoptionState = "abandoned";
              // Queue abandonment can be fire-and-forget. Start cleanup before
              // releasing the durable claim and contain asynchronous failures.
              void materialized
                .cleanup()
                .then(() => params.turnAdoptionLifecycle?.onAbandoned?.())
                .catch((error: unknown) => {
                  params.log?.warn?.(
                    `Failed to abandon Twilio MMS ingress ${params.msg.messageSid}: ${String(error)}`,
                  );
                });
            },
          }
        : params.turnAdoptionLifecycle;
    const route = params.channelRuntime.routing.resolveAgentRoute({
      cfg: params.cfg,
      channel: CHANNEL_ID,
      accountId: params.account.accountId,
      peer: {
        kind: "direct",
        id: from,
      },
    });
    const sessionKey = route.sessionKey;
    const commandRequested = auth.commandAccess.requested;
    const commandAuthorized = auth.commandAccess.authorized;
    const isTextCommand = params.channelRuntime.commands.isControlCommandMessage(
      params.msg.body,
      params.cfg,
    );

    await params.channelRuntime.inbound.run({
      channel: CHANNEL_ID,
      accountId: params.account.accountId,
      raw: params.msg,
      ...(turnAdoptionLifecycle ? { turnAdoptionLifecycle } : {}),
      adapter: {
        ingest: (msg) => ({
          id: msg.messageSid,
          timestamp: params.receivedAt,
          rawText: msg.body,
          textForAgent: materialized.body,
          textForCommands: msg.body,
          raw: msg,
        }),
        resolveTurn: async (input) => {
          const ctxPayload = params.channelRuntime.inbound.buildContext({
            channel: CHANNEL_ID,
            accountId: params.account.accountId,
            timestamp: input.timestamp,
            from: `sms:${from}`,
            sender: {
              id: from,
              name: from,
            },
            conversation: {
              kind: "direct",
              id: from,
              label: from,
            },
            route: {
              agentId: route.agentId,
              accountId: params.account.accountId,
              routeSessionKey: sessionKey,
              dispatchSessionKey: sessionKey,
            },
            reply: {
              to: `sms:${from}`,
            },
            message: {
              rawBody: input.rawText,
              commandBody: input.textForCommands,
              bodyForAgent: input.textForAgent,
            },
            media: materialized.media,
            access: commandRequested
              ? {
                  commands: {
                    authorized: commandAuthorized,
                  },
                }
              : undefined,
            command: isTextCommand
              ? {
                  kind: "text-slash",
                  body: input.textForCommands,
                  authorized: commandAuthorized,
                }
              : undefined,
            extra: {
              MessageSid: params.msg.messageSid,
              SenderE164: from,
              To: params.msg.to,
            },
          });
          return {
            cfg: params.cfg,
            channel: CHANNEL_ID,
            accountId: params.account.accountId,
            route: { agentId: route.agentId, sessionKey },
            ctxPayload,
            delivery: {
              durable: () => ({
                to: from,
              }),
              deliver: async (payload) => {
                const text = payload.text;
                if (!text) {
                  return { visibleReplySent: false };
                }
                await sendSmsTextChunks({
                  account: params.account,
                  to: from,
                  text,
                });
                return { visibleReplySent: true };
              },
            },
            dispatcherOptions: {
              onReplyStart: () => {
                params.log?.info?.(`SMS reply started for ${from}`);
              },
            },
          };
        },
      },
    });
    if (adoptionState === "pending" || adoptionState === "abandoned") {
      await materialized.cleanup();
    }
  } catch (error) {
    if (adoptionState === "pending" || adoptionState === "abandoned") {
      await materialized.cleanup();
    }
    throw error;
  }
}
