import type { IncomingMessage, ServerResponse } from "node:http";

import { registerPluginHttpRoute } from "clawdbot/plugin-sdk";

import { resolveAgentMailAccount, resolveCredentials } from "./accounts.js";
import { getAgentMailClient } from "./client.js";
import { getAgentMailRuntime } from "./runtime.js";
import { checkSenderAllowed, labelMessageAllowed } from "./filtering.js";
import { extractMessageBody, fetchFormattedThread } from "./thread.js";
import { parseEmailFromAddress, parseNameFromAddress } from "./utils.js";
import type { CoreConfig, MessageReceivedEvent } from "./utils.js";

export type MonitorAgentMailOptions = {
  accountId?: string | null;
  abortSignal?: AbortSignal;
};

// Runtime state tracking
const runtimeState = new Map<
  string,
  {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
  }
>();

function recordState(
  accountId: string,
  state: Partial<typeof runtimeState extends Map<string, infer V> ? V : never>
) {
  const key = `agentmail:${accountId}`;
  runtimeState.set(key, {
    ...(runtimeState.get(key) ?? {
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    }),
    ...state,
  });
}

export function getAgentMailRuntimeState(accountId: string) {
  return runtimeState.get(`agentmail:${accountId}`);
}

// HTTP helpers
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Builds message body from webhook payload as fallback when API fetch fails. */
function buildFallbackBody(
  message: NonNullable<MessageReceivedEvent["message"]>
): string {
  const subject = message.subject ? `Subject: ${message.subject}\n\n` : "";
  return `${subject}${extractMessageBody(message)}`;
}

/**
 * Main monitor function that sets up webhook handling for AgentMail.
 */
export async function monitorAgentMailProvider(
  opts: MonitorAgentMailOptions = {}
): Promise<void> {
  const core = getAgentMailRuntime();
  const cfg = core.config.loadConfig() as CoreConfig;
  const agentmailConfig = cfg.channels?.agentmail;

  if (agentmailConfig?.enabled === false) {
    return;
  }

  const logger = core.logging.getChildLogger({
    module: "agentmail-auto-reply",
  });
  const logVerbose = (msg: string) => {
    if (core.logging.shouldLogVerbose()) {
      if (logger.debug) {
        logger.debug(msg);
      } else {
        logger.info(msg);
      }
    }
  };

  const accountId = opts.accountId ?? "default";
  const account = resolveAgentMailAccount({ cfg, accountId });

  if (!account.configured) {
    logger.warn("AgentMail not configured (missing token or email address)");
    return;
  }

  const { apiKey, inboxId, webhookPath } = resolveCredentials(cfg);

  if (!apiKey || !inboxId) {
    logger.warn("AgentMail token or email address not found");
    return;
  }

  const client = getAgentMailClient(apiKey);
  const allowFrom = agentmailConfig?.allowFrom ?? [];

  recordState(accountId, {
    running: true,
    lastStartAt: Date.now(),
    lastError: null,
  });
  logger.info(`AgentMail: starting monitor for ${inboxId}`);

  /**
   * Handles incoming webhook requests from AgentMail.
   */
  const handleWebhook = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("Method Not Allowed");
        return;
      }

      const body = await readBody(req);
      const payload = JSON.parse(body) as { eventType?: string };

      // Only handle message.received events
      if (payload.eventType !== "message.received") {
        return sendJson(res, 200, { ok: true, ignored: true });
      }

      const event = payload as MessageReceivedEvent;
      const message = event.message;
      if (!message) {
        return sendJson(res, 200, { ok: true, ignored: true });
      }

      // Parse sender email from "from" string (format: "Display Name <email>" or "email")
      const senderEmail = parseEmailFromAddress(message.from);

      logVerbose(`agentmail: received message from ${senderEmail}`);

      // Apply sender filtering
      const allowed = checkSenderAllowed(senderEmail, { allowFrom });

      if (!allowed) {
        logVerbose(`agentmail: sender ${senderEmail} not in allowFrom`);
        return sendJson(res, 200, { ok: true, filtered: true });
      }

      // Label message as allowed
      await labelMessageAllowed(client, inboxId, message.messageId);

      recordState(accountId, { lastInboundAt: Date.now() });

      // Fetch the full thread from API (handles webhook size limits for large messages)
      const threadBody = await fetchFormattedThread(
        client,
        inboxId,
        message.threadId
      );

      // Extract current message text for RawBody/CommandBody
      const messageBody = extractMessageBody(message);

      // Fall back to webhook payload if thread fetch fails
      const fullBody = threadBody || buildFallbackBody(message);

      // Resolve routing
      const route = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "agentmail",
        peer: {
          kind: "dm",
          id: senderEmail,
        },
      });

      const senderName = parseNameFromAddress(message.from);
      const timestamp = new Date(message.timestamp).getTime();

      // Format envelope
      const storePath = core.channel.session.resolveStorePath(
        cfg.session?.store,
        {
          agentId: route.agentId,
        }
      );
      const envelopeOptions =
        core.channel.reply.resolveEnvelopeFormatOptions(cfg);
      const previousTimestamp = core.channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
      });
      const formattedBody = core.channel.reply.formatAgentEnvelope({
        channel: "Email",
        from: senderName,
        timestamp,
        previousTimestamp,
        envelope: envelopeOptions,
        body: `${fullBody}\n[email message_id: ${message.messageId} thread: ${message.threadId}]`,
      });

      // Build inbound context
      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: formattedBody,
        RawBody: messageBody,
        CommandBody: messageBody,
        From: senderEmail,
        To: inboxId,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: "direct" as const,
        ConversationLabel: senderName,
        SenderName: senderName,
        SenderId: senderEmail,
        SenderUsername: senderEmail.split("@")[0],
        Provider: "agentmail" as const,
        Surface: "agentmail" as const,
        MessageSid: message.messageId,
        MessageThreadId: message.threadId,
        Timestamp: timestamp,
        CommandAuthorized: true,
        CommandSource: "text" as const,
        OriginatingChannel: "agentmail" as const,
        OriginatingTo: inboxId,
      });

      // Record session
      await core.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        updateLastRoute: {
          sessionKey: route.mainSessionKey,
          channel: "agentmail",
          to: inboxId,
          accountId: route.accountId,
        },
        onRecordError: (err) => {
          logger.warn(`Failed updating session meta: ${String(err)}`);
        },
      });

      const preview = messageBody.slice(0, 200).replace(/\n/g, "\\n");
      logVerbose(`agentmail inbound: from=${senderEmail} preview="${preview}"`);

      const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
          humanDelay: core.channel.reply.resolveHumanDelayConfig(
            cfg,
            route.agentId
          ),
          deliver: async (payload) => {
            // Import outbound dynamically to avoid circular deps
            const { sendAgentMailReply } = await import("./outbound.js");
            const text = payload.text ?? "";
            if (!text) return; // Skip empty replies
            await sendAgentMailReply({
              client,
              inboxId,
              messageId: message.messageId,
              text,
            });
            recordState(accountId, { lastOutboundAt: Date.now() });
          },
          onError: (err, info) => {
            logger.error(`agentmail ${info.kind} reply failed: ${String(err)}`);
          },
        });

      const { queuedFinal, counts } =
        await core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions,
        });

      markDispatchIdle();

      if (queuedFinal) {
        logVerbose(
          `agentmail: delivered ${counts.final} reply(ies) to ${senderEmail}`
        );
        core.system.enqueueSystemEvent(`Email from ${senderName}: ${preview}`, {
          sessionKey: route.sessionKey,
          contextKey: `agentmail:message:${message.messageId}`,
        });
      }

      sendJson(res, 200, { ok: true });
    } catch (err) {
      logger.error(`agentmail webhook handler failed: ${String(err)}`);
      sendJson(res, 500, { ok: false, error: String(err) });
    }
  };

  // Register the webhook route
  const unregisterHttp = registerPluginHttpRoute({
    path: webhookPath,
    pluginId: "agentmail",
    accountId,
    log: logVerbose,
    handler: handleWebhook,
  });

  logger.info(`AgentMail: webhook registered at ${webhookPath}`);

  // Wait for abort signal
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      logVerbose("agentmail: stopping monitor");
      unregisterHttp();
      recordState(accountId, { running: false, lastStopAt: Date.now() });
      resolve();
    };

    if (opts.abortSignal?.aborted) {
      onAbort();
      return;
    }

    opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
