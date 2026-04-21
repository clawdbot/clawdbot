import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { createOpenClawChannelMcpServer, OpenClawChannelBridge } from "./channel-server.js";
import { extractAttachmentsFromMessage } from "./channel-shared.js";

const ClaudeChannelNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel"),
  params: z.object({
    content: z.string(),
    meta: z.record(z.string(), z.string()),
  }),
});

const ClaudePermissionNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel/permission"),
  params: z.object({
    request_id: z.string(),
    behavior: z.enum(["allow", "deny"]),
  }),
});

async function connectMcpWithoutGateway(params?: { claudeChannelMode?: "auto" | "on" | "off" }) {
  const serverHarness = await createOpenClawChannelMcpServer({
    claudeChannelMode: params?.claudeChannelMode ?? "auto",
    verbose: false,
  });
  const client = new Client({ name: "mcp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await serverHarness.server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    bridge: serverHarness.bridge,
    close: async () => {
      await client.close();
      await serverHarness.close();
    },
  };
}

function attachReadyGateway(
  bridge: OpenClawChannelBridge,
  gatewayRequest: ReturnType<typeof vi.fn>,
) {
  (
    bridge as unknown as {
      gateway: { request: typeof gatewayRequest; stopAndWait: () => Promise<void> };
      readySettled: boolean;
      resolveReady: () => void;
    }
  ).gateway = {
    request: gatewayRequest,
    stopAndWait: async () => {},
  };
  (
    bridge as unknown as {
      readySettled: boolean;
      resolveReady: () => void;
    }
  ).readySettled = true;
  (
    bridge as unknown as {
      resolveReady: () => void;
    }
  ).resolveReady();
}

async function flushMcpNotifications() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("openclaw channel mcp server", () => {
  describe("gateway-backed flows", () => {
    describe("gateway integration", () => {
      test("lists conversations and reads messages", async () => {
        const sessionKey = "agent:main:main";
        const gatewayRequest = vi.fn(async (method: string) => {
          if (method === "sessions.list") {
            return {
              sessions: [
                {
                  key: sessionKey,
                  channel: "telegram",
                  deliveryContext: {
                    to: "-100123",
                    accountId: "acct-1",
                    threadId: 42,
                  },
                },
              ],
            };
          }
          if (method === "chat.history") {
            return {
              messages: [
                {
                  role: "assistant",
                  content: [{ type: "text", text: "hello from transcript" }],
                },
                {
                  __openclaw: {
                    id: "msg-attachment",
                  },
                  role: "assistant",
                  content: [
                    { type: "text", text: "attached image" },
                    {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: "image/png",
                        data: "abc",
                      },
                    },
                  ],
                },
              ],
            };
          }
          throw new Error(`unexpected gateway method ${method}`);
        });
        const bridge = new OpenClawChannelBridge({} as never, {
          claudeChannelMode: "off",
          verbose: false,
        });
        attachReadyGateway(bridge, gatewayRequest);

        await expect(bridge.listConversations()).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sessionKey,
              channel: "telegram",
              to: "-100123",
              accountId: "acct-1",
              threadId: 42,
            }),
          ]),
        );

        const messages = await bridge.readMessages(sessionKey, 5);
        expect(messages[0]).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: "hello from transcript" }],
        });
        expect(messages[1]).toMatchObject({
          __openclaw: {
            id: "msg-attachment",
          },
        });
        expect(extractAttachmentsFromMessage(messages[1])).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "image",
            }),
          ]),
        );
      });

      test("emits Claude channel and permission notifications", async () => {
        const sessionKey = "agent:main:main";
        let mcp: Awaited<ReturnType<typeof connectMcpWithoutGateway>> | null = null;
        try {
          const channelNotifications: Array<{ content: string; meta: Record<string, string> }> = [];
          const permissionNotifications: Array<{
            request_id: string;
            behavior: "allow" | "deny";
          }> = [];

          mcp = await connectMcpWithoutGateway({
            claudeChannelMode: "on",
          });
          mcp.client.setNotificationHandler(ClaudeChannelNotificationSchema, ({ params }) => {
            channelNotifications.push(params);
          });
          mcp.client.setNotificationHandler(ClaudePermissionNotificationSchema, ({ params }) => {
            permissionNotifications.push(params);
          });

          await (
            mcp.bridge as unknown as {
              handleSessionMessageEvent: (payload: Record<string, unknown>) => Promise<void>;
            }
          ).handleSessionMessageEvent({
            sessionKey,
            lastChannel: "imessage",
            lastTo: "+15551234567",
            messageId: "msg-user-1",
            message: {
              role: "user",
              content: [{ type: "text", text: "hello Claude" }],
              timestamp: Date.now(),
            },
          });

          await flushMcpNotifications();
          expect(channelNotifications).toHaveLength(1);
          expect(channelNotifications[0]).toMatchObject({
            content: "hello Claude",
            meta: expect.objectContaining({
              session_key: sessionKey,
              channel: "imessage",
              to: "+15551234567",
              message_id: "msg-user-1",
            }),
          });

          await mcp.client.notification({
            method: "notifications/claude/channel/permission_request",
            params: {
              request_id: "abcde",
              tool_name: "Bash",
              description: "run npm test",
              input_preview: '{"cmd":"npm test"}',
            },
          });

          await (
            mcp.bridge as unknown as {
              handleSessionMessageEvent: (payload: Record<string, unknown>) => Promise<void>;
            }
          ).handleSessionMessageEvent({
            sessionKey,
            lastChannel: "imessage",
            lastTo: "+15551234567",
            messageId: "msg-user-2",
            message: {
              role: "user",
              content: [{ type: "text", text: "yes abcde" }],
              timestamp: Date.now(),
            },
          });

          await flushMcpNotifications();
          expect(permissionNotifications).toHaveLength(1);
          expect(permissionNotifications[0]).toEqual({
            request_id: "abcde",
            behavior: "allow",
          });

          await (
            mcp.bridge as unknown as {
              handleSessionMessageEvent: (payload: Record<string, unknown>) => Promise<void>;
            }
          ).handleSessionMessageEvent({
            sessionKey,
            lastChannel: "imessage",
            lastTo: "+15551234567",
            messageId: "msg-user-3",
            message: {
              role: "user",
              content: "plain string user turn",
              timestamp: Date.now(),
            },
          });

          await flushMcpNotifications();
          expect(channelNotifications).toHaveLength(2);
          expect(channelNotifications[1]).toMatchObject({
            content: "plain string user turn",
            meta: expect.objectContaining({
              session_key: sessionKey,
              message_id: "msg-user-3",
            }),
          });
        } finally {
          await mcp?.close();
        }
      });
    });

    test("sendMessage normalizes route metadata for gateway send", async () => {
      const bridge = new OpenClawChannelBridge({} as never, {
        claudeChannelMode: "off",
        verbose: false,
      });
      const gatewayRequest = vi.fn().mockResolvedValue({ ok: true, channel: "telegram" });

      attachReadyGateway(bridge, gatewayRequest);

      vi.spyOn(bridge, "getConversation").mockResolvedValue({
        sessionKey: "agent:main:main",
        channel: "telegram",
        to: "-100123",
        accountId: "acct-1",
        threadId: 42,
      });

      await bridge.sendMessage({
        sessionKey: "agent:main:main",
        text: "reply from mcp",
      });

      expect(gatewayRequest).toHaveBeenCalledWith(
        "send",
        expect.objectContaining({
          to: "-100123",
          channel: "telegram",
          accountId: "acct-1",
          threadId: "42",
          sessionKey: "agent:main:main",
          message: "reply from mcp",
        }),
      );
    });

    test("lists routed sessions that only expose modern channel fields", async () => {
      const bridge = new OpenClawChannelBridge({} as never, {
        claudeChannelMode: "off",
        verbose: false,
      });
      const gatewayRequest = vi.fn().mockResolvedValue({
        sessions: [
          {
            key: "agent:main:channel-field",
            channel: "telegram",
            deliveryContext: {
              to: "-100111",
            },
          },
          {
            key: "agent:main:origin-field",
            origin: {
              provider: "imessage",
              accountId: "imessage-default",
              threadId: "thread-7",
            },
            deliveryContext: {
              to: "+15551230000",
            },
          },
        ],
      });

      attachReadyGateway(bridge, gatewayRequest);

      await expect(bridge.listConversations()).resolves.toEqual([
        expect.objectContaining({
          sessionKey: "agent:main:channel-field",
          channel: "telegram",
          to: "-100111",
        }),
        expect.objectContaining({
          sessionKey: "agent:main:origin-field",
          channel: "imessage",
          to: "+15551230000",
          accountId: "imessage-default",
          threadId: "thread-7",
        }),
      ]);
    });

    test("swallows notification send errors after channel replies are matched", async () => {
      const bridge = new OpenClawChannelBridge({} as never, {
        claudeChannelMode: "on",
        verbose: false,
      });

      (
        bridge as unknown as {
          pendingClaudePermissions: Map<string, Record<string, unknown>>;
          server: { server: { notification: ReturnType<typeof vi.fn> } };
        }
      ).pendingClaudePermissions.set("abcde", {
        toolName: "Bash",
        description: "run npm test",
        inputPreview: '{"cmd":"npm test"}',
      });
      (
        bridge as unknown as {
          server: { server: { notification: ReturnType<typeof vi.fn> } };
        }
      ).server = {
        server: {
          notification: vi.fn().mockRejectedValue(new Error("Not connected")),
        },
      };

      await expect(
        (
          bridge as unknown as {
            handleSessionMessageEvent: (payload: Record<string, unknown>) => Promise<void>;
          }
        ).handleSessionMessageEvent({
          sessionKey: "agent:main:main",
          message: {
            role: "user",
            content: [{ type: "text", text: "yes abcde" }],
          },
        }),
      ).resolves.toBeUndefined();
    });

    test("waits for queued events through the MCP tool", async () => {
      const mcp = await connectMcpWithoutGateway({ claudeChannelMode: "off" });
      try {
        await (
          mcp.bridge as unknown as {
            handleSessionMessageEvent: (payload: Record<string, unknown>) => Promise<void>;
          }
        ).handleSessionMessageEvent({
          sessionKey: "agent:main:main",
          lastChannel: "telegram",
          lastTo: "-100123",
          lastAccountId: "acct-1",
          lastThreadId: 42,
          messageId: "msg-2",
          messageSeq: 1,
          message: {
            role: "user",
            content: [{ type: "text", text: "inbound live message" }],
          },
        });

        const waited = (await mcp.client.callTool({
          name: "events_wait",
          arguments: { session_key: "agent:main:main", after_cursor: 0, timeout_ms: 250 },
        })) as {
          structuredContent?: { event?: Record<string, unknown> };
        };
        expect(waited.structuredContent?.event).toMatchObject({
          type: "message",
          sessionKey: "agent:main:main",
          messageId: "msg-2",
          role: "user",
          text: "inbound live message",
        });
      } finally {
        await mcp.close();
      }
    });
  });
});
