import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeTelegramCapture } from "../../scripts/mantis/telegram-capture.ts";
import { startTelegramProofIngress } from "../../scripts/mantis/telegram-proof-ingress.mts";
import {
  telegramProofIdentitySchema,
  telegramProofDigest,
  telegramProofPrompt,
  telegramProofReply,
  verifyTelegramProofFiles,
} from "../../scripts/mantis/telegram-request-proof.ts";
import { assertCurrentTelegramRequest } from "../../scripts/mantis/telegram-run-admission.ts";

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
const nonce = "e".repeat(64),
  responseNonce = "f".repeat(64);
function capture(reply = telegramProofReply(responseNonce)) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tg-capture-"));
  try {
    execFileSync(
      "python3",
      [
        "test/fixtures/mantis-telegram-recorder.py",
        path.resolve(".agents/skills/telegram-e2e-userbot/scripts/user-record.py"),
        dir,
        telegramProofPrompt(nonce),
        reply,
      ],
      { stdio: "pipe", timeout: 10_000 },
    );
    return {
      identity,
      nonce,
      salt: Buffer.alloc(32, 7),
      sutId: 42,
      testerId: 43,
      testDc: true,
      ready: JSON.parse(readFileSync(path.join(dir, "ready.json"), "utf8")),
      summary: JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8")),
      raw: readFileSync(path.join(dir, "events.ndjson"), "utf8"),
      provider: {
        inputNonce: nonce,
        responseNonce,
        responseSha256: telegramProofDigest(telegramProofReply(responseNonce)),
        count: 1,
      },
      quiescent: true,
      leaseHealthy: true,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const encode = (files: ReturnType<typeof normalizeTelegramCapture>) =>
  Object.fromEntries(
    Object.entries(files).map(([key, value]) => [
      key,
      Buffer.from(JSON.stringify(value)).toString("base64"),
    ]),
  );

describe("canonical Telegram recorder to proof boundary", () => {
  it("derives three private-identity-free records from the actual recorder path", () => {
    const files = normalizeTelegramCapture(capture());
    const verified = verifyTelegramProofFiles(identity, encode(files));
    expect(verified.assertion_outcome).toBe("pass");
    expect(verified.observations.map((item) => item.id)).toEqual([
      "telegram-send",
      "provider-request",
      "telegram-reply",
    ]);
    expect(JSON.stringify(files)).not.toContain("fixture_sut");
    expect(files["provider-request.json"]).not.toHaveProperty("request_sha256");
    for (const value of Object.values(files)) {
      expect(value.transport).toBe("TelegramTestServer");
      expect(value.test_dc).toBe(true);
      expect(value.chat_type).toBe("dm");
      expect(Object.keys(value)).not.toContain("senderId");
    }
    expect(files["telegram-reply.json"].in_reply_to).toBeNull();
  });
  it("only a valid same-context SUT reply mismatch is conclusive fail", () => {
    expect(
      verifyTelegramProofFiles(identity, encode(normalizeTelegramCapture(capture("wrong reply")))),
    ).toMatchObject({ assertion_outcome: "fail" });
  });
  it.each([
    "wrong-peer",
    "not-sut",
    "partial",
    "not-quiescent",
    "lost-lease",
    "provider-nonce",
    "provider-count",
    "cached-before-send",
  ])("rejects %s before export", (fault) => {
    const input = capture();
    if (fault === "wrong-peer") {
      input.ready.peerUserId = 99;
    }
    if (fault === "not-sut") {
      input.raw = input.raw
        .split("\n")
        .map((line) => {
          if (!line) {
            return line;
          }
          const row = JSON.parse(line);
          if (row.raw?.message) {
            row.raw.message.sender_id.user_id = 99;
          }
          return JSON.stringify(row);
        })
        .join("\n");
    }
    if (fault === "partial") {
      input.summary.recordingComplete = false;
    }
    if (fault === "not-quiescent") {
      input.quiescent = false;
    }
    if (fault === "lost-lease") {
      input.leaseHealthy = false;
    }
    if (fault === "provider-nonce") {
      input.provider.inputNonce = "0".repeat(64);
    }
    if (fault === "provider-count") {
      input.provider.count = 2;
    }
    if (fault === "cached-before-send") {
      input.raw = input.raw.trim().split("\n").toReversed().join("\n");
    }
    expect(() => normalizeTelegramCapture(input)).toThrow();
  });
  it.each([
    "request",
    "head",
    "attempt",
    "transport",
    "conversation",
    "send-hash",
    "provider-hash",
    "reply-id",
    "reply-target",
    "non-sut",
    "extra-field",
    "oversize",
  ])("makes %s substitution inconclusive", (fault) => {
    const files: Record<string, Record<string, unknown>> = structuredClone(
      normalizeTelegramCapture(capture()),
    );
    const reply = files["telegram-reply.json"],
      sent = files["telegram-send.json"],
      provider = files["provider-request.json"];
    if (!reply || !sent || !provider) {
      throw new Error("fixture missing");
    }
    if (fault === "request") {
      reply.request_id = "0".repeat(64);
    }
    if (fault === "head") {
      reply.candidate_sha = "0".repeat(40);
    }
    if (fault === "attempt") {
      reply.run_attempt = 2;
    }
    if (fault === "transport") {
      reply.transport = "browser";
    }
    if (fault === "conversation") {
      reply.conversation_digest = "0".repeat(64);
    }
    if (fault === "send-hash") {
      sent.text_sha256 = "0".repeat(64);
    }
    if (fault === "provider-hash") {
      provider.response_sha256 = "0".repeat(64);
    }
    if (fault === "reply-id") {
      reply.message_id = sent.message_id;
    }
    if (fault === "reply-target") {
      reply.in_reply_to = "999";
    }
    if (fault === "non-sut") {
      reply.from_sut = false;
    }
    if (fault === "extra-field") {
      reply.bot_username = "not-public";
    }
    const encoded = Object.fromEntries(
      Object.entries(files).map(([key, value]) => [
        key,
        Buffer.from(JSON.stringify(value)).toString("base64"),
      ]),
    );
    if (fault === "oversize") {
      encoded["telegram-send.json"] = Buffer.alloc(8193).toString("base64");
    }
    expect(() => verifyTelegramProofFiles(identity, encoded)).toThrow();
  });
  it("rejects a Web UI identity relabeled as Telegram", () => {
    expect(() =>
      telegramProofIdentitySchema.parse({
        ...identity,
        workflow: { ...identity.workflow, path: ".github/workflows/mantis-web-ui-chat-proof.yml" },
      }),
    ).toThrow();
  });
});

describe("actual scoped Telegram Test API ingress", () => {
  it("arms exactly one provider-bound reply and rejects every later mutation", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tg-ingress-"));
    const socket = path.join(root, "api.sock");
    const seen: string[] = [];
    const ingress = await startTelegramProofIngress({
      socket,
      alias: "1:fixture",
      sutToken: "fixture-private-token",
      testerId: "43",
      nonce,
      providerLog: path.join(root, "provider.ndjson"),
      lease: { assertHealthy() {}, whenUnhealthy: new Promise(() => {}) },
      fetchImpl: async (url) => {
        seen.push(url instanceof URL ? url.href : typeof url === "string" ? url : url.url);
        return Response.json({
          ok: true,
          result: { message_id: 5, chat: { id: 43, type: "private" } },
        });
      },
    });
    const post = (requestPath: string, body: unknown, authorization?: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
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
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("end", () =>
              resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
            );
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify(body));
      });
    try {
      ingress.armSingleSend();
      expect(
        (await post("/telegram/bot1:fixture/sendChatAction", { chat_id: 43, action: "typing" }))
          .status,
      ).toBe(200);
      expect(seen).toEqual([]);
      const provider = await post(
        "/provider/v1/chat/completions",
        { messages: [{ role: "user", content: telegramProofPrompt(nonce) }] },
        "Bearer 1:fixture",
      );
      const reply = JSON.parse(provider.body).choices[0].message.content;
      expect(
        (
          await post("/telegram/bot1:fixture/sendMessage", {
            chat_id: 43,
            text: reply,
            parse_mode: "HTML",
          })
        ).status,
      ).toBe(200);
      expect(seen).toEqual(["https://api.telegram.org/botfixture-private-token/test/sendMessage"]);
      ingress.assertSingleSendComplete();
      expect(
        (
          await post("/telegram/bot1:fixture/editMessageText", {
            chat_id: 43,
            message_id: 5,
            text: reply,
          })
        ).status,
      ).toBe(403);
      expect(seen).toHaveLength(1);
      expect(() => ingress.assertHealthy()).toThrow();
    } finally {
      await ingress.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when candidate egress starts before controller arming", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tg-ingress-unarmed-"));
    const socket = path.join(root, "api.sock");
    const ingress = await startTelegramProofIngress({
      socket,
      alias: "1:fixture",
      sutToken: "fixture-private-token",
      testerId: "43",
      nonce,
      providerLog: path.join(root, "provider.ndjson"),
      lease: { assertHealthy() {}, whenUnhealthy: new Promise(() => {}) },
      fetchImpl: async () => {
        throw new Error("unarmed egress reached Telegram");
      },
    });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const request = http.request(
          { socketPath: socket, path: "/telegram/bot1:fixture/sendMessage", method: "POST" },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode ?? 0));
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify({ chat_id: 43, text: "early" }));
      });
      expect(status).toBe(403);
      expect(() => ingress.assertHealthy()).toThrow();
    } finally {
      await ingress.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects persistent sendMessage side effects without forwarding them", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tg-ingress-send-side-effect-"));
    const socket = path.join(root, "api.sock");
    let forwarded = false;
    const ingress = await startTelegramProofIngress({
      socket,
      alias: "1:fixture",
      sutToken: "fixture-private-token",
      testerId: "43",
      nonce,
      providerLog: path.join(root, "provider.ndjson"),
      lease: { assertHealthy() {}, whenUnhealthy: new Promise(() => {}) },
      fetchImpl: async () => {
        forwarded = true;
        return Response.json({
          ok: true,
          result: { message_id: 5, chat: { id: 43, type: "private" } },
        });
      },
    });
    const post = (requestPath: string, body: unknown, authorization?: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = http.request(
          {
            socketPath: socket,
            path: requestPath,
            method: "POST",
            headers: authorization ? { authorization } : {},
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("end", () =>
              resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
            );
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify(body));
      });
    try {
      ingress.armSingleSend();
      const provider = await post(
        "/provider/v1/chat/completions",
        { messages: [{ role: "user", content: telegramProofPrompt(nonce) }] },
        "Bearer 1:fixture",
      );
      const reply = JSON.parse(provider.body).choices[0].message.content;
      const attempted = await post("/telegram/bot1:fixture/sendMessage", {
        chat_id: 43,
        text: reply,
        reply_markup: { keyboard: [[{ text: "persist" }]], resize_keyboard: true },
      });
      expect(attempted.status).toBe(403);
      expect(forwarded).toBe(false);
      expect(() => ingress.assertHealthy()).toThrow();
    } finally {
      await ingress.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("synthesizes one non-dropping webhook cleanup without forwarding it", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tg-ingress-webhook-cleanup-"));
    const socket = path.join(root, "api.sock");
    let forwarded = false;
    const ingress = await startTelegramProofIngress({
      socket,
      alias: "1:fixture",
      sutToken: "fixture-private-token",
      testerId: "43",
      nonce,
      providerLog: path.join(root, "provider.ndjson"),
      lease: { assertHealthy() {}, whenUnhealthy: new Promise(() => {}) },
      fetchImpl: async () => {
        forwarded = true;
        return Response.json({ ok: true, result: true });
      },
    });
    const postCleanup = (body: object) =>
      new Promise<number>((resolve, reject) => {
        const request = http.request(
          { socketPath: socket, path: "/telegram/bot1:fixture/deleteWebhook", method: "POST" },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode ?? 0));
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify(body));
      });
    try {
      expect(await postCleanup({ drop_pending_updates: false })).toBe(200);
      expect(forwarded).toBe(false);
      expect(() => ingress.assertHealthy()).not.toThrow();
      expect(await postCleanup({ drop_pending_updates: false })).toBe(403);
      expect(forwarded).toBe(false);
      expect(() => ingress.assertHealthy()).toThrow();
    } finally {
      await ingress.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("synthesizes only the two startup command-menu cleanups without forwarding", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tg-ingress-mutation-"));
    const socket = path.join(root, "api.sock");
    let forwarded = false;
    const ingress = await startTelegramProofIngress({
      socket,
      alias: "1:fixture",
      sutToken: "fixture-private-token",
      testerId: "43",
      nonce,
      providerLog: path.join(root, "provider.ndjson"),
      lease: { assertHealthy() {}, whenUnhealthy: new Promise(() => {}) },
      fetchImpl: async () => {
        forwarded = true;
        return Response.json({ ok: true, result: true });
      },
    });
    const postCleanup = (body: object) =>
      new Promise<number>((resolve, reject) => {
        const request = http.request(
          {
            socketPath: socket,
            path: "/telegram/bot1:fixture/deleteMyCommands",
            method: "POST",
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
      expect(await postCleanup({})).toBe(200);
      expect(await postCleanup({ scope: { type: "all_group_chats" } })).toBe(200);
      expect(forwarded).toBe(false);
      expect(() => ingress.assertHealthy()).not.toThrow();
      expect(await postCleanup({})).toBe(403);
      expect(forwarded).toBe(false);
      expect(() => ingress.assertHealthy()).toThrow();
    } finally {
      await ingress.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Telegram live-send admission", () => {
  const title = `Mantis Telegram request [${identity.request_id}]`;
  const run = {
    id: 2,
    run_attempt: 1,
    event: "workflow_dispatch",
    path: identity.workflow.path,
    head_sha: identity.workflow.sha,
    display_title: title,
    created_at: "2026-09-05T00:00:00Z",
    repository: { id: 1 },
    head_repository: { id: 1 },
  };
  const request = async (options: { staleRead?: number; attempt?: number } = {}) => {
    const subject = telegramProofIdentitySchema.parse({
      ...identity,
      run: { ...identity.run, attempt: options.attempt ?? 1 },
    });
    let pullReads = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url =
        input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
      if (url.pathname.endsWith("/actions/runs/2/attempts/1")) {
        return Response.json(run);
      }
      if (url.pathname.endsWith("/pulls/1")) {
        pullReads += 1;
        return Response.json({
          state: "open",
          head: {
            sha: options.staleRead === pullReads ? "0".repeat(40) : identity.candidate_sha,
            repo: { id: 1 },
          },
        });
      }
      throw new Error(`Unexpected admission URL: ${url}`);
    };
    return assertCurrentTelegramRequest(subject, { token: "test-token", fetchImpl });
  };

  it("binds attempt one and rechecks the exact PR head after awaited admission reads", async () => {
    await expect(request()).resolves.toBeUndefined();
    await expect(request({ staleRead: 1 })).rejects.toThrow(/no longer current/);
    await expect(request({ staleRead: 2 })).rejects.toThrow(/no longer current/);
    await expect(request({ attempt: 2 })).rejects.toThrow(/expected 1/);
  });
});

describe("Telegram cleanup quarantine", () => {
  it("wires uncertain cleanup to an exact-lease broker disable", () => {
    const controller = readFileSync(
      path.resolve("scripts/mantis/run-request-telegram.mts"),
      "utf8",
    );
    const client = readFileSync(
      path.resolve(".agents/skills/telegram-e2e-userbot/scripts/qa-credential-lease.mjs"),
      "utf8",
    );
    const broker = readFileSync(
      path.resolve("qa/convex-credential-broker/convex/credentials.ts"),
      "utf8",
    );
    expect(controller).toContain("acquired.quarantine()");
    expect(client).toContain('callBroker("quarantine", identity, requestOptions)');
    expect(broker).toContain('status: "disabled"');
    expect(broker).toContain('eventType: "quarantine"');
    expect(broker).toContain('query("proof_requests")');
    expect(broker).toContain("quarantineExpiredLease");
    expect(broker).toContain("expiredQuarantinedLease");
    expect(controller).toContain("quarantineOnExpiry: true");
    expect(controller).toContain("requestId: identity.request_id");
  });
});
