import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import http from "node:http";
import { z } from "zod";
import { startTelegramTestApiProxy } from "../../.agents/skills/telegram-e2e-userbot/scripts/telegram-test-api-proxy.mjs";
import {
  telegramProofDigest,
  telegramProofPrompt,
  telegramProofReply,
} from "./telegram-request-proof.ts";

const safeSendMessageSchema = z.strictObject({
  chat_id: z.union([z.number().int().safe(), z.string().regex(/^-?[1-9][0-9]*$/)]),
  text: z.string().max(4096),
  parse_mode: z.literal("HTML").optional(),
  link_preview_options: z.strictObject({ is_disabled: z.literal(true) }).optional(),
});
const safeDeleteMyCommandsSchema = z.union([
  z.strictObject({}),
  z.strictObject({ scope: z.strictObject({ type: z.literal("all_group_chats") }) }),
]);

export async function startTelegramProofIngress(options: {
  socket: string;
  alias: string;
  sutToken: string;
  testerId: string;
  nonce: string;
  providerLog: string;
  lease: { assertHealthy(): void; whenUnhealthy: Promise<Error> };
  fetchImpl?: typeof fetch;
}) {
  type TestApiProxy = Awaited<ReturnType<typeof startTelegramTestApiProxy>>;
  const startProxy = startTelegramTestApiProxy as unknown as (_proxyOptions: {
    leaseHealth: typeof options.lease;
    fetchImpl: typeof fetch;
  }) => Promise<TestApiProxy>;
  let closed = false;
  let invalid = false;
  let polls = 0;
  let requests = 0;
  let sendArmed = false;
  let outboundMessages = 0;
  let rejectedReply: { textSha256: string } | undefined;
  let typingActions = 0;
  let webhookCleanupSimulations = 0;
  const commandCleanupSimulations = new Set<string>();
  let provider:
    | {
        inputNonce: string;
        responseNonce: string;
        responseSha256: string;
        count: number;
      }
    | undefined;
  const readers = new Set<AbortController>();
  let stopForwarding!: (error: Error) => void;
  const forwardingStopped = new Promise<Error>((resolve) => {
    stopForwarding = resolve;
  });
  const cancelForwarding = () => {
    stopForwarding(new Error("Telegram proof forwarding stopped"));
    for (const controller of readers) {
      controller.abort();
    }
  };
  const assertHealthy = () => {
    if (closed || invalid) {
      throw new Error("Telegram ingress is closed or invalid");
    }
    options.lease.assertHealthy();
  };
  const assertForwardingHealthy = () => {
    assertHealthy();
    if (rejectedReply) {
      throw new Error("Telegram proof reply was rejected");
    }
  };
  void options.lease.whenUnhealthy.then(() => {
    invalid = true;
    cancelForwarding();
  });
  // The second HTTP hop owns the external fetch, so it must share ingress
  // revocation rather than only the longer-lived credential lease.
  const upstream = await startProxy({
    leaseHealth: {
      assertHealthy: assertForwardingHealthy,
      whenUnhealthy: Promise.race([options.lease.whenUnhealthy, forwardingStopped]),
    },
    fetchImpl: options.fetchImpl ?? fetch,
  });
  const refuse = (response: http.ServerResponse) => {
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ ok: false, description: "Request outside active Telegram proof scope" }),
    );
  };
  const server = http.createServer((request, response) => {
    void (async () => {
      assertHealthy();
      if (rejectedReply) {
        request.resume();
        refuse(response);
        return;
      }
      const probeRead =
        request.method === "GET" &&
        (request.url === `/telegram/bot${options.alias}/getMe` ||
          request.url === `/telegram/bot${options.alias}/getWebhookInfo`);
      if (
        ++requests > 256 ||
        (request.method !== "POST" && !probeRead) ||
        !request.url?.startsWith("/")
      ) {
        throw new Error("Unsupported ingress request");
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if ((probeRead && length !== 0) || length > 256 * 1024) {
          throw new Error("Oversized ingress body");
        }
        chunks.push(Buffer.from(chunk));
      }
      assertHealthy();
      const body = Buffer.concat(chunks);
      const parsed: unknown = JSON.parse(body.toString("utf8") || "{}");
      const record = z.record(z.string(), z.unknown()).parse(parsed);
      // A prior concurrent request may have completed the single bounded failure.
      if (rejectedReply) {
        refuse(response);
        return;
      }
      if (request.url === "/provider/v1/chat/completions") {
        if (request.headers.authorization !== `Bearer ${options.alias}`) {
          throw new Error("Wrong provider capability");
        }
        const messages = z
          .array(z.object({ role: z.string(), content: z.unknown() }))
          .max(256)
          .parse(record.messages);
        const text = messages
          .filter((item) => item.role === "user")
          .map((item) => JSON.stringify(item.content))
          .join("\n");
        if (!text.includes(telegramProofPrompt(options.nonce))) {
          throw new Error("Provider request lacks sent-action nonce");
        }
        const responseNonce = provider?.responseNonce ?? randomBytes(32).toString("hex");
        const reply = telegramProofReply(responseNonce);
        provider = {
          inputNonce: options.nonce,
          responseNonce,
          responseSha256: telegramProofDigest(reply),
          count: (provider?.count ?? 0) + 1,
        };
        await appendFile(
          options.providerLog,
          `${JSON.stringify({ request: parsed, responseNonce })}\n`,
          { mode: 0o600 },
        );
        assertHealthy();
        if (record.stream === true) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({ id: "mantis-mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "mantis-mock", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
          );
        } else {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              id: "mantis-mock",
              object: "chat.completion",
              choices: [
                { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
        }
        return;
      }
      const prefix = `/telegram/bot${options.alias}/`;
      if (!request.url.startsWith(prefix)) {
        throw new Error("Wrong Telegram capability");
      }
      const method = request.url.slice(prefix.length);
      let upstreamRecord = record;
      if (method === "deleteWebhook") {
        const cleanup = z
          .strictObject({ drop_pending_updates: z.literal(false) })
          .safeParse(record);
        if (!cleanup.success || polls !== 0 || sendArmed || webhookCleanupSimulations !== 0) {
          throw new Error("Telegram webhook cleanup outside bounded polling startup");
        }
        webhookCleanupSimulations += 1;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, result: true }));
        return;
      }
      if (method === "deleteMyCommands") {
        const cleanup = safeDeleteMyCommandsSchema.safeParse(record);
        const scope = cleanup.success && "scope" in cleanup.data ? "all_group_chats" : "default";
        if (!cleanup.success || polls !== 0 || sendArmed || commandCleanupSimulations.has(scope)) {
          throw new Error("Telegram command cleanup outside bounded polling startup");
        }
        commandCleanupSimulations.add(scope);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, result: true }));
        return;
      }
      const readMethods = new Set(["getMe", "getUpdates", "getWebhookInfo"]);
      const sendMethods = new Set([
        "sendMessage",
        "sendChatAction",
        "editMessageText",
        "deleteMessage",
      ]);
      if (!readMethods.has(method) && !sendMethods.has(method)) {
        throw new Error("Telegram method outside basic DM scope");
      }
      if (sendMethods.has(method) && String(record.chat_id) !== options.testerId) {
        throw new Error("Telegram target outside leased DM");
      }
      if (method === "sendChatAction") {
        if (
          !sendArmed ||
          outboundMessages !== 0 ||
          record.action !== "typing" ||
          ++typingActions > 4
        ) {
          throw new Error("Telegram typing action outside bounded reply preparation");
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, result: true }));
        return;
      }
      if (method === "sendMessage") {
        upstreamRecord = safeSendMessageSchema.parse(record);
      }
      if (sendMethods.has(method)) {
        if (!sendArmed) {
          throw new Error("Telegram egress is not armed");
        }
        if (
          method !== "sendMessage" ||
          outboundMessages !== 0 ||
          !provider ||
          provider.count !== 1
        ) {
          throw new Error("Telegram egress exceeds the single expected reply");
        }
        assertHealthy();
        outboundMessages += 1;
        if (upstreamRecord.text !== telegramProofReply(provider.responseNonce)) {
          // Record the failed behavior at its trusted boundary, without sending
          // arbitrary candidate content to Telegram. All later traffic is refused.
          rejectedReply = { textSha256: telegramProofDigest(String(upstreamRecord.text)) };
          cancelForwarding();
          refuse(response);
          return;
        }
      }
      if (
        method === "getUpdates" &&
        (typeof record.timeout !== "number" || record.timeout < 0 || record.timeout > 30)
      ) {
        throw new Error("Unbounded polling");
      }
      const controller = new AbortController();
      readers.add(controller);
      try {
        // Body collection yielded to concurrent requests. Authority must still
        // belong to this active proof at the last point before forwarding.
        assertForwardingHealthy();
        const upstreamUrl = new URL(upstream.apiRoot);
        upstreamUrl.pathname = `/bot${options.sutToken}/${method}`;
        const result = await fetch(upstreamUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(upstreamRecord),
          redirect: "error",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(40_000)]),
        });
        const text = await result.text();
        if (Buffer.byteLength(text) > 2 * 1024 * 1024) {
          throw new Error("Oversized Test Server response");
        }
        const data = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
        assertForwardingHealthy();
        if (method === "getUpdates") {
          polls += 1;
          const updates = z.array(z.record(z.string(), z.unknown())).parse(data.result);
          data.result = updates.filter((update) => {
            const message = z
              .object({
                chat: z.object({ id: z.number(), type: z.literal("private") }),
                from: z.object({ id: z.number() }),
              })
              .safeParse(update.message);
            return (
              message.success &&
              String(message.data.chat.id) === options.testerId &&
              String(message.data.from.id) === options.testerId
            );
          });
        }
        if (method === "sendMessage" && data.ok === true) {
          const sent = z
            .object({
              message_id: z.number().int().positive(),
              chat: z.object({ id: z.number(), type: z.literal("private") }),
            })
            .parse(data.result);
          if (String(sent.chat.id) !== options.testerId) {
            throw new Error("Unexpected Test Server destination");
          }
        }
        response.writeHead(result.status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(data).replaceAll(options.sutToken, "[redacted]"));
      } finally {
        readers.delete(controller);
      }
    })().catch(() => {
      if (!rejectedReply) {
        invalid = true;
      }
      cancelForwarding();
      refuse(response);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socket, resolve);
  });
  return {
    assertHealthy,
    drainStaleUpdates: () => upstream.drainUpdates(options.sutToken),
    isPolling: () => polls > 0,
    armSingleSend() {
      assertHealthy();
      if (sendArmed || outboundMessages !== 0) {
        throw new Error("Telegram egress was already armed");
      }
      sendArmed = true;
    },
    assertSingleSendComplete() {
      assertHealthy();
      if (!sendArmed || outboundMessages !== 1) {
        throw new Error("Exactly one bounded Telegram reply attempt was not observed");
      }
    },
    providerCapture: () => provider,
    rejectedReplyCapture: () => rejectedReply,
    async close() {
      closed = true;
      cancelForwarding();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await upstream.close();
    },
  };
}
