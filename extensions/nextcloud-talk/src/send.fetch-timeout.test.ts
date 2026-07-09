import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { sendMessageNextcloudTalk, sendReactionNextcloudTalk } from "./send.js";
import type { CoreConfig } from "./types.js";

const REQUEST_TIMEOUT_MS = 50;

function createTalkConfig(baseUrl: string): CoreConfig {
  return {
    channels: {
      "nextcloud-talk": {
        baseUrl,
        botSecret: "test-secret",
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
