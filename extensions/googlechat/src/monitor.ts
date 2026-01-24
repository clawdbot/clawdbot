import { PubSub } from "@google-cloud/pubsub";
import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatEvent } from "./types.js";
import { getGoogleChatRuntime } from "./runtime.js";
import { monitorGoogleChatWebhook } from "./webhook.js";

export type MonitorOptions = {
  account: ResolvedGoogleChatAccount;
  config: ClawdbotConfig;
  runtime: any;
  abortSignal: AbortSignal;
};

export async function monitorGoogleChatProvider(
  options: MonitorOptions,
): Promise<void> {
  const { account, runtime, config, abortSignal } = options;

  // Check if webhook mode is enabled
  const webhookMode = account.webhookMode || false;

  if (webhookMode) {
    // Use webhook mode
    return monitorGoogleChatWebhookMode(options);
  } else {
    // Use Pub/Sub mode (original implementation)
    return monitorGoogleChatPubSubMode(options);
  }
}

async function monitorGoogleChatWebhookMode(
  options: MonitorOptions,
): Promise<void> {
  const { account, runtime, config, abortSignal } = options;
  const core = getGoogleChatRuntime();

  const handleEvent = async (event: GoogleChatEvent) => {
    runtime.log?.(`[${account.accountId}] Received webhook event: ${event.type}`);

    // Only process MESSAGE events
    if (event.type !== "MESSAGE") {
      return;
    }

    await processGoogleChatMessage({
      event,
      account,
      config,
      runtime,
      core,
    });
  };

  const { stop } = await monitorGoogleChatWebhook({
    accountId: account.accountId,
    config,
    webhookPort: account.webhookPort,
    webhookHost: account.webhookHost,
    webhookPath: account.webhookPath,
    webhookPublicUrl: account.webhookPublicUrl,
    onMessage: handleEvent,
    runtime,
    abortSignal,
  });

  // Keep alive until aborted
  await new Promise<void>((resolve) => {
    abortSignal.addEventListener("abort", () => {
      stop();
      resolve();
    });
  });
}

async function processGoogleChatMessage(params: {
  event: GoogleChatEvent;
  account: ResolvedGoogleChatAccount;
  config: ClawdbotConfig;
  runtime: any;
  core: ReturnType<typeof getGoogleChatRuntime>;
}): Promise<void> {
  const { event, account, config, runtime, core } = params;

  const message = event.message;
  if (!message) return;

  const text = message.text?.trim() || "";
  if (!text) return;

  const spaceName = event.space?.name || "";
  const spaceType = event.space?.type || "DM";
  const isDm = spaceType === "DM";
  const isGroup = spaceType === "ROOM" || spaceType === "SPACE";
  const senderEmail = event.user?.email || "";
  const senderName = event.user?.displayName || senderEmail;
  const messageId = message.name || "";

  // Check DM policy
  const dmPolicy = account.config.dmPolicy ?? "pairing";
  const configAllowFrom = (account.config.allowFrom ?? []).map((v) =>
    String(v).toLowerCase().trim(),
  );

  if (isDm && dmPolicy !== "open") {
    const allowed = configAllowFrom.includes(senderEmail.toLowerCase());

    if (!allowed) {
      if (dmPolicy === "pairing") {
        runtime.log?.(
          `[${account.accountId}] Blocked unauthorized Google Chat DM from ${senderEmail}`,
        );
        // TODO: Send pairing request message
      }
      return;
    }
  }

  // Resolve agent route
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "googlechat",
    accountId: account.accountId,
    peer: {
      kind: isDm ? "dm" : "group",
      id: spaceName,
    },
  });

  // Format envelope
  const fromLabel = isDm ? senderName : `${senderName} (${spaceName})`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Google Chat",
    from: fromLabel,
    timestamp: event.eventTime ? new Date(event.eventTime).getTime() : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: text,
  });

  // Finalize context
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: text,
    CommandBody: text,
    From: isDm ? `googlechat:${senderEmail}` : `googlechat:${spaceName}`,
    To: `googlechat:${spaceName}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isDm ? "direct" : "group",
    ConversationLabel: fromLabel,
    SenderName: senderName,
    SenderId: senderEmail,
    Provider: "googlechat",
    Surface: "googlechat",
    MessageSid: messageId,
    OriginatingChannel: "googlechat",
    OriginatingTo: `googlechat:${spaceName}`,
  });

  // Record session
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`googlechat: failed updating session meta: ${String(err)}`);
    },
  });

  // Dispatch reply
  const { sendGoogleChatText } = await import("./send.js");
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        const replyText = payload.text;
        if (!replyText) return;

        try {
          await sendGoogleChatText(spaceName, replyText, {
            account,
            threadKey: message.thread?.name,
          });
        } catch (err) {
          runtime.error?.(
            `[${account.accountId}] Google Chat reply failed: ${String(err)}`,
          );
        }
      },
      onError: (err, info) => {
        runtime.error?.(
          `[${account.accountId}] Google Chat ${info.kind} reply failed: ${String(err)}`,
        );
      },
    },
  });
}

async function monitorGoogleChatPubSubMode(
  options: MonitorOptions,
): Promise<void> {
  const { account, runtime, config, abortSignal } = options;
  const core = getGoogleChatRuntime();

  if (!account.credentialsPath || !account.subscriptionName) {
    throw new Error("Google Chat account not properly configured");
  }

  const pubsub = new PubSub({
    projectId: account.projectId,
    keyFilename: account.credentialsPath,
  });

  const subscription = pubsub.subscription(account.subscriptionName);

  const messageHandler = async (message: any) => {
    try {
      const event: GoogleChatEvent = JSON.parse(message.data.toString());

      runtime.log?.(`[${account.accountId}] Received event: ${event.type}`);

      // Only process MESSAGE events
      if (event.type === "MESSAGE") {
        await processGoogleChatMessage({
          event,
          account,
          config,
          runtime,
          core,
        });
      }

      message.ack();
    } catch (error) {
      runtime.log?.(`[${account.accountId}] Error processing message: ${String(error)}`);
      message.nack();
    }
  };

  subscription.on("message", messageHandler);

  // Handle abort signal
  abortSignal.addEventListener("abort", () => {
    subscription.removeListener("message", messageHandler);
    subscription.close();
  });

  runtime.log?.(`[${account.accountId}] Google Chat monitor started`);

  // Keep alive until aborted
  await new Promise<void>((resolve) => {
    abortSignal.addEventListener("abort", () => resolve());
  });
}
