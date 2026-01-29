import type { Request, Response } from "express";
import type { ClawdbotConfig, RuntimeEnv } from "clawdbot/plugin-sdk";
import { resolveLarkCredentials } from "./token.js";
import type { LarkConfig } from "./types.js";
import * as crypto from "crypto";
import { getLarkRuntime } from "./runtime.js";
import { createLarkReplyDispatcher } from "./reply-dispatcher.js";

export type MonitorLarkOpts = {
  cfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

export type MonitorLarkResult = {
  app: unknown;
  shutdown: () => Promise<void>;
};

function decrypt(encrypt: string, key: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(key);
  const keyBytes = hash.digest();

  const buf = Buffer.from(encrypt, "base64");
  const iv = buf.subarray(0, 16);
  const content = buf.subarray(16);

  const decipher = crypto.createDecipheriv("aes-256-cbc", keyBytes, iv);
  let decrypted = decipher.update(content);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString("utf8");
}

function normalizeAllowEntry(entry: string): string {
  return entry.trim().replace(/^lark:/i, "").replace(/^feishu:/i, "");
}

function isAllowed(senderId: string, allowFrom: string[], dmPolicy: string): boolean {
  if (dmPolicy === "open") return true;
  if (!allowFrom || allowFrom.length === 0) return dmPolicy !== "allowlist";

  const normalizedSender = normalizeAllowEntry(senderId);
  return allowFrom.some((entry) => {
    if (entry === "*") return true;
    return normalizeAllowEntry(entry) === normalizedSender;
  });
}

export async function monitorLarkProvider(opts: MonitorLarkOpts): Promise<MonitorLarkResult> {
  const log = opts.runtime?.log ?? console.log;
  const errorLog = opts.runtime?.error ?? console.error;
  const cfg = opts.cfg;
  const larkCfg = cfg.channels?.lark as LarkConfig | undefined;

  if (!larkCfg?.enabled) {
    log("Lark provider disabled");
    return { app: null, shutdown: async () => {} };
  }

  const creds = resolveLarkCredentials(larkCfg);
  if (!creds) {
    errorLog("Lark credentials not configured (appId and appSecret required)");
    return { app: null, shutdown: async () => {} };
  }

  const express = await import("express");
  const app = express.default();
  app.use(express.json());

  const port = larkCfg.webhook?.port ?? 3000;
  const path = larkCfg.webhook?.path ?? "/lark/webhook";
  const dmPolicy = larkCfg.dmPolicy ?? "pairing";
  const allowFrom = larkCfg.allowFrom ?? [];

  app.post(path, async (req: Request, res: Response) => {
    try {
      let body = req.body;

      if (body.encrypt && creds.encryptKey) {
        try {
          const decrypted = decrypt(body.encrypt, creds.encryptKey);
          body = JSON.parse(decrypted);
        } catch (err) {
          errorLog("Lark decryption failed:", err);
          res.status(400).send("Decryption failed");
          return;
        }
      }

      if (body.type === "url_verification") {
        if (creds.verificationToken && body.token !== creds.verificationToken) {
          errorLog("Invalid verification token in url_verification");
          res.status(403).send("Invalid verification token");
          return;
        }
        res.json({ challenge: body.challenge });
        return;
      }

      if (body.schema === "2.0") {
        const header = body.header;
        const event = body.event;

        if (!header || !event) {
          errorLog("Missing header or event in schema 2.0 payload");
          res.status(400).send("Invalid payload");
          return;
        }

        if (creds.verificationToken && header.token !== creds.verificationToken) {
          errorLog("Invalid verification token in event callback");
          res.status(403).send("Invalid verification token");
          return;
        }

        if (header.event_type === "im.message.receive_v1") {
          const message = event.message;
          const sender = event.sender;

          if (!message || !sender) {
            errorLog("Missing message or sender in event");
            res.status(200).send("OK");
            return;
          }

          let content: { text?: string };
          try {
            content = JSON.parse(message.content ?? "{}");
          } catch {
            errorLog("Failed to parse message content");
            res.status(200).send("OK");
            return;
          }

          const text = content.text ?? "";
          const fromId = sender.sender_id?.open_id || sender.sender_id?.user_id || "";
          const chatId = message.chat_id;
          const chatType = message.chat_type;

          if (!fromId) {
            errorLog("Unable to identify sender");
            res.status(200).send("OK");
            return;
          }

          const senderKey = fromId;
          const isDirect = chatType === "p2p";
          const channelId = isDirect ? fromId : chatId;

          log(`Lark received message from ${senderKey}: ${text.substring(0, 50)}`);

          if (isDirect && !isAllowed(senderKey, allowFrom, dmPolicy)) {
            log(`Sender ${senderKey} not in allowFrom list (policy: ${dmPolicy})`);

            if (dmPolicy === "pairing") {
              const core = getLarkRuntime();
              const pairingCode = core.channel.pairing?.generatePairingCode?.("lark", senderKey);

              if (pairingCode) {
                const dispatcher = createLarkReplyDispatcher({ cfg, channelId });
                await dispatcher.dispatch({
                  body: `To chat with this bot, please ask the owner to approve your pairing code: ${pairingCode}`,
                });
              }
            }

            res.status(200).send("OK");
            return;
          }

          const core = getLarkRuntime();
          const route = core.channel.routing.resolveAgentRoute({
            cfg,
            channel: "lark",
            peer: {
              kind: isDirect ? "dm" : "group",
              id: channelId,
            },
          });

          const ctxPayload = core.channel.reply.finalizeInboundContext({
            Body: text,
            RawBody: text,
            CommandBody: text,
            From: `lark:${senderKey}`,
            To: `lark:${creds.appId}`,
            SessionKey: route.sessionKey,
            AccountId: creds.appId,
            ChatType: isDirect ? "direct" : "group",
            SenderName: sender.sender_id?.user_id ?? "Lark User",
            SenderId: senderKey,
            Provider: "lark",
            Surface: "lark",
            Timestamp: Number(message.create_time) || Date.now(),
            OriginatingChannel: "lark",
            OriginatingTo: `lark:${creds.appId}`,
          });

          const dispatcher = createLarkReplyDispatcher({ cfg, channelId });

          await core.channel.reply.dispatchReplyFromConfig({
            ctx: ctxPayload,
            cfg,
            dispatcher,
            replyOptions: {},
          });
        }
      }

      res.status(200).send("OK");
    } catch (err) {
      errorLog("Lark webhook error:", err);
      res.status(500).send("Internal Error");
    }
  });

  let server: ReturnType<typeof app.listen> | null = null;

  const startServer = () => {
    server = app.listen(port, () => {
      log(`Lark provider listening on port ${port} at ${path}`);
    });
  };

  startServer();

  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => {
      if (server) {
        server.close();
        server = null;
      }
    });
  }

  return {
    app,
    shutdown: async () => {
      if (server) {
        server.close();
        server = null;
      }
    },
  };
}
