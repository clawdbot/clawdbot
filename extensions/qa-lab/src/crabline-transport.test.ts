// Qa Lab tests cover Crabline local-provider transport integration behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawCrablineChannelDriverSelection } from "@openclaw/crabline";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";

function createSelection(channel: OpenClawCrablineChannelDriverSelection["channel"] = "telegram") {
  return {
    capabilityMatrixPath: "crabline-fake-provider-capabilities.json",
    channel,
    channelDriver: "crabline",
    smokeArtifactPath: "crabline-fake-provider-smoke.json",
  } as const;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

describe("crabline transport", () => {
  it("configures OpenClaw's Telegram plugin against a Crabline local provider server", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection(),
        state: createQaBusState(),
      });

      try {
        expect(transport.id).toBe("crabline");
        expect(transport.requiredPluginIds).toEqual(["telegram"]);
        expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" })).toMatchObject({
          channels: {
            telegram: {
              apiRoot: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
              botToken: "424242:crabline-telegram-token",
              dmPolicy: "open",
              enabled: true,
              groupPolicy: "open",
            },
          },
        });
        const delivery = transport.buildAgentDelivery({ target: "dm:alice" });
        expect(delivery).toMatchObject({
          channel: "telegram",
          replyChannel: "telegram",
          replyTo: expect.stringMatching(/^[1-9]\d+$/u),
          to: expect.stringMatching(/^[1-9]\d+$/u),
        });
        expect(delivery.replyTo).toBe(delivery.to);

        await expect(
          fs.access(path.join(outputDir, "crabline-fake-provider-server.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          transport.sendInbound({
            conversation: { id: "-1001234567890", kind: "group" },
            senderId: "100001",
            senderName: "Alice",
            text: "Telegram baseline marker check.",
          }),
        ).resolves.toMatchObject({
          id: expect.stringMatching(/^\d+$/u),
          text: "Telegram baseline marker check.",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("configures distinct Telegram actors for canonical sender allowlist flows", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        transportPolicy: {
          requireGroupMention: true,
          senderAllowlist: ["driver"],
        },
        selection: createSelection(),
        state: createQaBusState(),
      });

      try {
        expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" })).toMatchObject({
          channels: {
            telegram: {
              allowFrom: ["100001"],
              groupAllowFrom: ["100001"],
              groupPolicy: "allowlist",
            },
          },
        });
        await transport.state.addInboundMessage({
          conversation: { id: "qa-routing-ordering", kind: "group" },
          senderId: "observer",
          text: "observer",
        });
        await transport.state.addInboundMessage({
          conversation: { id: "qa-routing-ordering", kind: "group" },
          senderId: "driver",
          text: "driver",
        });

        const config = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" });
        const telegram = config.channels?.telegram as
          | { apiRoot?: string; botToken?: string }
          | undefined;
        const apiRoot = requireString(telegram?.apiRoot, "Telegram API root");
        const botToken = requireString(telegram?.botToken, "Telegram bot token");
        const response = await fetch(`${apiRoot}/bot${botToken}/getUpdates`);
        const payload = (await response.json()) as {
          result?: Array<{ message?: { from?: { id?: number }; text?: string } }>;
        };
        expect(payload.result?.map((update) => update.message?.from?.id)).toEqual([100002, 100001]);
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("rejects canonical sender-policy flows on non-Telegram Crabline bridges", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      await expect(
        createQaCrablineTransportAdapter({
          outputDir,
          transportPolicy: { senderAllowlist: ["driver"] },
          selection: createSelection("matrix"),
          state: createQaBusState(),
        }),
      ).rejects.toThrow("Crabline matrix does not support the requested group transport policy");
    });
  });

  it("injects Telegram native commands through the shared transport adapter", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection(),
        state: createQaBusState(),
      });

      try {
        expect(transport.sendNativeCommand).toBeTypeOf("function");
        await transport.sendNativeCommand?.({
          command: "stop",
          conversation: { id: "alice", kind: "direct" },
          senderId: "alice",
          senderName: "Alice",
        });

        const config = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" });
        const telegram = config.channels?.telegram as
          | { apiRoot?: string; botToken?: string }
          | undefined;
        const apiRoot = requireString(telegram?.apiRoot, "Telegram API root");
        const botToken = requireString(telegram?.botToken, "Telegram bot token");
        const response = await fetch(`${apiRoot}/bot${botToken}/getUpdates`);
        await expect(response.json()).resolves.toMatchObject({
          result: [
            {
              message: {
                entities: [{ length: 5, offset: 0, type: "bot_command" }],
                text: "/stop",
              },
            },
          ],
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("observes Telegram preview edits through the shared transport adapter", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection(),
        state: createQaBusState(),
      });

      try {
        const config = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" });
        const telegram = config.channels?.telegram as
          | { apiRoot?: string; botToken?: string }
          | undefined;
        const apiRoot = requireString(telegram?.apiRoot, "Telegram API root");
        const botToken = requireString(telegram?.botToken, "Telegram bot token");
        const postTelegram = async (method: string, body: Record<string, unknown>) => {
          const response = await fetch(`${apiRoot}/bot${botToken}/${method}`, {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
            method: "POST",
          });
          expect(response.ok).toBe(true);
          return (await response.json()) as { result: { message_id: number } };
        };
        const sent = await postTelegram("sendMessage", {
          chat_id: "-1001234567890",
          message_thread_id: 42,
          text: "preview text",
        });
        expect(transport.state.searchMessages({ query: "preview text" })).toEqual([
          expect.objectContaining({ text: "preview text" }),
        ]);
        await postTelegram("editMessageText", {
          chat_id: "-1001234567890",
          message_id: sent.result.message_id,
          text: "final marker",
        });

        expect(transport.waitForOutboundSequence).toBeTypeOf("function");
        await expect(
          transport.waitForOutboundSequence!({
            conversationId: "-1001234567890",
            finalSettleMs: 0,
            finalTextIncludes: "final marker",
            minimumPreviewEvents: 1,
            threadId: "42",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          events: [{ kind: "sent" }, { kind: "edited" }],
          final: { text: "final marker", threadId: "42" },
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("configures OpenClaw's Slack plugin against a Crabline local provider server", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("slack"),
        state: createQaBusState(),
      });

      try {
        expect(transport.id).toBe("crabline");
        expect(transport.requiredPluginIds).toEqual(["slack"]);
        expect(transport.sendNativeCommand).toBeUndefined();
        expect(transport.waitForOutboundSequence).toBeUndefined();
        expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" })).toMatchObject({
          channels: {
            slack: {
              botToken: "xoxb-crabline-slack-token",
              enabled: true,
              mode: "http",
              signingSecret: "crabline-slack-signing-secret",
            },
          },
        });
        expect(transport.createRuntimeEnvPatch?.()).toMatchObject({
          SLACK_API_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/api\/$/u),
          SLACK_BOT_TOKEN: "xoxb-crabline-slack-token",
          SLACK_SIGNING_SECRET: "crabline-slack-signing-secret",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("injects inbound messages through Crabline and mirrors Slack sends into normalized state", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("slack"),
        state: createQaBusState(),
      });

      try {
        const inbound = await transport.sendInbound({
          conversation: {
            id: "D12345678",
            kind: "direct",
          },
          senderId: "U12345678",
          senderName: "Alice",
          text: "Slack baseline marker check.",
        });
        expect(inbound.id).toMatch(/^\d+\.\d+$/u);

        const env = transport.createRuntimeEnvPatch?.() ?? {};
        expect(env.SLACK_API_URL).toBeTruthy();
        expect(env.SLACK_BOT_TOKEN).toBeTruthy();
        const { response, release } = await fetchWithSsrFGuard({
          url: `${env.SLACK_API_URL}chat.postMessage`,
          init: {
            body: JSON.stringify({
              channel: "D12345678",
              text: "assistant via fake slack",
            }),
            headers: {
              authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
              "content-type": "application/json",
            },
            method: "POST",
          },
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-crabline-slack-transport-test",
        });
        await release();
        expect(response.ok).toBe(true);

        await expect(
          transport.waitForOutbound({
            conversation: { id: "D12345678", kind: "direct" },
            textIncludes: "assistant via fake slack",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: { id: "D12345678", kind: "direct" },
          text: "assistant via fake slack",
        });

        await expect(
          transport.state.waitFor({
            direction: "outbound",
            kind: "message-text",
            textIncludes: "assistant via fake slack",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: {
            id: "D12345678",
            kind: "direct",
          },
          direction: "outbound",
          text: "assistant via fake slack",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("configures OpenClaw's WhatsApp plugin against a Crabline Baileys WebSocket server", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("whatsapp"),
        state: createQaBusState(),
      });

      try {
        expect(transport.id).toBe("crabline");
        expect(transport.requiredPluginIds).toEqual(["whatsapp"]);
        expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" })).toMatchObject({
          channels: {
            whatsapp: {
              allowFrom: ["*"],
              dmPolicy: "open",
              enabled: true,
              groupAllowFrom: ["*"],
              groupPolicy: "open",
            },
          },
        });
        expect(transport.buildAgentDelivery({ target: "15551234567@s.whatsapp.net" })).toEqual({
          channel: "whatsapp",
          to: "15551234567@s.whatsapp.net",
          replyChannel: "whatsapp",
          replyTo: "15551234567@s.whatsapp.net",
        });
        const env = transport.createRuntimeEnvPatch?.() ?? {};
        expect(env).toMatchObject({
          CRABLINE_WHATSAPP_ADMIN_TOKEN: expect.any(String),
          CRABLINE_WHATSAPP_RECORDER_PATH: expect.stringMatching(/whatsapp-fake-provider\.jsonl$/u),
          CRABLINE_WHATSAPP_SELF_JID: "15550000000@s.whatsapp.net",
          OPENCLAW_WHATSAPP_WEB_SOCKET_URL: expect.stringMatching(
            /^ws:\/\/127\.0\.0\.1:\d+\/ws\/chat\?access_token=/u,
          ),
        });
        expect(env.CRABLINE_WHATSAPP_ACCESS_TOKEN).toBeUndefined();
        expect(env.CRABLINE_WHATSAPP_API_ROOT).toBeUndefined();
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("injects WhatsApp inbound messages through Crabline into normalized state", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("whatsapp"),
        state: createQaBusState(),
      });

      try {
        const message = await transport.state.addInboundMessage({
          conversation: {
            id: "15557654321@s.whatsapp.net",
            kind: "direct",
          },
          senderId: "15557654321@s.whatsapp.net",
          senderName: "Alice",
          text: "WhatsApp baseline marker check.",
        });
        expect(message).toMatchObject({
          conversation: {
            id: "15557654321@s.whatsapp.net",
            kind: "direct",
          },
          direction: "inbound",
          senderId: "15557654321@s.whatsapp.net",
          text: "WhatsApp baseline marker check.",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("binds Signal config and normalizes transport targets", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("signal"),
        state: createQaBusState(),
      });

      try {
        expect(transport.requiredPluginIds).toEqual(["signal"]);
        expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" })).toMatchObject({
          channels: {
            signal: {
              account: "+15550000000",
              apiMode: "native",
              autoStart: false,
              enabled: true,
              httpUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
            },
          },
        });
        expect(transport.createRuntimeEnvPatch?.()).toEqual({});
        const delivery = transport.buildAgentDelivery({ target: "dm:alice" });
        expect(delivery).toMatchObject({
          channel: "signal",
          replyChannel: "signal",
          replyTo: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
          ),
          to: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
          ),
        });
        expect(delivery.replyTo).toBe(delivery.to);

        await expect(
          transport.state.addInboundMessage({
            conversation: { id: "alice", kind: "direct" },
            senderId: "alice",
            senderName: "Alice",
            text: "Signal baseline marker check.",
          }),
        ).resolves.toMatchObject({
          conversation: { id: "alice", kind: "direct" },
          direction: "inbound",
          senderId: "alice",
          text: "Signal baseline marker check.",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("normalizes native Signal JSON-RPC sends into outbound state", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("signal"),
        state: createQaBusState(),
      });

      try {
        const delivery = transport.buildAgentDelivery({ target: "dm:alice" });
        const config = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" });
        const signal = config.channels?.signal as { httpUrl?: string } | undefined;
        const signalBaseUrl = requireString(signal?.httpUrl, "Signal HTTP URL");
        const { response, release } = await fetchWithSsrFGuard({
          url: `${signalBaseUrl}/api/v1/rpc`,
          init: {
            body: JSON.stringify({
              id: "qa-signal-send",
              jsonrpc: "2.0",
              method: "send",
              params: {
                message: "assistant via fake signal",
                recipient: [delivery.to],
              },
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-crabline-signal-transport-test",
        });
        await release();
        expect(response.ok).toBe(true);

        await expect(
          transport.waitForOutbound({
            conversation: { id: "alice", kind: "direct" },
            textIncludes: "assistant via fake signal",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: { id: "alice", kind: "direct" },
          text: "assistant via fake signal",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("binds Mattermost config and normalizes transport targets", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("mattermost"),
        state: createQaBusState(),
      });

      try {
        expect(transport.requiredPluginIds).toEqual(["mattermost"]);
        const mattermostGatewayConfig = transport.createGatewayConfig({
          baseUrl: "http://127.0.0.1:1",
        }) as { channels?: { mattermost?: Record<string, unknown> } };
        expect(mattermostGatewayConfig).toMatchObject({
          channels: {
            mattermost: {
              baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
              botToken: "crabline-mattermost-token",
              enabled: true,
              network: { dangerouslyAllowPrivateNetwork: true },
            },
          },
        });
        expect(transport.createRuntimeEnvPatch?.()).toMatchObject({
          MATTERMOST_BOT_TOKEN: "crabline-mattermost-token",
          MATTERMOST_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
        });
        expect(transport.buildAgentDelivery({ target: "group:qa-channel" })).toMatchObject({
          channel: "mattermost",
          replyChannel: "mattermost",
          replyTo: expect.stringMatching(/^channel:[a-z0-9]{26}$/u),
          to: expect.stringMatching(/^channel:[a-z0-9]{26}$/u),
        });
        expect(mattermostGatewayConfig.channels?.mattermost?.streaming).toEqual({ mode: "off" });

        await expect(
          transport.state.addInboundMessage({
            conversation: { id: "qa-channel", kind: "group" },
            senderId: "alice",
            senderName: "Alice",
            text: "Mattermost baseline marker check.",
          }),
        ).resolves.toMatchObject({
          conversation: { id: "qa-channel", kind: "group" },
          direction: "inbound",
          senderId: "alice",
          text: "Mattermost baseline marker check.",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("normalizes native Mattermost post creation into outbound state", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("mattermost"),
        state: createQaBusState(),
      });

      try {
        await transport.state.addInboundMessage({
          conversation: { id: "qa-channel", kind: "group" },
          senderId: "alice",
          senderName: "Alice",
          text: "Mattermost baseline marker check.",
        });
        const delivery = transport.buildAgentDelivery({ target: "group:qa-channel" });
        const env = transport.createRuntimeEnvPatch?.() ?? {};
        const mattermostUrl = requireString(env.MATTERMOST_URL, "Mattermost URL");
        const botToken = requireString(env.MATTERMOST_BOT_TOKEN, "Mattermost bot token");
        const { response, release } = await fetchWithSsrFGuard({
          url: `${mattermostUrl}/api/v4/posts`,
          init: {
            body: JSON.stringify({
              channel_id: delivery.to.replace(/^channel:/u, ""),
              message: "assistant via fake mattermost",
            }),
            headers: {
              authorization: `Bearer ${botToken}`,
              "content-type": "application/json",
            },
            method: "POST",
          },
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-crabline-mattermost-transport-test",
        });
        await release();
        expect(response.ok).toBe(true);

        await expect(
          transport.waitForOutbound({
            conversation: { id: "qa-channel", kind: "group" },
            textIncludes: "assistant via fake mattermost",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: { id: "qa-channel", kind: "group" },
          text: "assistant via fake mattermost",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("binds Matrix config and normalizes transport targets", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("matrix"),
        state: createQaBusState(),
      });

      try {
        expect(transport.requiredPluginIds).toEqual(["matrix"]);
        const matrixGatewayConfig = transport.createGatewayConfig({
          baseUrl: "http://127.0.0.1:1",
        }) as { channels?: { matrix?: Record<string, unknown> } };
        expect(matrixGatewayConfig).toMatchObject({
          channels: {
            matrix: {
              accessToken: expect.any(String),
              enabled: true,
              encryption: false,
              homeserver: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
              network: { dangerouslyAllowPrivateNetwork: true },
              userId: "@openclaw:matrix.test",
            },
          },
        });
        expect(matrixGatewayConfig.channels?.matrix?.streaming).toEqual({
          mode: "off",
          block: { enabled: false },
        });
        expect(matrixGatewayConfig.channels?.matrix?.blockStreaming).toBeUndefined();
        expect(transport.createRuntimeEnvPatch?.()).toMatchObject({
          MATRIX_ACCESS_TOKEN: expect.any(String),
          MATRIX_BASE_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
          MATRIX_USER_ID: "@openclaw:matrix.test",
        });

        const roomId = "main";
        const delivery = transport.buildAgentDelivery({ target: `group:${roomId}` });
        expect(delivery).toEqual({
          channel: "matrix",
          replyChannel: "matrix",
          replyTo: expect.stringMatching(/^room:![a-f0-9]{16}:matrix-qa\.test$/u),
          to: expect.stringMatching(/^room:![a-f0-9]{16}:matrix-qa\.test$/u),
        });
        expect(transport.buildAgentDelivery({ target: "!qa:matrix.test" })).toEqual({
          channel: "matrix",
          replyChannel: "matrix",
          replyTo: "room:!qa:matrix.test",
          to: "room:!qa:matrix.test",
        });
        expect(transport.buildAgentDelivery({ target: "matrix:room:!qa:matrix.test" })).toEqual({
          channel: "matrix",
          replyChannel: "matrix",
          replyTo: "room:!qa:matrix.test",
          to: "room:!qa:matrix.test",
        });
        expect(() => transport.buildAgentDelivery({ target: "group:" })).toThrow(
          "Matrix QA conversation id must be non-empty",
        );
        expect(() => transport.buildAgentDelivery({ target: "thread:/v1/main/%24event" })).toThrow(
          "Matrix thread targets require OpenClaw QA thread forwarding",
        );
        await expect(
          transport.state.addInboundMessage({
            conversation: { id: "  ", kind: "group" },
            senderId: "driver",
            senderName: "Alice",
            text: "Matrix invalid blank room.",
          }),
        ).rejects.toThrow("Matrix QA conversation id must be non-empty");
        await expect(
          transport.state.addInboundMessage({
            conversation: { id: roomId, kind: "group" },
            senderId: "driver",
            senderName: "Alice",
            text: "Matrix baseline marker check.",
          }),
        ).resolves.toMatchObject({
          conversation: { id: roomId, kind: "group" },
          direction: "inbound",
          id: expect.stringMatching(/^\$[a-f0-9]{16}:matrix\.test$/u),
          senderId: "driver",
          text: "Matrix baseline marker check.",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("normalizes native Matrix room message sends into outbound state", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("matrix"),
        state: createQaBusState(),
      });

      try {
        const roomId = "main";
        await transport.state.addInboundMessage({
          conversation: { id: roomId, kind: "group" },
          senderId: "driver",
          senderName: "Alice",
          text: "Provision Matrix room.",
        });
        await transport.state.reset();
        const delivery = transport.buildAgentDelivery({ target: `group:${roomId}` });
        const providerRoomId = delivery.to.replace(/^room:/u, "");
        const env = transport.createRuntimeEnvPatch?.() ?? {};
        const matrixBaseUrl = requireString(env.MATRIX_BASE_URL, "Matrix base URL");
        const accessToken = requireString(env.MATRIX_ACCESS_TOKEN, "Matrix access token");
        const { response, release } = await fetchWithSsrFGuard({
          url: `${matrixBaseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(providerRoomId)}/send/m.room.message/qa-matrix-send`,
          init: {
            body: JSON.stringify({ body: "assistant via fake matrix", msgtype: "m.text" }),
            headers: {
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
            },
            method: "PUT",
          },
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-crabline-matrix-transport-test",
        });
        await release();
        expect(response.ok).toBe(true);

        await expect(
          transport.waitForOutbound({
            conversation: { id: roomId, kind: "group" },
            textIncludes: "assistant via fake matrix",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: { id: roomId, kind: "group" },
          text: "assistant via fake matrix",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("configures Zalo and normalizes native message sends", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection("zalo"),
        state: createQaBusState(),
      });

      try {
        expect(transport.requiredPluginIds).toEqual(["zalo"]);
        expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" })).toMatchObject({
          channels: {
            zalo: {
              allowFrom: ["*"],
              botToken: "crabline-zalo-bot-token",
              dmPolicy: "open",
              enabled: true,
              groupAllowFrom: ["*"],
              groupPolicy: "open",
            },
          },
        });
        expect(transport.createRuntimeEnvPatch?.()).toMatchObject({
          ZALO_API_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
          ZALO_BOT_TOKEN: "crabline-zalo-bot-token",
        });

        await transport.state.addInboundMessage({
          conversation: { id: "qa-group", kind: "group" },
          senderId: "alice",
          senderName: "Alice",
          text: "Zalo baseline marker check.",
        });
        const delivery = transport.buildAgentDelivery({ target: "group:qa-group" });
        expect(delivery).toEqual({
          channel: "zalo",
          replyChannel: "zalo",
          replyTo: "qa-group",
          to: "qa-group",
        });

        const env = transport.createRuntimeEnvPatch?.() ?? {};
        const zaloApiUrl = requireString(env.ZALO_API_URL, "Zalo API URL");
        const botToken = requireString(env.ZALO_BOT_TOKEN, "Zalo bot token");
        const { response, release } = await fetchWithSsrFGuard({
          url: `${zaloApiUrl}/bot${botToken}/sendMessage`,
          init: {
            body: JSON.stringify({
              chat_id: delivery.to,
              text: "assistant via fake zalo",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-crabline-zalo-transport-test",
        });
        await release();
        expect(response.ok).toBe(true);

        await expect(
          transport.waitForOutbound({
            conversation: { id: "qa-group", kind: "group" },
            textIncludes: "assistant via fake zalo",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: { id: "qa-group", kind: "group" },
          text: "assistant via fake zalo",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("injects inbound messages through Crabline and mirrors Telegram sends into normalized state", async () => {
    await withTempDir("qa-crabline-transport-", async (outputDir) => {
      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection(),
        state: createQaBusState(),
      });

      try {
        const inbound = await transport.state.addInboundMessage({
          conversation: {
            id: "telegram-command-room",
            kind: "channel",
          },
          senderId: "100001",
          senderName: "Alice",
          text: "Channel baseline marker check.",
        });

        const config = transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" });
        const telegram = config.channels?.telegram as
          | { apiRoot?: string; botToken?: string }
          | undefined;
        expect(telegram?.apiRoot).toBeTruthy();
        expect(telegram?.botToken).toBeTruthy();
        const { response, release } = await fetchWithSsrFGuard({
          url: `${telegram?.apiRoot}/bot${telegram?.botToken}/sendMessage`,
          init: {
            body: JSON.stringify({
              chat_id: inbound.conversation.id,
              text: "assistant via fake telegram",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-crabline-transport-test",
        });
        await release();
        expect(response.ok).toBe(true);

        await expect(
          transport.waitForOutbound({
            conversation: { id: "telegram-command-room", kind: "channel" },
            textIncludes: "assistant via fake telegram",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: {
            id: "telegram-command-room",
            kind: "channel",
          },
          direction: "outbound",
          text: "assistant via fake telegram",
        });

        await transport.state.reset();
        const delivery = transport.buildAgentDelivery({ target: "dm:qa-operator" });
        const { response: directResponse, release: directRelease } = await fetchWithSsrFGuard({
          url: `${telegram?.apiRoot}/bot${telegram?.botToken}/sendMessage`,
          init: {
            body: JSON.stringify({
              chat_id: delivery.to,
              text: "assistant after reset",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-crabline-transport-reset-test",
        });
        await directRelease();
        expect(directResponse.ok).toBe(true);

        await expect(
          transport.state.waitFor({
            direction: "outbound",
            kind: "message-text",
            textIncludes: "assistant after reset",
            timeoutMs: 1_000,
          }),
        ).resolves.toMatchObject({
          conversation: {
            id: "qa-operator",
            kind: "direct",
          },
          direction: "outbound",
          text: "assistant after reset",
        });
      } finally {
        await transport.cleanup?.();
      }
    });
  });
});
