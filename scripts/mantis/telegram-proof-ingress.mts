import { appendFile } from "node:fs/promises";
import http from "node:http";
import { z } from "zod";
import { startTelegramTestApiProxy } from "../../.agents/skills/telegram-e2e-userbot/scripts/telegram-test-api-proxy.mjs";
import type { TelegramFailureDiagnostic } from "./request-proof.ts";
import type { TelegramProofPlan } from "./telegram-proof-plan.ts";

const chat = z.union([z.number().int().safe(), z.string().regex(/^-?[1-9][0-9]*$/)]);
const markup = z.strictObject({
  inline_keyboard: z
    .array(
      z
        .array(
          z.strictObject({
            text: z.string().max(128),
            callback_data: z.string().max(64),
          }),
        )
        .max(8),
    )
    .max(8),
});
const send = z.strictObject({
  chat_id: chat,
  text: z.string().max(4096),
  parse_mode: z.enum(["HTML", "Markdown", "MarkdownV2"]).optional(),
  link_preview_options: z.strictObject({ is_disabled: z.boolean() }).optional(),
  reply_markup: markup.optional(),
  reply_parameters: z
    .strictObject({
      message_id: z.number().int().positive(),
      allow_sending_without_reply: z.boolean().optional(),
    })
    .optional(),
});
const edit = send
  .omit({ reply_parameters: true })
  .extend({ message_id: z.number().int().positive() });
const remove = z.strictObject({ chat_id: chat, message_id: z.number().int().positive() });

// Profiles are transport metadata, not scenario observations. Keep routing IDs
// and the bot's getMe username, but do not disclose real display names to PR code.
function syntheticProfiles(value: unknown, keepUsername: boolean, depth = 0): unknown {
  if (depth > 32) {
    throw new Error("Telegram response exceeds projection depth");
  }
  if (Array.isArray(value)) {
    return value.map((item) => syntheticProfiles(item, keepUsername, depth + 1));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "last_name")
      .map(([key, item]) => [
        key,
        key === "first_name"
          ? "Proof user"
          : key === "username" && !keepUsername
            ? "proof_user"
            : syntheticProfiles(item, keepUsername, depth + 1),
      ]),
  );
}

export async function startTelegramProofIngress(options: {
  socket: string;
  alias: string;
  sutToken: string;
  testerId: string;
  plan: TelegramProofPlan;
  providerLog: string;
  lease: { assertHealthy(): void; whenUnhealthy: Promise<Error> };
  fetchImpl?: typeof fetch;
}) {
  type TestApiProxy = Awaited<ReturnType<typeof startTelegramTestApiProxy>>;
  const startProxy = startTelegramTestApiProxy as unknown as (_options: {
    leaseHealth: typeof options.lease;
    fetchImpl: typeof fetch;
  }) => Promise<TestApiProxy>;
  let closed = false,
    invalid = false,
    armed = false,
    polls = 0,
    requests = 0,
    writes = 0;
  const provider: Array<{ user_text: string; response_text: string; streaming: boolean }> = [];
  const messageIds = new Set<number>();
  const callbackIds = new Set<string>();
  const readers = new Set<AbortController>();
  const diagnostics: TelegramFailureDiagnostic[] = [];
  const recordDiagnostic = (category: TelegramFailureDiagnostic["category"]) => {
    if (diagnostics.length < 16) {
      diagnostics.push({ sequence: diagnostics.length + 1, category });
    }
  };
  let stopForwarding!: (error: Error) => void;
  const stopped = new Promise<Error>((resolve) => {
    stopForwarding = resolve;
  });
  const cancel = () => {
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
  void options.lease.whenUnhealthy.then(() => {
    invalid = true;
    cancel();
  });
  const upstream = await startProxy({
    leaseHealth: {
      assertHealthy,
      whenUnhealthy: Promise.race([options.lease.whenUnhealthy, stopped]),
    },
    fetchImpl: async (...args) => {
      try {
        return await (options.fetchImpl ?? fetch)(...args);
      } catch (error) {
        try {
          assertHealthy();
          recordDiagnostic("network_failure");
        } catch {
          recordDiagnostic("authority_unavailable");
        }
        throw error;
      }
    },
  });
  const refuse = (response: http.ServerResponse) => {
    if (!response.headersSent) {
      response.writeHead(403, { "Content-Type": "application/json" });
    }
    response.end(JSON.stringify({ ok: false, description: "Outside active Telegram proof scope" }));
  };
  const server = http.createServer((request, response) => {
    let category: TelegramFailureDiagnostic["category"] = "authority_unavailable";
    const assertRequestHealthy = () => {
      const previous = category;
      category = "authority_unavailable";
      assertHealthy();
      category = previous;
    };
    const rejectScope: (message: string) => never = (message) => {
      category = "scope_rejected";
      throw new Error(message);
    };
    void (async () => {
      assertRequestHealthy();
      category = "malformed_request";
      const probe =
        request.method === "GET" &&
        [
          `/telegram/bot${options.alias}/getMe`,
          `/telegram/bot${options.alias}/getWebhookInfo`,
        ].includes(request.url ?? "");
      if (++requests > 512 || (request.method !== "POST" && !probe)) {
        rejectScope("Unsupported request");
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 256 * 1024 || (probe && length)) {
          throw new Error("Oversized request");
        }
        chunks.push(Buffer.from(chunk));
      }
      assertRequestHealthy();
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      const record = z.record(z.string(), z.unknown()).parse(parsed);
      if (request.url === "/provider/v1/chat/completions") {
        if (!armed || request.headers.authorization !== `Bearer ${options.alias}`) {
          rejectScope("Inactive provider capability");
        }
        const messages = z
          .array(z.object({ role: z.string(), content: z.unknown() }))
          .max(256)
          .parse(record.messages);
        const userText = messages
          .filter((message) => message.role === "user")
          .map((message) =>
            typeof message.content === "string" ? message.content : JSON.stringify(message.content),
          )
          .join("\n");
        const reply = options.plan.modelReplies[provider.length];
        if (reply === undefined || userText.length > 16384) {
          rejectScope("Provider budget exhausted");
        }
        const entry = {
          user_text: userText,
          response_text: reply,
          streaming: record.stream === true,
        };
        // Reserve the response before yielding, so concurrent calls cannot reuse it.
        provider.push(entry);
        await appendFile(options.providerLog, JSON.stringify(entry) + "\n", { mode: 0o600 });
        assertRequestHealthy();
        if (record.stream === true) {
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          response.end(
            `data: ${JSON.stringify({
              id: "mantis-mock",
              object: "chat.completion.chunk",
              choices: [
                { index: 0, delta: { role: "assistant", content: reply }, finish_reason: null },
              ],
            })}\n\ndata: ${JSON.stringify({
              id: "mantis-mock",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\ndata: [DONE]\n\n`,
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
      if (!request.url?.startsWith(prefix)) {
        rejectScope("Wrong Telegram capability");
      }
      const method = request.url.slice(prefix.length);
      // Startup registry operations are simulated; the scenario tests command
      // handling, not shared bot registration or webhook administration.
      if (["deleteWebhook", "deleteMyCommands", "setMyCommands"].includes(method)) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, result: true }));
        return;
      }
      let outbound: Record<string, unknown>;
      if (method === "getMe" || method === "getWebhookInfo") {
        outbound = z.strictObject({}).parse(record);
      } else if (method === "getUpdates") {
        outbound = z
          .strictObject({
            timeout: z.number().min(0).max(30),
            offset: z.number().int().safe().optional(),
            limit: z.number().int().min(1).max(100).optional(),
            allowed_updates: z.array(z.string().max(64)).max(32).optional(),
          })
          .parse(record);
      } else if (method === "answerCallbackQuery") {
        const answer = z
          .strictObject({
            callback_query_id: z.string().max(256),
            text: z.string().max(200).optional(),
            show_alert: z.boolean().optional(),
            cache_time: z.literal(0).optional(),
          })
          .parse(record);
        if (!armed || ++writes > 64 || !callbackIds.delete(answer.callback_query_id)) {
          rejectScope("Callback outside this proof");
        }
        outbound = answer;
      } else {
        if (!armed || ++writes > 64 || String(record.chat_id) !== options.testerId) {
          rejectScope("Outside leased DM budget");
        }
        if (method === "sendMessage") {
          outbound = { ...send.parse(record), link_preview_options: { is_disabled: true } };
        } else if (method === "editMessageText") {
          outbound = { ...edit.parse(record), link_preview_options: { is_disabled: true } };
        } else if (method === "deleteMessage") {
          outbound = remove.parse(record);
        } else if (method === "sendChatAction") {
          outbound = z.strictObject({ chat_id: chat, action: z.literal("typing") }).parse(record);
        } else {
          rejectScope("Method outside the selected DM observation surface");
        }
        if ("message_id" in outbound && !messageIds.has(Number(outbound.message_id))) {
          rejectScope("Mutation targets a message outside this proof");
        }
        if ("reply_parameters" in outbound) {
          const parameters = outbound.reply_parameters as { message_id: number };
          if (!messageIds.has(parameters.message_id)) {
            rejectScope("Reply targets stale message");
          }
        }
      }
      const controller = new AbortController();
      readers.add(controller);
      try {
        assertRequestHealthy();
        const upstreamUrl = new URL(upstream.apiRoot);
        upstreamUrl.pathname = `/bot${options.sutToken}/${method}`;
        category = "network_failure";
        const result = await fetch(upstreamUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(outbound),
          redirect: "error",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(40_000)]),
        });
        category = "upstream_failure";
        if (!result.ok) {
          throw new Error("Upstream request failed");
        }
        const upstreamChunks: Uint8Array[] = [];
        let size = 0;
        if (!result.body) {
          throw new Error("Missing upstream body");
        }
        for await (const chunk of result.body) {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            throw new Error("Oversized upstream response");
          }
          upstreamChunks.push(chunk);
        }
        const data = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(Buffer.concat(upstreamChunks).toString("utf8")));
        if (data.ok !== true) {
          throw new Error("Upstream result failed");
        }
        assertRequestHealthy();
        if (method === "getUpdates") {
          polls += 1;
          const updates = z.array(z.record(z.string(), z.unknown())).parse(data.result);
          data.result = updates.filter((update) => {
            const message = z
              .object({
                message_id: z.number().int().positive(),
                chat: z.object({ id: z.number(), type: z.literal("private") }),
                from: z.object({ id: z.number() }),
              })
              .safeParse(update.message);
            if (
              message.success &&
              String(message.data.chat.id) === options.testerId &&
              String(message.data.from.id) === options.testerId
            ) {
              if (armed) {
                messageIds.add(message.data.message_id);
              }
              return armed;
            }
            const callback = z
              .object({
                id: z.string().max(256),
                from: z.object({ id: z.number() }),
                message: z.object({
                  message_id: z.number().int(),
                  chat: z.object({ id: z.number(), type: z.literal("private") }),
                }),
              })
              .safeParse(update.callback_query);
            const accepted =
              armed &&
              callback.success &&
              String(callback.data.from.id) === options.testerId &&
              String(callback.data.message.chat.id) === options.testerId &&
              messageIds.has(callback.data.message.message_id);
            if (accepted && callback.success) {
              callbackIds.add(callback.data.id);
            }
            return accepted;
          });
        }
        if (method === "sendMessage") {
          const sent = z
            .object({
              message_id: z.number().int().positive(),
              chat: z.object({ id: z.number(), type: z.literal("private") }),
            })
            .parse(data.result);
          if (String(sent.chat.id) !== options.testerId) {
            throw new Error("Unexpected destination");
          }
          messageIds.add(sent.message_id);
        }
        response.writeHead(result.status, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify(syntheticProfiles(data, method === "getMe")).replaceAll(
            options.sutToken,
            "[redacted]",
          ),
        );
      } finally {
        readers.delete(controller);
      }
    })().catch(() => {
      recordDiagnostic(category);
      invalid = true;
      cancel();
      refuse(response);
    });
  });
  server.requestTimeout = 45_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socket, resolve);
  });
  return {
    getDiagnostics: () =>
      diagnostics.map((entry) => ({ sequence: entry.sequence, category: entry.category })),
    assertHealthy,
    drainStaleUpdates: () => upstream.drainUpdates(options.sutToken),
    isPolling: () => polls > 0,
    armScenario() {
      assertHealthy();
      if (armed) {
        throw new Error("Scenario already armed");
      }
      armed = true;
    },
    providerCapture: () => provider,
    async close() {
      closed = true;
      cancel();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await upstream.close();
    },
  };
}
