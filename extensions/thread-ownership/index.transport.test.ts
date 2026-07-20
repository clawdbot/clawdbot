// Real-transport proof: ownership 200 path is status-only and must cancel unread bodies.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import register from "./index.js";

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("thread-ownership transport body cleanup", () => {
  const hooks: Record<string, Function> = {};
  const originalSlackForwarderUrl = process.env.SLACK_FORWARDER_URL;
  const originalSlackBotUserId = process.env.SLACK_BOT_USER_ID;
  let configFile: Record<string, unknown> = {};
  const api = {
    pluginConfig: {},
    config: {
      agents: {
        list: [{ id: "test-agent", default: true, identity: { name: "TestBot" } }],
      },
    },
    runtime: {
      config: {
        current: () => configFile,
      },
    },
    id: "thread-ownership",
    name: "Thread Ownership",
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    on: vi.fn((hookName: string, handler: Function) => {
      hooks[hookName] = handler;
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(hooks)) {
      delete hooks[key];
    }
    api.pluginConfig = {};
    configFile = { agents: api.config.agents };
    process.env.SLACK_BOT_USER_ID = "U999";
  });

  afterEach(() => {
    if (originalSlackForwarderUrl === undefined) {
      delete process.env.SLACK_FORWARDER_URL;
    } else {
      process.env.SLACK_FORWARDER_URL = originalSlackForwarderUrl;
    }
    if (originalSlackBotUserId === undefined) {
      delete process.env.SLACK_BOT_USER_ID;
    } else {
      process.env.SLACK_BOT_USER_ID = originalSlackBotUserId;
    }
  });

  it("cancels unread 200 ownership bodies and closes the request socket", async () => {
    let resolveClientClosed: (() => void) | undefined;
    const clientClosed = new Promise<void>((resolve) => {
      resolveClientClosed = resolve;
    });
    const server = createServer((request, response) => {
      request.socket.once("close", () => resolveClientClosed?.());
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"ok":true,"agent_id":"test-agent"');
    });

    const forwarderUrl = await listen(server);
    process.env.SLACK_FORWARDER_URL = forwarderUrl;
    register.register(api as unknown as OpenClawPluginApi);
    const send = expectDefined(hooks.message_sending, "message_sending hook");

    try {
      const result = await send(
        { content: "hello", replyToId: "1234.5678", metadata: { channelId: "C123" }, to: "C123" },
        { channelId: "slack", conversationId: "C123" },
      );
      expect(result).toBeUndefined();
      await expect(clientClosed).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("cancels unread unexpected-status bodies and closes the request socket", async () => {
    let resolveClientClosed: (() => void) | undefined;
    const clientClosed = new Promise<void>((resolve) => {
      resolveClientClosed = resolve;
    });
    const server = createServer((request, response) => {
      request.socket.once("close", () => resolveClientClosed?.());
      response.writeHead(500, { "Content-Type": "application/json" });
      response.write('{"error":"boom"');
    });

    const forwarderUrl = await listen(server);
    process.env.SLACK_FORWARDER_URL = forwarderUrl;
    register.register(api as unknown as OpenClawPluginApi);
    const send = expectDefined(hooks.message_sending, "message_sending hook");

    try {
      const result = await send(
        { content: "hello", replyToId: "1234.5678", metadata: { channelId: "C123" }, to: "C123" },
        { channelId: "slack", conversationId: "C123" },
      );
      expect(result).toBeUndefined();
      await expect(clientClosed).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
