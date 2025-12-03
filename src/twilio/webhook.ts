import type { Server } from "node:http";
import bodyParser from "body-parser";
import chalk from "chalk";
import express, { type Request, type Response } from "express";
import { getReplyFromConfig, type ReplyPayload } from "../auto-reply/reply.js";
import { type EnvConfig, readEnv } from "../env.js";
import { danger, success } from "../globals.js";
import * as mediaHost from "../media/host.js";
import { attachMediaRoutes } from "../media/server.js";
import { saveMediaSource } from "../media/store.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { normalizePath } from "../utils.js";
import { createClient } from "./client.js";
import { sendTypingIndicator } from "./typing.js";
import { logTwilioSendError } from "./utils.js";

/** Start the inbound webhook HTTP server and wire optional auto-replies. */
export async function startWebhook(
  port: number,
  path = "/webhook/whatsapp",
  autoReply: string | undefined,
  verbose: boolean,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<Server> {
  const normalizedPath = normalizePath(path);
  const env = readEnv(runtime);
  const app = express();

  attachMediaRoutes(app, undefined, runtime);
  // Twilio sends application/x-www-form-urlencoded payloads.
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    runtime.log(chalk.gray(`REQ ${req.method} ${req.url}`));
    next();
  });

  app.post(normalizedPath, async (req: Request, res: Response) => {
    const { From, To, Body, MessageSid } = req.body ?? {};
    runtime.log(`
[INBOUND] ${From ?? "unknown"} -> ${To ?? "unknown"} (${MessageSid ?? "no-sid"})`);
    if (verbose) runtime.log(chalk.gray(`Body: ${Body ?? ""}`));

    const numMedia = Number.parseInt((req.body?.NumMedia ?? "0") as string, 10);
    let mediaPath: string | undefined;
    let mediaUrlInbound: string | undefined;
    let mediaType: string | undefined;
    if (numMedia > 0 && typeof req.body?.MediaUrl0 === "string") {
      mediaUrlInbound = req.body.MediaUrl0 as string;
      mediaType =
        typeof req.body?.MediaContentType0 === "string"
          ? (req.body.MediaContentType0 as string)
          : undefined;
      try {
        const creds = buildTwilioBasicAuth(env);
        const saved = await saveMediaSource(
          mediaUrlInbound,
          {
            Authorization: `Basic ${creds}`,
          },
          "inbound",
        );
        mediaPath = saved.path;
        if (!mediaType && saved.contentType) mediaType = saved.contentType;
      } catch (err) {
        runtime.error(
          danger(`Failed to download inbound media: ${String(err)}`),
        );
      }
    }

    const client = createClient(env);
    let replyResult: ReplyPayload | ReplyPayload[] | undefined =
      autoReply !== undefined ? { text: autoReply } : undefined;
    if (!replyResult) {
      replyResult = await getReplyFromConfig(
        {
          Body,
          From,
          To,
          MessageSid,
          MediaPath: mediaPath,
          MediaUrl: mediaUrlInbound,
          MediaType: mediaType,
        },
        {
          onReplyStart: async () => {
            await sendTypingIndicator(client, runtime, MessageSid);
          },
        },
      );
    }

    const replyPayload = Array.isArray(replyResult)
      ? replyResult[0]
      : replyResult;

    if (replyPayload && (replyPayload.text || replyPayload.mediaUrl)) {
      try {
        let mediaUrl = replyPayload.mediaUrl;
        if (mediaUrl && !/^https?:\/\//i.test(mediaUrl)) {
          const hosted = await mediaHost.ensureMediaHosted(mediaUrl);
          mediaUrl = hosted.url;
        }
        await client.messages.create({
          from: To,
          to: From,
          body: replyPayload.text ?? "",
          ...(mediaUrl ? { mediaUrl: [mediaUrl] } : {}),
        });
        if (verbose)
          runtime.log(
            success(`↩️  Auto-replied to ${From}${mediaUrl ? " (media)" : ""}`),
          );
      } catch (err) {
        logTwilioSendError(err, From ?? undefined, runtime);
      }
    }

    // Respond 200 OK to Twilio.
    res.type("text/xml").send("<Response></Response>");
  });

  app.use((_req, res) => {
    if (verbose) runtime.log(chalk.yellow(`404 ${_req.method} ${_req.url}`));
    res.status(404).send("warelay webhook: not found");
  });

  // Start server and resolve once listening; reject on bind error.
  return await new Promise((resolve, reject) => {
    const server = app.listen(port);

    const onListening = () => {
      cleanup();
      runtime.log(
        `📥 Webhook listening on http://localhost:${port}${normalizedPath}`,
      );
      resolve(server);
    };

    const onError = (err: NodeJS.ErrnoException) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      server.off("listening", onListening);
      server.off("error", onError);
    };

    server.once("listening", onListening);
    server.once("error", onError);
  });
}

function buildTwilioBasicAuth(env: EnvConfig) {
  if ("authToken" in env.auth) {
    return Buffer.from(`${env.accountSid}:${env.auth.authToken}`).toString(
      "base64",
    );
  }
  return Buffer.from(`${env.auth.apiKey}:${env.auth.apiSecret}`).toString(
    "base64",
  );
}
