// Discord tests cover REST error redaction behavior.
import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import {
  DiscordError,
  isUnknownDiscordVoiceStateError,
  RateLimitError,
  RequestClient,
} from "./rest.js";

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected request to fail");
}

describe("Discord REST error redaction", () => {
  it("redacts reflected credentials while preserving Discord error metadata", async () => {
    const token = ["MTAxMjM0NTY3ODkwMTIzNDU2", "discord", "credential", "fixture"].join(".");
    const uniqueTokenFragment = "discord.credential";
    const server = await new Promise<Server>((resolve, reject) => {
      const srv = createServer((req, res) => {
        const authorization = req.headers.authorization;
        if (!authorization) {
          res.writeHead(500).end();
          return;
        }
        const isPlainText = req.url?.endsWith("/plain-text") ?? false;
        if (isPlainText) {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end(`Proxy rejected request; Authorization: ${authorization}`);
          return;
        }
        const isSuccess = req.url?.endsWith("/success") ?? false;
        const hasReflectedRateLimitHeaders =
          req.url?.endsWith("/rate-limit-reflected-headers") ?? false;
        const isRateLimit =
          hasReflectedRateLimitHeaders || (req.url?.endsWith("/rate-limit") ?? false);
        const responseBody = isSuccess
          ? { ok: true, safe: "success diagnostic" }
          : isRateLimit
            ? {
                message: `Rate limited; Authorization: ${authorization}`,
                retry_after: 0.25,
                global: false,
                code: 20_028,
              }
            : {
                message: `Voice request rejected; Authorization: ${authorization}`,
                code: 10_065,
                request: {
                  headers: { authorization },
                  numericAuthorization: { authorization: 812_345_678_901_234 },
                  nestedAuthorization: {
                    authorization: { value: authorization, [token]: "rejected token key" },
                  },
                  reflectedKeys: { [`Authorization: ${authorization}`]: "rejected" },
                  url: `https://discord.example/callback?token=${token}`,
                },
                safe: "voice diagnostic",
              };
        res.writeHead(isSuccess ? 200 : isRateLimit ? 429 : 401, {
          "Content-Type": "application/json",
          "X-RateLimit-Bucket": hasReflectedRateLimitHeaders ? authorization : "test-bucket",
          "X-RateLimit-Scope": hasReflectedRateLimitHeaders ? authorization : "user",
        });
        res.end(JSON.stringify(responseBody));
      });
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        srv.off("error", reject);
        resolve(srv);
      });
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind to a TCP port");
      }
      const client = new RequestClient(token, {
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiVersion: 10,
        scheduler: { maxRateLimitRetries: 0 },
      });

      const voiceError = await captureError(client.get("/voice-state"));
      expect(voiceError).toBeInstanceOf(DiscordError);
      const discordError = voiceError as DiscordError;
      const voiceDetails = JSON.stringify({
        message: discordError.message,
        rawBody: discordError.rawBody,
        rawError: discordError.rawError,
      });
      expect(voiceDetails).not.toContain(token);
      expect(voiceDetails).not.toContain(`Bot ${token}`);
      expect(voiceDetails).not.toContain(uniqueTokenFragment);
      expect(voiceDetails).not.toContain("812345678901234");
      expect(voiceDetails).toContain("voice diagnostic");
      expect(discordError.discordCode).toBe(10_065);
      expect(isUnknownDiscordVoiceStateError(discordError)).toBe(true);

      const webhookRateLimitPath = `/webhooks/app/${token}/rate-limit`;
      const rateError = await captureError(client.get(webhookRateLimitPath));
      expect(rateError).toBeInstanceOf(RateLimitError);
      const rateLimitError = rateError as RateLimitError;
      const rateLimitDetails = JSON.stringify({
        message: rateLimitError.message,
        rawBody: rateLimitError.rawBody,
        rawError: rateLimitError.rawError,
      });
      expect(rateLimitDetails).not.toContain(token);
      expect(rateLimitDetails).not.toContain(`Bot ${token}`);
      expect(rateLimitDetails).not.toContain(uniqueTokenFragment);
      expect(rateLimitError.retryAfter).toBe(0.25);
      expect(rateLimitError.discordCode).toBe(20_028);
      expect(rateLimitError.scope).toBe("user");
      expect(rateLimitError.bucket).toMatch(/^sha256:[a-f0-9]{32}$/);

      const bucketCount = client.getSchedulerMetrics().activeBuckets;
      expect(bucketCount).toBeGreaterThan(0);
      const repeatedRateError = await captureError(client.get(webhookRateLimitPath));
      expect(repeatedRateError).toBeInstanceOf(RateLimitError);
      expect((repeatedRateError as RateLimitError).bucket).toBe(rateLimitError.bucket);
      expect(client.getSchedulerMetrics().activeBuckets).toBe(bucketCount);
      expect(JSON.stringify(client.getSchedulerMetrics())).not.toContain(token);

      const reflectedHeaderError = await captureError(client.get("/rate-limit-reflected-headers"));
      expect(reflectedHeaderError).toBeInstanceOf(RateLimitError);
      const reflectedRateLimitError = reflectedHeaderError as RateLimitError;
      const reflectedHeaderDetails = JSON.stringify({
        bucket: reflectedRateLimitError.bucket,
        scope: reflectedRateLimitError.scope,
        scheduler: client.getSchedulerMetrics(),
      });
      expect(reflectedHeaderDetails).not.toContain(token);
      expect(reflectedHeaderDetails).not.toContain(uniqueTokenFragment);
      expect(reflectedRateLimitError.scope).toBeNull();

      const textError = await captureError(client.get("/plain-text"));
      expect(textError).toBeInstanceOf(DiscordError);
      const textDetails = JSON.stringify({
        message: (textError as DiscordError).message,
        rawBody: (textError as DiscordError).rawBody,
        rawError: (textError as DiscordError).rawError,
      });
      expect(textDetails).not.toContain(token);
      expect(textDetails).not.toContain(uniqueTokenFragment);
      expect(textDetails).toContain("Proxy rejected request");

      await expect(client.get("/success")).resolves.toEqual({
        ok: true,
        safe: "success diagnostic",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("bounds recursive Discord error-body redaction", () => {
    const circular: { message: string; self?: unknown } = { message: "safe diagnostic" };
    circular.self = circular;
    const circularError = new DiscordError(new Response(null, { status: 500 }), circular);
    expect((circularError.rawBody as { self?: unknown }).self).toBe("[Circular]");

    const token = "MTAxMjM0NTY3ODkwMTIzNDU2.deeply.nested.credential";
    let nested: unknown = { authorization: token };
    for (let depth = 0; depth < 70; depth += 1) {
      nested = { child: nested };
    }
    const deepError = new DiscordError(new Response(null, { status: 500 }), {
      message: "safe diagnostic",
      nested,
    });
    const deepDetails = JSON.stringify(deepError.rawBody);
    expect(deepDetails).not.toContain(token);
    expect(deepDetails).toContain("[Discord error body redacted: maximum depth exceeded]");
  });

  it("preserves fields whose redacted error keys collide", () => {
    const error = new DiscordError(new Response(null, { status: 500 }), {
      message: "safe diagnostic",
      reflectedKeys: {
        "authorization=alpha-secret-value-123456": "first rejection",
        "authorization=bravo-secret-value-123456": "second rejection",
      },
    });
    const reflectedKeys = (error.rawBody as { reflectedKeys: Record<string, unknown> })
      .reflectedKeys;

    expect(reflectedKeys).toEqual({
      "authorization=***": "first rejection",
      "authorization=*** [2]": "second rejection",
    });
  });

  it("redacts reflected credentials inside Discord validation arrays", () => {
    const token = "MTAxMjM0NTY3ODkwMTIzNDU2.validation.array.credential";
    const error = new DiscordError(new Response(null, { status: 400 }), {
      message: "Invalid Form Body",
      errors: {
        content: {
          _errors: [
            {
              code: "BASE_TYPE_BAD_LENGTH",
              message: `Authorization: Bot ${token}`,
            },
          ],
        },
      },
    });
    const details = JSON.stringify(error.rawBody);

    expect(details).not.toContain(token);
    expect(details).toContain("BASE_TYPE_BAD_LENGTH");
    expect(details).toContain("Invalid Form Body");
  });

  it("redacts low-entropy values solely from their sensitive field key", () => {
    const error = new DiscordError(new Response(null, { status: 400 }), {
      message: "Invalid Form Body",
      authorization: {
        note: "plain fixture",
        attempt: 42,
      },
    });

    expect(error.rawBody).toEqual({
      message: "Invalid Form Body",
      authorization: {
        "***": "***",
        "*** [2]": "***",
      },
    });
  });

  it("ignores empty Discord rate-limit bucket headers", () => {
    const error = new RateLimitError(
      new Response(null, {
        status: 429,
        headers: { "X-RateLimit-Bucket": "" },
      }),
      { message: "Rate limited", retry_after: 1, global: false },
    );

    expect(error.bucket).toBeNull();
  });

  it("marks a priority-only object that exhausts the redaction node budget", () => {
    const marker = "[Discord error body redacted: node limit exceeded]";
    const body = [...Array.from({ length: 9_998 }, () => null), { message: "truncated" }];
    const error = new DiscordError(new Response(null, { status: 500 }), body);
    const redactedBody = error.rawBody as unknown[];

    expect(redactedBody).toHaveLength(9_999);
    expect(redactedBody.at(-1)).toEqual({ [marker]: marker });
  });

  it("bounds wide Discord error-body redaction", () => {
    const fields = Object.fromEntries(
      Array.from({ length: 10_050 }, (_, index) => [`field-${index}`, index]),
    );
    const error = new DiscordError(new Response(null, { status: 500 }), {
      fields,
      message: "wide diagnostic",
      code: 10_065,
    });

    expect(JSON.stringify(error.rawBody)).toContain(
      "[Discord error body redacted: node limit exceeded]",
    );
    expect(error.rawBody).toMatchObject({ message: "wide diagnostic", code: 10_065 });
    expect(error.message).toBe("wide diagnostic");
    expect(error.discordCode).toBe(10_065);
  });
});
