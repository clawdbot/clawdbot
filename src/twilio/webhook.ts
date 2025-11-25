import express, { type Request, type Response } from "express";
import bodyParser from "body-parser";
import chalk from "chalk";
import type { Server } from "http";

import { success, logVerbose, danger } from "../globals.js";
import { readEnv } from "../env.js";
import { createClient } from "./client.js";
import { normalizePath } from "../utils.js";
import { getReplyFromConfig, type ReplyPayload } from "../auto-reply/reply.js";
import { sendTypingIndicator } from "./typing.js";
import { logTwilioSendError } from "./utils.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { attachMediaRoutes } from "../media/server.js";

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

    const client = createClient(env);
    let replyResult: ReplyPayload | undefined =
      autoReply !== undefined ? { text: autoReply } : undefined;
    if (!replyResult) {
      replyResult = await getReplyFromConfig(
        { Body, From, To, MessageSid },
        {
          onReplyStart: () => sendTypingIndicator(client, runtime, MessageSid),
        },
      );
    }

    if (replyResult && (replyResult.text || replyResult.mediaUrl)) {
      try {
        await client.messages.create({
          from: To,
          to: From,
          body: replyResult.text ?? "",
          ...(replyResult.mediaUrl ? { mediaUrl: [replyResult.mediaUrl] } : {}),
        });
        if (verbose)
          runtime.log(
            success(
              `↩️  Auto-replied to ${From}${replyResult.mediaUrl ? " (media)" : ""}`,
            ),
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
