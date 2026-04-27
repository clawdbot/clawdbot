import { randomUUID } from "node:crypto";
import {
  assert,
  ClaudeChannelNotificationSchema,
  ClaudePermissionNotificationSchema,
  connectGateway,
  connectMcpClient,
  extractTextFromGatewayPayload,
  type ClaudeChannelNotification,
  maybeApprovePendingBridgePairing,
  waitFor,
} from "./mcp-channels-harness.ts";

async function main() {
  const gatewayUrl = process.env.GW_URL?.trim();
  const gatewayToken = process.env.GW_TOKEN?.trim();
  assert(gatewayUrl, "missing GW_URL");
  assert(gatewayToken, "missing GW_TOKEN");

  const gateway = await connectGateway({ url: gatewayUrl, token: gatewayToken });
  let mcpHandle = await connectMcpClient({
    gatewayUrl,
    gatewayToken,
  });
  let mcp = mcpHandle.client;

  try {
    if (await maybeApprovePendingBridgePairing(gateway)) {
      await Promise.allSettled([mcp.close(), mcpHandle.transport.close()]);
      mcpHandle = await connectMcpClient({
        gatewayUrl,
        gatewayToken,
      });
      mcp = mcpHandle.client;
    }
    const callTool = <T>(params: Parameters<typeof mcp.callTool>[0]) =>
      mcp.callTool(params, undefined, { timeout: 240_000 }) as Promise<T>;

    const conversation = await waitFor(
      "seeded conversation in conversations_list",
      async () => {
        const listed = await callTool<{
          structuredContent?: { conversations?: Array<Record<string, unknown>> };
        }>({
          name: "conversations_list",
          arguments: {},
        });
        return listed.structuredContent?.conversations?.find(
          (entry) => entry.sessionKey === "agent:main:main",
        );
      },
      240_000,
    );
    assert(conversation.channel === "imessage", "expected seeded channel");
    assert(conversation.to === "+15551234567", "expected seeded target");

    const fetched = await callTool<{
      structuredContent?: { conversation?: Record<string, unknown> };
      isError?: boolean;
    }>({
      name: "conversation_get",
      arguments: { session_key: "agent:main:main" },
    });
    assert(!fetched.isError, "conversation_get should succeed");
    assert(
      fetched.structuredContent?.conversation?.sessionKey === "agent:main:main",
      "conversation_get returned wrong session",
    );

    let lastHistory: unknown;
    const messages = await waitFor(
      "seeded transcript messages",
      async () => {
        const history = await callTool<{
          structuredContent?: { messages?: Array<Record<string, unknown>> };
        }>({
          name: "messages_read",
          arguments: { session_key: "agent:main:main", limit: 10 },
        });
        lastHistory = history;
        const currentMessages = history.structuredContent?.messages ?? [];
        return currentMessages.length >= 2 ? currentMessages : undefined;
      },
      240_000,
    ).catch((error) => {
      throw new Error(
        `timeout waiting for seeded transcript messages: ${JSON.stringify(lastHistory, null, 2)}`,
        { cause: error },
      );
    });
    await waitFor(
      "seeded attachment message",
      () =>
        messages.find((entry) => {
          const raw = entry.__openclaw;
          return (
            raw && typeof raw === "object" && (raw as { id?: unknown }).id === "msg-attachment"
          );
        }),
      240_000,
    );

    const attachments = await callTool<{
      structuredContent?: { attachments?: Array<Record<string, unknown>> };
      isError?: boolean;
    }>({
      name: "attachments_fetch",
      arguments: { session_key: "agent:main:main", message_id: "msg-attachment" },
    });
    assert(!attachments.isError, "attachments_fetch should succeed");
    assert(
      (attachments.structuredContent?.attachments?.length ?? 0) === 1,
      "expected one seeded attachment",
    );

    const waited = (await Promise.all([
      callTool<{
        structuredContent?: { event?: Record<string, unknown> };
      }>({
        name: "events_wait",
        arguments: {
          session_key: "agent:main:main",
          after_cursor: 0,
          timeout_ms: 10_000,
        },
      }),
      gateway.request("chat.inject", {
        sessionKey: "agent:main:main",
        message: "assistant live event",
      }),
    ]).then(([result]) => result)) as {
      structuredContent?: { event?: Record<string, unknown> };
    };
    const assistantEvent = waited.structuredContent?.event;
    assert(assistantEvent, "expected events_wait result");
    assert(assistantEvent.type === "message", "expected message event");
    assert(assistantEvent.role === "assistant", "expected assistant event role");
    assert(assistantEvent.text === "assistant live event", "expected assistant event text");
    const assistantCursor = typeof assistantEvent.cursor === "number" ? assistantEvent.cursor : 0;

    const polled = await callTool<{
      structuredContent?: { events?: Array<Record<string, unknown>> };
    }>({
      name: "events_poll",
      arguments: { session_key: "agent:main:main", after_cursor: 0, limit: 10 },
    });
    assert(
      (polled.structuredContent?.events ?? []).some(
        (entry) => entry.text === "assistant live event",
      ),
      "expected assistant event in events_poll",
    );

    const channelMessage = `hello from docker ${randomUUID()}`;
    const userEvent = (await Promise.all([
      callTool<{
        structuredContent?: { event?: Record<string, unknown> };
      }>({
        name: "events_wait",
        arguments: {
          session_key: "agent:main:main",
          after_cursor: assistantCursor,
          timeout_ms: 10_000,
        },
      }),
      gateway.request("chat.send", {
        sessionKey: "agent:main:main",
        message: channelMessage,
        idempotencyKey: randomUUID(),
      }),
    ]).then(([result]) => result)) as {
      structuredContent?: { event?: Record<string, unknown> };
    };
    const rawGatewayUserMessage = await waitFor("raw gateway user session.message", () =>
      gateway.events.find(
        (entry) =>
          entry.event === "session.message" &&
          entry.payload.sessionKey === "agent:main:main" &&
          extractTextFromGatewayPayload(entry.payload) === channelMessage,
      ),
    );
    if (userEvent.structuredContent?.event?.text !== channelMessage) {
      throw new Error(
        `expected user event after chat.send: ${JSON.stringify(
          {
            userEvent: userEvent.structuredContent?.event ?? null,
            rawGatewayUserMessage: rawGatewayUserMessage ?? null,
            recentGatewayEvents: gateway.events.slice(-10).map((entry) => ({
              event: entry.event,
              sessionKey: entry.payload.sessionKey,
              text: extractTextFromGatewayPayload(entry.payload),
            })),
          },
          null,
          2,
        )}`,
      );
    }
    assert(rawGatewayUserMessage, "expected raw gateway session.message after chat.send");

    let helpNotification: ClaudeChannelNotification;
    try {
      helpNotification = await waitFor(
        "Claude channel notification",
        () =>
          mcpHandle.rawMessages
            .map((entry) => ClaudeChannelNotificationSchema.safeParse(entry))
            .find(
              (entry) =>
                entry.success &&
                entry.data.params.meta.session_key === "agent:main:main" &&
                entry.data.params.content === channelMessage,
            )?.data.params,
      );
    } catch (error) {
      throw new Error(
        `timeout waiting for Claude channel notification: ${JSON.stringify(
          {
            rawMessages: mcpHandle.rawMessages.slice(-10),
          },
          null,
          2,
        )}`,
        { cause: error },
      );
    }
    assert(helpNotification.content === channelMessage, "expected Claude channel content");

    await mcp.notification({
      method: "notifications/claude/channel/permission_request",
      params: {
        request_id: "abcde",
        tool_name: "Bash",
        description: "run npm test",
        input_preview: '{"cmd":"npm test"}',
      },
    });

    await gateway.request("chat.send", {
      sessionKey: "agent:main:main",
      message: "yes abcde",
      idempotencyKey: randomUUID(),
    });
    const permission = await waitFor(
      "Claude permission notification",
      () =>
        mcpHandle.rawMessages
          .map((entry) => ClaudePermissionNotificationSchema.safeParse(entry))
          .find((entry) => entry.success && entry.data.params.request_id === "abcde")?.data.params,
    );
    assert(permission.behavior === "allow", "expected allow permission reply");

    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          sessionKey: "agent:main:main",
          rawNotifications: mcpHandle.rawMessages.filter(
            (entry) =>
              ClaudeChannelNotificationSchema.safeParse(entry).success ||
              ClaudePermissionNotificationSchema.safeParse(entry).success,
          ).length,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await Promise.allSettled([mcp.close(), mcpHandle.transport.close(), gateway.close()]);
  }
}

await main();
