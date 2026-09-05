import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createRequestReceipt } from "../../scripts/mantis/request-proof.ts";
import { normalizeTelegramCapture } from "../../scripts/mantis/telegram-capture.ts";
import { startTelegramProofIngress } from "../../scripts/mantis/telegram-proof-ingress.mts";
import {
  telegramProofDigest,
  telegramProofIdentitySchema,
  telegramProofPrompt,
  verifyTelegramProofFiles,
} from "../../scripts/mantis/telegram-request-proof.ts";

const nonce = "e".repeat(64);
const identity = telegramProofIdentitySchema.parse({
  request_id: "a".repeat(64),
  repository: { id: "1", full_name: "openclaw/openclaw" },
  pull_request: 1,
  candidate_sha: "b".repeat(40),
  scenario: "telegram-bot-e2e-proof",
  workflow: { path: ".github/workflows/mantis-telegram-bot-e2e-proof.yml", sha: "c".repeat(40) },
  harness: { sha: "c".repeat(40) },
  run: { id: "2", attempt: 1 },
});

it.each([
  ["getMe", "/telegram/bot1:fixture/getMe", "", true],
  ["getWebhookInfo", "/telegram/bot1:fixture/getWebhookInfo", "", true],
  ["provider", "/provider/v1/chat/completions", "", false],
  ["getUpdates", "/telegram/bot1:fixture/getUpdates", "", false],
  ["sendMessage", "/telegram/bot1:fixture/sendMessage", "", false],
  ["wrong alias", "/telegram/bot1:other/getMe", "", false],
  ["query", "/telegram/bot1:fixture/getMe?x=1", "", false],
  ["body", "/telegram/bot1:fixture/getMe", "{}", false],
] as const)(
  "allows only bounded GET startup probes (%s)",
  async (_name, requestPath, body, accepted) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tg-probe-"));
    const socket =
      process.platform === "win32"
        ? `\\\\.\\pipe\\mantis-${randomUUID()}`
        : path.join(root, "api.sock");
    const forwarded: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    const ingress = await startTelegramProofIngress({
      socket,
      alias: "1:fixture",
      sutToken: "fixture-private-token",
      testerId: "43",
      nonce,
      providerLog: path.join(root, "provider.ndjson"),
      lease: { assertHealthy() {}, whenUnhealthy: new Promise(() => {}) },
      fetchImpl: async (url, options) => {
        forwarded.push({
          url: url instanceof URL ? url.href : typeof url === "string" ? url : url.url,
          method: options?.method,
          body: await new Response(options?.body).json(),
        });
        return Response.json({ ok: true, result: {} });
      },
    });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const request = http.request(
          {
            socketPath: socket,
            path: requestPath,
            method: "GET",
            headers: { "content-length": Buffer.byteLength(body) },
          },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode ?? 0));
          },
        );
        request.on("error", reject);
        request.end(body);
      });
      expect(status).toBe(accepted ? 200 : 403);
      if (accepted) {
        expect(forwarded).toEqual([
          {
            url: `https://api.telegram.org/botfixture-private-token/test/${_name}`,
            method: "POST",
            body: {},
          },
        ]);
        ingress.assertHealthy();
      } else {
        expect(forwarded).toEqual([]);
        expect(() => ingress.assertHealthy()).toThrow();
      }
      expect(ingress.rejectedReplyCapture()).toBeUndefined();
    } finally {
      await ingress.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each([
  "wrong-text",
  "wrong-target",
  "extra-field",
  "multiple-provider",
  "missing-provider",
  "unarmed",
])("bounds actual trusted ingress and normalized evidence (%s)", async (fault) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tg-blocked-"));
  // Named pipes exercise the same Node HTTP boundary on Windows; the hosted
  // controller remains Unix-socket based. No TDLib, lease or live traffic here.
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\mantis-${randomUUID()}`
      : path.join(root, "api.sock");
  let forwarded = 0;
  const ingress = await startTelegramProofIngress({
    socket,
    alias: "1:fixture",
    sutToken: "fixture-private-token",
    testerId: "43",
    nonce,
    providerLog: path.join(root, "provider.ndjson"),
    lease: { assertHealthy() {}, whenUnhealthy: new Promise(() => {}) },
    fetchImpl: async () => {
      forwarded++;
      throw new Error("Unexpected Test Server forwarding");
    },
  });
  const post = (requestPath: string, body: unknown, authorization?: string) =>
    new Promise<number>((resolve, reject) => {
      const request = http.request(
        {
          socketPath: socket,
          path: requestPath,
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authorization ? { authorization } : {}),
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify(body));
    });
  try {
    if (fault !== "unarmed") {
      ingress.armSingleSend();
    }
    const providerInput = { messages: [{ role: "user", content: telegramProofPrompt(nonce) }] };
    if (fault !== "missing-provider") {
      expect(await post("/provider/v1/chat/completions", providerInput, "Bearer 1:fixture")).toBe(
        200,
      );
    }
    if (fault === "multiple-provider") {
      expect(await post("/provider/v1/chat/completions", providerInput, "Bearer 1:fixture")).toBe(
        200,
      );
    }
    const wrongText = "private unexpected candidate output";
    expect(
      await post("/telegram/bot1:fixture/sendMessage", {
        chat_id: fault === "wrong-target" ? 99 : 43,
        text: wrongText,
        ...(fault === "extra-field" ? { reply_markup: {} } : {}),
      }),
    ).toBe(403);
    expect(forwarded).toBe(0);
    if (fault !== "wrong-text") {
      expect(() => ingress.assertHealthy()).toThrow();
      expect(ingress.rejectedReplyCapture()).toBeUndefined();
      return;
    }
    ingress.assertSingleSendComplete();
    expect(ingress.rejectedReplyCapture()).toEqual({
      textSha256: telegramProofDigest(wrongText),
    });
    // The failed run is terminal: no subsequent mutation can escape or replace
    // the first observation, including an otherwise expected retry.
    expect(await post("/telegram/bot1:fixture/deleteMessage", { chat_id: 43, message_id: 5 })).toBe(
      403,
    );
    expect(await post("/provider/v1/chat/completions", providerInput, "Bearer 1:fixture")).toBe(
      403,
    );
    expect(forwarded).toBe(0);
    ingress.assertHealthy();
    const provider = ingress.providerCapture()!;
    // Synthetic completed recorder input isolates the normalization contract;
    // the ingress request and refusal above are actual local HTTP operations.
    const input = {
      identity,
      nonce,
      salt: Buffer.alloc(32, 7),
      sutId: 42,
      testerId: 43,
      testDc: true,
      quiescent: true,
      leaseHealthy: true,
      provider,
      ready: { chatId: 42, chatType: "private", peerUserId: 42 },
      summary: {
        recordingComplete: true,
        chatId: "42",
        sentMessageId: 1048576,
        sentMessageIds: [1048576],
      },
      raw: JSON.stringify({
        kind: "action",
        actionType: "send",
        status: "completed",
        messageId: 1048576,
        botApiMessageId: 1,
        elapsedMs: 0,
        text: telegramProofPrompt(nonce),
      }),
      rejectedReply: ingress.rejectedReplyCapture(),
    };
    const files = normalizeTelegramCapture(input);
    const encoded = Object.fromEntries(
      Object.entries(files).map(([file, value]) => [
        file,
        Buffer.from(JSON.stringify(value)).toString("base64"),
      ]),
    );
    const result = verifyTelegramProofFiles(identity, encoded);
    expect(result.assertion_outcome).toBe("fail");
    expect(
      createRequestReceipt(
        identity,
        "completed",
        { artifact_id: "3", artifact_name: "mantis-request-telegram-2-1", sha256: "d".repeat(64) },
        encoded,
      ).assertion_outcome,
    ).toBe("fail");
    expect(result.observations[2]!.actual).toContain("Blocked before Telegram forwarding");
    expect(files["telegram-reply.json"]).toMatchObject({
      delivery: "blocked_before_forward",
      message_id: null,
      in_reply_to: null,
    });
    expect(JSON.stringify(files)).not.toContain(wrongText);
    expect(() => normalizeTelegramCapture({ ...input, rejectedReply: undefined })).toThrow();
    expect(() =>
      normalizeTelegramCapture({
        ...input,
        rejectedReply: { textSha256: provider.responseSha256 },
      }),
    ).toThrow();
    expect(() => normalizeTelegramCapture({ ...input, quiescent: false })).toThrow();
    expect(() => normalizeTelegramCapture({ ...input, leaseHealthy: false })).toThrow();
    expect(() =>
      normalizeTelegramCapture({ ...input, provider: { ...provider, count: 2 } }),
    ).toThrow();
    expect(() =>
      normalizeTelegramCapture({ ...input, ready: { ...input.ready, peerUserId: 99 } }),
    ).toThrow();
    const delivered = JSON.stringify({
      kind: "message",
      messageId: 2097152,
      botApiMessageId: 2,
      elapsedMs: 1,
      raw: {
        "@type": "updateNewMessage",
        message: {
          id: 2097152,
          chat_id: 42,
          sender_id: { "@type": "messageSenderUser", user_id: 42 },
          content: { "@type": "messageText", text: { text: wrongText } },
        },
      },
    });
    expect(() =>
      normalizeTelegramCapture({ ...input, raw: `${input.raw}\n${delivered}` }),
    ).toThrow();
  } finally {
    await ingress.close();
    rmSync(root, { recursive: true, force: true });
  }
});
