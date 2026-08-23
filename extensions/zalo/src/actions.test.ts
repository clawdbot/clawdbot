// Zalo tests cover actions plugin behavior.
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zaloMessageActions } from "./actions.js";
import type { OpenClawConfig } from "./runtime-api.js";

describe("zaloMessageActions.describeMessageTool", () => {
  it("honors the selected Zalo account during discovery", () => {
    const cfg: OpenClawConfig = {
      channels: {
        zalo: {
          enabled: true,
          botToken: "root-token",
          accounts: {
            default: {
              enabled: false,
              botToken: "default-token",
            },
            work: {
              enabled: true,
              botToken: "work-token",
            },
          },
        },
      },
    };

    expect(zaloMessageActions.describeMessageTool?.({ cfg, accountId: "default" })).toBeNull();
    expect(zaloMessageActions.describeMessageTool?.({ cfg, accountId: "work" })).toEqual({
      actions: ["send"],
      capabilities: [],
    });
    expect(zaloMessageActions.supportsAction?.({ action: "send" })).toBe(true);
    expect(zaloMessageActions.supportsAction?.({ action: "react" })).toBe(false);
  });

  it("keeps healthy account actions when one account SecretRef is unavailable", () => {
    const cfg = {
      channels: {
        zalo: {
          accounts: {
            broken: {
              botToken: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_TEST_MISSING_ZALO_TOKEN",
              },
            },
            healthy: { botToken: "healthy-token" },
          },
        },
      },
    } as OpenClawConfig;
    expect(zaloMessageActions.describeMessageTool?.({ cfg })).toEqual({
      actions: ["send"],
      capabilities: [],
    });
    expect(zaloMessageActions.describeMessageTool?.({ cfg, accountId: "broken" })).toBeNull();
  });
});

describe("zaloMessageActions.handleAction", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("sends whitespace-only media as text over the real Bot API HTTP transport", async () => {
    const handleAction = zaloMessageActions.handleAction;
    if (!handleAction) {
      throw new Error("Expected Zalo message action handler");
    }

    const requests: Array<{
      method: string | undefined;
      path: string | undefined;
      contentType: string | undefined;
      body: string;
    }> = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({
          method: request.method,
          path: request.url,
          contentType: request.headers["content-type"],
          body,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            result: { message_id: "z-msg-with-blank-media" },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as { port: number };
    vi.stubEnv("ZALO_API_URL", `http://127.0.0.1:${port}/zalo/`);

    try {
      const result = await handleAction({
        channel: "zalo",
        action: "send",
        params: {
          to: "dm-chat-blank-media",
          message: "hello there",
          media: "   ",
        },
        cfg: {
          channels: {
            zalo: {
              enabled: true,
              botToken: "test-zalo-token",
            },
          },
        },
        accountId: "default",
      });

      expect(result.details).toEqual({
        ok: true,
        to: "dm-chat-blank-media",
        messageId: "z-msg-with-blank-media",
      });
      expect(requests).toEqual([
        {
          method: "POST",
          path: "/zalo/bottest-zalo-token/sendMessage",
          contentType: "application/json",
          body: JSON.stringify({
            chat_id: "dm-chat-blank-media",
            text: "hello there",
          }),
        },
      ]);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
