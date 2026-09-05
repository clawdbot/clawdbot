import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { startTelegramProofIngress } from "../../scripts/mantis/telegram-proof-ingress.mts";
import { telegramProofPrompt } from "../../scripts/mantis/telegram-request-proof.ts";
import { createDeferred } from "../helpers/promise.js";

it.each([
  ["invalid-request", false],
  ["rejected-reply", false],
  ["invalid-request", true],
  ["rejected-reply", true],
] as const)("fences buffered reads after %s (active forwarding: %s)", async (fault, withActive) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tg-lifecycle-"));
  const socket =
    process.platform === "win32"
      ? `\\\\.\\pipe\\mantis-${randomUUID()}`
      : path.join(root, "api.sock");
  const forwarded = createDeferred<AbortSignal>();
  const upstreamReply = createDeferred<Response>();
  const admitted = createDeferred();
  let watchAdmission = false;
  let forwardingCount = 0;
  const ingress = await startTelegramProofIngress({
    socket,
    alias: "1:fixture",
    sutToken: "fixture-private-token",
    testerId: "43",
    nonce: "e".repeat(64),
    providerLog: path.join(root, "provider.ndjson"),
    lease: {
      assertHealthy() {
        if (watchAdmission) {
          admitted.resolve();
        }
      },
      whenUnhealthy: new Promise(() => {}),
    },
    fetchImpl: async (_url, options) => {
      forwardingCount++;
      // Consume the real proxy request before waiting on the external service.
      await new Response(options?.body).text();
      forwarded.resolve(options!.signal!);
      return withActive ? upstreamReply.promise : Response.json({ ok: true, result: [] });
    },
  });
  const begin = (requestPath: string, authorization?: string) => {
    const status = createDeferred<number>();
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
        response.on("end", () => status.resolve(response.statusCode ?? 0));
      },
    );
    request.on("error", status.reject);
    return { request, status: status.promise };
  };
  const post = (requestPath: string, body: unknown, authorization?: string) => {
    const pending = begin(requestPath, authorization);
    pending.request.end(JSON.stringify(body));
    return pending.status;
  };
  let buffered: ReturnType<typeof begin> | undefined;
  let active: Promise<number> | undefined;
  try {
    if (fault === "rejected-reply") {
      ingress.armSingleSend();
      expect(
        await post(
          "/provider/v1/chat/completions",
          {
            messages: [{ role: "user", content: telegramProofPrompt("e".repeat(64)) }],
          },
          "Bearer 1:fixture",
        ),
      ).toBe(200);
    }
    let signal: AbortSignal | undefined;
    if (withActive) {
      active = post("/telegram/bot1:fixture/getUpdates", { timeout: 30 });
      signal = await forwarded.promise;
    }
    watchAdmission = true;
    buffered = begin("/telegram/bot1:fixture/getMe");
    buffered.request.write("{");
    await admitted.promise;
    watchAdmission = false;
    expect(
      await post(
        fault === "invalid-request" ? "/outside-scope" : "/telegram/bot1:fixture/sendMessage",
        fault === "invalid-request" ? {} : { chat_id: 43, text: "unexpected candidate reply" },
      ),
    ).toBe(403);
    buffered.request.end("}");
    if (signal) {
      await expect.poll(() => signal.aborted, { timeout: 1000 }).toBe(true);
    }
    upstreamReply.resolve(Response.json({ ok: true, result: [] }));
    expect(await buffered.status).toBe(403);
    if (active) {
      expect(await active).toBe(403);
    }
    expect(forwardingCount).toBe(withActive ? 1 : 0);
    if (fault === "rejected-reply") {
      ingress.assertSingleSendComplete();
      expect(ingress.rejectedReplyCapture()).toBeDefined();
    } else {
      expect(() => ingress.assertHealthy()).toThrow();
    }
  } finally {
    upstreamReply.resolve(Response.json({ ok: true, result: [] }));
    buffered?.request.end("}");
    await Promise.allSettled([buffered?.status, active]);
    await ingress.close();
    rmSync(root, { recursive: true, force: true });
  }
});
