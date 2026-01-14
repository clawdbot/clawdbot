import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-channel.js";
import {
  agentCommand,
  connectOk,
  installGatewayTestHooks,
  onceMessage,
  piSdkMock,
  rpcReq,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks();

async function waitFor(condition: () => boolean, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout waiting for condition");
}

describe("gateway server chat", () => {
  test("webchat can chat.send without a mobile node", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws, {
      client: {
        id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        version: "dev",
        platform: "web",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    });

    const res = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "hello",
      idempotencyKey: "idem-webchat-1",
    });
    expect(res.ok).toBe(true);

    ws.close();
    await server.close();
  });

  test("chat.send defaults to agent timeout config", async () => {
    testState.agentConfig = { timeoutSeconds: 123 };
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const spy = vi.mocked(agentCommand);
    const callsBefore = spy.mock.calls.length;
    const res = await rpcReq(ws, "chat.send", {
      sessionKey: "main",
      message: "hello",
      idempotencyKey: "idem-timeout-1",
    });
    expect(res.ok).toBe(true);

    await waitFor(() => spy.mock.calls.length > callsBefore);
    const call = spy.mock.calls.at(-1)?.[0] as { timeout?: string } | undefined;
    expect(call?.timeout).toBe("123");

    ws.close();
    await server.close();
  });

  test("chat.send forwards sessionKey to agentCommand", async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const spy = vi.mocked(agentCommand);
    const callsBefore = spy.mock.calls.length;
    const res = await rpcReq(ws, "chat.send", {
      sessionKey: "agent:main:subagent:abc",
      message: "hello",
      idempotencyKey: "idem-session-key-1",
    });
    expect(res.ok).toBe(true);

    await waitFor(() => spy.mock.calls.length > callsBefore);
    const call = spy.mock.calls.at(-1)?.[0] as
      | { sessionKey?: string }
      | undefined;
    expect(call?.sessionKey).toBe("agent:main:subagent:abc");

    ws.close();
    await server.close();
  });

  test("chat.send blocked by send policy", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    testState.sessionConfig = {
      sendPolicy: {
        default: "allow",
        rules: [
          {
            action: "deny",
            match: { channel: "discord", chatType: "group" },
          },
        ],
      },
    };

    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          "discord:group:dev": {
            sessionId: "sess-discord",
            updatedAt: Date.now(),
            chatType: "group",
            channel: "discord",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "chat.send", {
      sessionKey: "discord:group:dev",
      message: "hello",
      idempotencyKey: "idem-1",
    });
    expect(res.ok).toBe(false);
    expect(
      (res.error as { message?: string } | undefined)?.message ?? "",
    ).toMatch(/send blocked/i);

    ws.close();
    await server.close();
  });

  test("agent blocked by send policy for sessionKey", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    testState.sessionConfig = {
      sendPolicy: {
        default: "allow",
        rules: [{ action: "deny", match: { keyPrefix: "cron:" } }],
      },
    };

    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          "cron:job-1": {
            sessionId: "sess-cron",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "agent", {
      sessionKey: "cron:job-1",
      message: "hi",
      idempotencyKey: "idem-2",
    });
    expect(res.ok).toBe(false);
    expect(
      (res.error as { message?: string } | undefined)?.message ?? "",
    ).toMatch(/send blocked/i);

    ws.close();
    await server.close();
  });
  test("chat.send accepts image attachment", { timeout: 12000 }, async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const spy = vi.mocked(agentCommand);
    const callsBefore = spy.mock.calls.length;

    const pngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

    const reqId = "chat-img";
    ws.send(
      JSON.stringify({
        type: "req",
        id: reqId,
        method: "chat.send",
        params: {
          sessionKey: "main",
          message: "see image",
          idempotencyKey: "idem-img",
          attachments: [
            {
              type: "image",
              mimeType: "image/png",
              fileName: "dot.png",
              content: `data:image/png;base64,${pngB64}`,
            },
          ],
        },
      }),
    );

    const res = await onceMessage(
      ws,
      (o) => o.type === "res" && o.id === reqId,
      8000,
    );
    expect(res.ok).toBe(true);
    expect(res.payload?.runId).toBeDefined();

    await waitFor(() => spy.mock.calls.length > callsBefore, 8000);
    const call = spy.mock.calls.at(-1)?.[0] as
      | { images?: Array<{ type: string; data: string; mimeType: string }> }
      | undefined;
    expect(call?.images).toEqual([
      { type: "image", data: pngB64, mimeType: "image/png" },
    ]);

    ws.close();
    await server.close();
  });

  test("chat.history caps large histories and honors limit", async () => {
    const firstContentText = (msg: unknown): string | undefined => {
      if (!msg || typeof msg !== "object") return undefined;
      const content = (msg as { content?: unknown }).content;
      if (!Array.isArray(content) || content.length === 0) return undefined;
      const first = content[0];
      if (!first || typeof first !== "object") return undefined;
      const text = (first as { text?: unknown }).text;
      return typeof text === "string" ? text : undefined;
    };

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const lines: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      lines.push(
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: `m${i}` }],
            timestamp: Date.now() + i,
          },
        }),
      );
    }
    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      lines.join("\n"),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const defaultRes = await rpcReq<{ messages?: unknown[] }>(
      ws,
      "chat.history",
      {
        sessionKey: "main",
      },
    );
    expect(defaultRes.ok).toBe(true);
    const defaultMsgs = defaultRes.payload?.messages ?? [];
    expect(defaultMsgs.length).toBe(200);
    expect(firstContentText(defaultMsgs[0])).toBe("m100");

    const limitedRes = await rpcReq<{ messages?: unknown[] }>(
      ws,
      "chat.history",
      {
        sessionKey: "main",
        limit: 5,
      },
    );
    expect(limitedRes.ok).toBe(true);
    const limitedMsgs = limitedRes.payload?.messages ?? [];
    expect(limitedMsgs.length).toBe(5);
    expect(firstContentText(limitedMsgs[0])).toBe("m295");

    const largeLines: string[] = [];
    for (let i = 0; i < 1500; i += 1) {
      largeLines.push(
        JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: `b${i}` }],
            timestamp: Date.now() + i,
          },
        }),
      );
    }
    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      largeLines.join("\n"),
      "utf-8",
    );

    const cappedRes = await rpcReq<{ messages?: unknown[] }>(
      ws,
      "chat.history",
      {
        sessionKey: "main",
      },
    );
    expect(cappedRes.ok).toBe(true);
    const cappedMsgs = cappedRes.payload?.messages ?? [];
    expect(cappedMsgs.length).toBe(200);
    expect(firstContentText(cappedMsgs[0])).toBe("b1300");

    const maxRes = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
      sessionKey: "main",
      limit: 1000,
    });
    expect(maxRes.ok).toBe(true);
    const maxMsgs = maxRes.payload?.messages ?? [];
    expect(maxMsgs.length).toBe(1000);
    expect(firstContentText(maxMsgs[0])).toBe("b500");

    ws.close();
    await server.close();
  });

  test("chat.history prefers sessionFile when set", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");

    const forkedPath = path.join(dir, "sess-forked.jsonl");
    await fs.writeFile(
      forkedPath,
      JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "text", text: "from-fork" }],
          timestamp: Date.now(),
        },
      }),
      "utf-8",
    );

    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "text", text: "from-default" }],
          timestamp: Date.now(),
        },
      }),
      "utf-8",
    );

    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            sessionFile: forkedPath,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq<{ messages?: unknown[] }>(ws, "chat.history", {
      sessionKey: "main",
    });
    expect(res.ok).toBe(true);
    const messages = res.payload?.messages ?? [];
    expect(messages.length).toBe(1);
    const first = messages[0] as { content?: { text?: string }[] };
    expect(first.content?.[0]?.text).toBe("from-fork");

    ws.close();
    await server.close();
  });

  test("chat.history defaults thinking to low for reasoning-capable models", async () => {
    piSdkMock.enabled = true;
    piSdkMock.models = [
      {
        id: "claude-opus-4-5",
        name: "Opus 4.5",
        provider: "anthropic",
        reasoning: true,
      },
    ];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "sess-main.jsonl"),
      JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: Date.now(),
        },
      }),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq<{ thinkingLevel?: string }>(ws, "chat.history", {
      sessionKey: "main",
    });
    expect(res.ok).toBe(true);
    expect(res.payload?.thinkingLevel).toBe("low");

    ws.close();
    await server.close();
  });
});
