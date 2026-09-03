import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { probeNextcloudTalkBotResponseFeature } from "./bot-preflight.js";
import { sendMessageNextcloudTalk, sendReactionNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

const REQUEST_TIMEOUT_MS = 50;

function createTalkConfig(baseUrl: string): CoreConfig {
  return {
    channels: {
      "nextcloud-talk": {
        baseUrl,
        botSecret: "test-secret",
        apiUser: "test-admin",
        apiPassword: "test-password",
        webhookPublicUrl: "https://bot.example.test/hook",
        network: { dangerouslyAllowPrivateNetwork: true },
      },
    },
  };
}

async function expectHangingTalkRequestTimesOut(params: {
  path: string;
  run: (baseUrl: string) => Promise<unknown>;
}): Promise<void> {
  let received = false;
  await withServer(
    (request) => {
      received = true;
      expect(request.method).toBe("POST");
      expect(request.url).toBe(params.path);
      request.resume();
    },
    async (baseUrl) => {
      let thrown: unknown;
      try {
        await params.run(baseUrl);
      } catch (error) {
        thrown = error;
      }

      expect(received).toBe(true);
      if (!(thrown instanceof Error)) {
        throw new Error(`expected request timeout, received ${String(thrown)}`);
      }
      expect(["AbortError", "TimeoutError"]).toContain(thrown.name);
    },
  );
}

describe("nextcloud-talk send error responses", () => {
  it.each(["message", "reaction", "preflight"])(
    "redacts reflected credentials and drops incomplete %s error bodies",
    async (operation) => {
      for (const mode of ["complete", "display-boundary", "oversized", "stalled"]) {
        let credential = "";
        await withServer(
          (request, response) => {
            request.resume();
            credential = String(
              request.headers["x-nextcloud-talk-bot-signature"] ??
                request.headers.authorization?.replace(/^Basic /, ""),
            );
            expect(credential).not.toBe("undefined");
            response.writeHead(500, { "content-type": "text/plain" });
            // Put a secret across the read cap: exposing a prefix defeats exact redaction.
            const body =
              mode === "oversized"
                ? `${"x".repeat(8192 - 16)}${credential}`
                : `upstream rejected ${mode === "display-boundary" ? "x".repeat(160) : ""}${credential}; password=fixture-private-value${
                    request.headers.authorization ? "; decoded test-password" : ""
                  }`;
            if (mode === "stalled") {
              response.write(body);
            } else {
              response.end(body);
            }
          },
          async (baseUrl) => {
            const cfg = createTalkConfig(baseUrl);
            const result =
              operation === "preflight"
                ? await probeNextcloudTalkBotResponseFeature({
                    account: resolveNextcloudTalkAccount({ cfg }),
                  })
                : await (
                    operation === "message"
                      ? sendMessageNextcloudTalk("room:abc123", "hello", { cfg })
                      : sendReactionNextcloudTalk("room:abc123", "m-1", "ok", { cfg })
                  ).catch((error: unknown) => error);
            const message =
              typeof result === "object" && result !== null && "message" in result
                ? result.message
                : undefined;
            expect(message).toBeTypeOf("string");
            expect(message).not.toContain(credential);
            expect(message).not.toContain(credential.slice(0, 16));
            expect(message).not.toContain("fixture-private-value");
            expect(message).not.toContain("test-password");
            if (mode === "oversized" || mode === "stalled") {
              expect(message).not.toContain("xxxxxxxx");
              expect(message).not.toContain("upstream rejected");
              expect(message).toContain("500");
            } else {
              expect(message).toContain("upstream rejected");
              expect(message).toContain("***");
            }
          },
        );
      }
    },
    15_000,
  );

  it("keeps send error body snippets UTF-16 safe", async () => {
    const prefix = "e".repeat(199);
    const errorBody = `${prefix}\u{1F600}tail`;

    await withServer(
      (request, response) => {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/ocs/v2.php/apps/spreed/api/v1/bot/abc123/message");
        request.resume();
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end(errorBody);
      },
      async (baseUrl) => {
        await expect(
          sendMessageNextcloudTalk("room:abc123", "hello", {
            cfg: createTalkConfig(baseUrl),
          }),
        ).rejects.toThrow(new Error(`Nextcloud Talk: bad request - ${prefix}…`));
      },
    );
  });
});

describe("nextcloud-talk send fetch timeouts", () => {
  it("bounds hanging message and reaction sends", async () => {
    await expectHangingTalkRequestTimesOut({
      path: "/ocs/v2.php/apps/spreed/api/v1/bot/abc123/message",
      run: async (baseUrl) =>
        sendMessageNextcloudTalk("room:abc123", "hello", {
          cfg: createTalkConfig(baseUrl),
          timeoutMs: REQUEST_TIMEOUT_MS,
        }),
    });
    await expectHangingTalkRequestTimesOut({
      path: "/ocs/v2.php/apps/spreed/api/v1/bot/abc123/reaction/m-1",
      run: async (baseUrl) =>
        sendReactionNextcloudTalk("room:abc123", "m-1", "ok", {
          cfg: createTalkConfig(baseUrl),
          timeoutMs: REQUEST_TIMEOUT_MS,
        }),
    });
  });
});
