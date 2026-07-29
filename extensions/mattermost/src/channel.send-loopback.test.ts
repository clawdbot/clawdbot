// Mattermost tests cover the action-to-REST send path over loopback.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { mattermostPlugin } from "./channel.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { setMattermostRuntime } from "./runtime.js";

const CHANNEL_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("Mattermost send action loopback", () => {
  it("sends text with blank attachment placeholders and rejects nonblank payloads", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];

    await withServer(
      (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          requests.push({
            path: request.url ?? "",
            body: JSON.parse(body) as unknown,
          });
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "post-loopback", channel_id: CHANNEL_ID }));
        });
      },
      async (baseUrl) => {
        setMattermostRuntime(createPluginRuntimeMock());
        const cfg = {
          channels: {
            mattermost: {
              botToken: ["loopback", "fixture"].join("-"),
              baseUrl,
              network: { dangerouslyAllowPrivateNetwork: true },
            },
          },
        } as OpenClawConfig;
        const handleAction = mattermostPlugin.actions?.handleAction;
        if (!handleAction) {
          throw new Error("Mattermost send action missing");
        }

        const result = await handleAction({
          channel: "mattermost",
          action: "send",
          params: {
            to: `channel:${CHANNEL_ID}`,
            message: "loopback proof",
            buffer: "",
            base64: "  ",
          },
          cfg,
          accountId: "default",
        });

        expect(result.content).toEqual([
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              channel: "mattermost",
              messageId: "post-loopback",
              channelId: CHANNEL_ID,
            }),
          },
        ]);
        expect(requests).toEqual([
          {
            path: "/api/v4/posts",
            body: { channel_id: CHANNEL_ID, message: "loopback proof" },
          },
        ]);

        await expect(
          handleAction({
            channel: "mattermost",
            action: "send",
            params: {
              to: `channel:${CHANNEL_ID}`,
              message: "must not send",
              base64: "cmVwb3J0",
            },
            cfg,
            accountId: "default",
          }),
        ).rejects.toThrow("buffer/base64 payloads are not supported");
        expect(requests).toHaveLength(1);
      },
    );
  });
});
