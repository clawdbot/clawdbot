// Mattermost tests cover the action-to-REST send path over loopback.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { mattermostPlugin } from "./channel.js";
import { deliverMattermostReplyPayload } from "./mattermost/reply-delivery.js";
import { sendMessageMattermost } from "./mattermost/send.js";
import { setMattermostRuntime } from "./runtime.js";

const CHANNEL_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const loadOutboundMediaFromUrl = vi.hoisted(() => vi.fn());

vi.mock("./mattermost/runtime-api.js", async () => ({
  ...(await vi.importActual<typeof import("./mattermost/runtime-api.js")>(
    "./mattermost/runtime-api.js",
  )),
  loadOutboundMediaFromUrl,
}));

async function sendPreparedMattermostLoopback(params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
}) {
  const to = typeof params.actionParams.to === "string" ? params.actionParams.to.trim() : "";
  const text = typeof params.actionParams.message === "string" ? params.actionParams.message : "";
  const prepareSendPayload = mattermostPlugin.actions?.prepareSendPayload;
  const sendPayload = mattermostPlugin.outbound?.sendPayload;
  if (!to || !prepareSendPayload || !sendPayload) {
    throw new Error("Mattermost prepared outbound send surface missing");
  }
  const payload = await prepareSendPayload({
    ctx: {
      channel: "mattermost",
      action: "send",
      params: params.actionParams,
      cfg: params.cfg,
      accountId: "default",
    },
    to,
    payload: { text },
  });
  if (!payload) {
    throw new Error("Mattermost send preparation declined");
  }
  return await sendPayload({
    cfg: params.cfg,
    to,
    text,
    payload,
    accountId: "default",
  });
}

describe("Mattermost send action loopback", () => {
  it("reuses the inbound provider channel when delivering a direct reply", async () => {
    const requests: Array<{ path: string; body?: unknown }> = [];

    await withServer(
      (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          const path = request.url ?? "";
          requests.push({ path, ...(body ? { body: JSON.parse(body) as unknown } : {}) });
          response.writeHead(201, { "content-type": "application/json" });
          if (path === "/api/v4/users/me") {
            response.end(JSON.stringify({ id: "cccccccccccccccccccccccccc" }));
            return;
          }
          if (path === "/api/v4/channels/direct") {
            response.end(JSON.stringify({ id: CHANNEL_ID }));
            return;
          }
          response.end(
            JSON.stringify({
              id: "post-loopback",
              channel_id: CHANNEL_ID,
              message: "prepared direct reply",
            }),
          );
        });
      },
      async (baseUrl) => {
        const core = createPluginRuntimeMock();
        setMattermostRuntime(core);
        const cfg = {
          channels: {
            mattermost: {
              botToken: "prepared-inbound-loopback",
              baseUrl,
              network: { dangerouslyAllowPrivateNetwork: true },
            },
          },
        } as OpenClawConfig;

        const result = await deliverMattermostReplyPayload({
          core,
          cfg,
          payload: { text: "prepared direct reply" },
          channelId: CHANNEL_ID,
          accountId: "default",
          textLimit: 4000,
          tableMode: "off",
          sendMessage: sendMessageMattermost,
        });

        expect(result).toMatchObject({
          outcome: "text",
          messageIds: ["post-loopback"],
          visibleReplySent: true,
        });
        expect(requests).toEqual([
          {
            path: "/api/v4/posts",
            body: { channel_id: CHANNEL_ID, message: "prepared direct reply" },
          },
        ]);
      },
    );
  });

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
        const result = await sendPreparedMattermostLoopback({
          cfg,
          actionParams: {
            to: `channel:${CHANNEL_ID}`,
            message: "loopback proof",
            buffer: "",
            base64: "  ",
          },
        });

        expect(result).toMatchObject({
          channel: "mattermost",
          messageId: "post-loopback",
          target: { kind: "channel", id: CHANNEL_ID },
        });
        expect(requests).toEqual([
          {
            path: "/api/v4/posts",
            body: { channel_id: CHANNEL_ID, message: "loopback proof" },
          },
        ]);

        await expect(
          sendPreparedMattermostLoopback({
            cfg,
            actionParams: {
              to: `channel:${CHANNEL_ID}`,
              message: "must not send",
              base64: "cmVwb3J0",
            },
          }),
        ).rejects.toThrow("buffer/base64 payloads are not supported");
        expect(requests).toHaveLength(1);
      },
    );
  });

  it("infers a MIME extension for unnamed uploads", async () => {
    const uploads: string[] = [];

    await withServer(
      (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          if (request.url === "/api/v4/files") {
            uploads.push(body);
            response.writeHead(201, { "content-type": "application/json" });
            response.end(JSON.stringify({ file_infos: [{ id: `file-${uploads.length}` }] }));
            return;
          }
          response.writeHead(201, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "post-loopback", channel_id: CHANNEL_ID }));
        });
      },
      async (baseUrl) => {
        setMattermostRuntime(createPluginRuntimeMock());
        loadOutboundMediaFromUrl.mockReset();
        loadOutboundMediaFromUrl.mockResolvedValueOnce({
          buffer: Buffer.from("!unnamed-image?").subarray(1, -1),
          contentType: "image/png",
          kind: "image",
        });
        const cfg = {
          channels: {
            mattermost: {
              botToken: "loopback-fixture",
              baseUrl,
              network: { dangerouslyAllowPrivateNetwork: true },
            },
          },
        } as OpenClawConfig;
        await sendPreparedMattermostLoopback({
          cfg,
          actionParams: {
            to: `channel:${CHANNEL_ID}`,
            message: "loopback media proof",
            mediaUrl: "https://media.example.test/unnamed",
          },
        });
      },
    );

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toContain('filename="upload.png"');
    expect(uploads[0]).toContain("Content-Type: image/png");
    expect(uploads[0]).toContain("\r\n\r\nunnamed-image\r\n");
  });
});
