// sessions_history tool tests cover recall redaction and input validation for
// session transcript history returned to models.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { callGateway as gatewayCall } from "../../gateway/call.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";

type CallGatewayRequest = Parameters<typeof gatewayCall>[0];
type HistoryMessage = {
  role: string;
  content: string;
  __openclaw: { seq: number };
};

let createSessionsHistoryTool: typeof import("./sessions-history-tool.js").createSessionsHistoryTool;
let previousConfigPath: string | undefined;
let tempDir: string | undefined;

function useLoggingConfig(name: string, logging: Record<string, unknown>): void {
  if (!tempDir) {
    throw new Error("tempDir not initialized");
  }
  const configPath = path.join(tempDir, name);
  fs.writeFileSync(configPath, `${JSON.stringify({ logging })}\n`, "utf8");
  setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
}

function createHistoryToolWithMessage(content: unknown) {
  return createSessionsHistoryTool({
    config: {},
    callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "user",
              content,
            },
          ],
        } as T;
      }
      return {} as T;
    },
  });
}

function readHistoryDetails(result: { details: unknown }) {
  return result.details as Record<string, unknown>;
}

function readMessageSeq(message: unknown): number | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const meta = (message as Record<string, unknown>)["__openclaw"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const seq = (meta as Record<string, unknown>).seq;
  return typeof seq === "number" ? seq : undefined;
}

function readMessageId(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const meta = (message as Record<string, unknown>)["__openclaw"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const id = (meta as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

describe("sessions_history redaction", () => {
  beforeAll(async () => {
    previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-history-redact-"));
    useLoggingConfig("redaction-off.json", { redactSensitive: "off" });
    ({ createSessionsHistoryTool } = await import("./sessions-history-tool.js"));
  });

  afterAll(() => {
    if (previousConfigPath === undefined) {
      deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    } else {
      setTestEnvValue("OPENCLAW_CONFIG_PATH", previousConfigPath);
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("declares complete success and closed error contracts", async () => {
    const tool = createHistoryToolWithMessage("hello");
    const result = await tool.execute("contract", { sessionKey: "main" });

    expect(tool.outputSchema).toBeDefined();
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    expect(Value.Check(tool.outputSchema!, { status: "error", error: "missing" })).toBe(true);
    expect(
      Value.Check(tool.outputSchema!, { status: "forbidden", error: "hidden", extra: true }),
    ).toBe(false);
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      '{ bytes: number; contentRedacted: boolean; contentTruncated: boolean; droppedMessages: boolean; messages: Array<unknown>; sessionKey: string; truncated: boolean; hasMore?: boolean; nextOffset?: number; offset?: number; totalMessages?: number } | { error: string; status: "error" | "forbidden" }',
    );
  });

  it("redacts recalled session text even when log redaction is disabled", async () => {
    // Recalled transcript content is model-visible, so it is always redacted
    // even when normal logging redaction is configured off.
    useLoggingConfig("redaction-off.json", { redactSensitive: "off" });
    const tool = createHistoryToolWithMessage("OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789");

    const result = await tool.execute("call-1", { sessionKey: "main" });
    const serialized = JSON.stringify(result.details);

    expect(serialized).not.toContain("sk-or-v1-abcdef0123456789");
    expect(serialized).toContain("OPENROUTER_API_KEY=");
    expect((result.details as { contentRedacted?: unknown }).contentRedacted).toBe(true);
  });

  it("applies custom redaction patterns to recalled session text", async () => {
    useLoggingConfig("custom-patterns.json", {
      redactSensitive: "off",
      redactPatterns: [String.raw`\binternal-ticket-[A-Za-z0-9]+\b`],
    });
    const tool = createHistoryToolWithMessage("follow up on internal-ticket-AbC12345");

    const result = await tool.execute("call-1", { sessionKey: "main" });
    const serialized = JSON.stringify(result.details);

    expect(serialized).not.toContain("internal-ticket-AbC12345");
    expect(serialized).toContain("intern");
    expect((result.details as { contentRedacted?: unknown }).contentRedacted).toBe(true);
  });

  it.each([
    {
      name: "reports decoded bytes for raw image data",
      content: [
        {
          type: "image",
          data: Buffer.from([0, 1, 2, 3, 4]).toString("base64"),
          mimeType: "image/png",
        },
      ],
      expectedBytes: 5,
    },
    {
      name: "replaces stale bytes for empty image data",
      content: [{ type: "image", data: "", mimeType: "image/png", bytes: 999 }],
      expectedBytes: 0,
    },
    {
      name: "preserves existing bytes when image data is already omitted",
      content: [{ type: "image", mimeType: "image/png", bytes: 37, omitted: true }],
      expectedBytes: 37,
    },
  ])("$name", async ({ content, expectedBytes }) => {
    const tool = createHistoryToolWithMessage(content);

    const result = await tool.execute("call-1", { sessionKey: "main" });
    const details = readHistoryDetails(result);

    expect(details.messages).toEqual([
      {
        role: "user",
        content: [{ type: "image", mimeType: "image/png", bytes: expectedBytes, omitted: true }],
      },
    ]);
  });

  it.each([0, 1.5])("rejects invalid limit value %s", async (limit) => {
    const tool = createHistoryToolWithMessage("hello");

    await expect(tool.execute("call-1", { sessionKey: "main", limit })).rejects.toThrow(
      "limit must be a positive integer",
    );
  });

  it.each([-1, 1.5, "1abc"])("rejects invalid offset value %s", async (offset) => {
    const requests: CallGatewayRequest[] = [];
    const tool = createSessionsHistoryTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        requests.push(request);
        return { messages: [] } as T;
      },
    });

    await expect(tool.execute("call-1", { sessionKey: "main", offset })).rejects.toThrow(
      "offset must be a non-negative integer",
    );
    expect(requests).toEqual([]);
  });

  it("rejects offset and messageId together", async () => {
    const tool = createHistoryToolWithMessage("hello");

    await expect(
      tool.execute("call-1", { sessionKey: "main", offset: 0, messageId: "message-1" }),
    ).rejects.toThrow("offset and messageId cannot be used together");
  });

  it("rejects sessionId without messageId", async () => {
    const tool = createHistoryToolWithMessage("hello");

    await expect(
      tool.execute("call-1", { sessionKey: "main", sessionId: "session-1" }),
    ).rejects.toThrow("sessionId requires messageId");
  });

  it("preserves the bounded default history request", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createSessionsHistoryTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        requests.push(request);
        return { messages: [{ role: "assistant", content: "latest" }] } as T;
      },
    });

    const result = await tool.execute("call-1", { sessionKey: "main", limit: 2 });

    expect(requests[0]).toMatchObject({
      method: "chat.history",
      params: { sessionKey: "main", limit: 2 },
    });
    expect(
      (expectDefined(requests[0], "requests[0] test invariant").params as Record<string, unknown>)
        .offset,
    ).toBeUndefined();
    expect((result.details as Record<string, unknown>).offset).toBeUndefined();
  });

  it("requests explicit offset pages and returns continuation metadata", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createSessionsHistoryTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        requests.push(request);
        return {
          messages: [
            { role: "user", content: "newer" },
            { role: "assistant", content: "latest" },
          ],
          offset: 0,
          nextOffset: 2,
          hasMore: true,
          totalMessages: 4,
        } as T;
      },
    });

    const result = await tool.execute("call-1", { sessionKey: "main", limit: 2, offset: 0 });

    expect(requests[0]).toMatchObject({
      method: "chat.history",
      params: { sessionKey: "main", limit: 2, offset: 0 },
    });
    expect(result.details).toMatchObject({
      offset: 0,
      nextOffset: 2,
      hasMore: true,
      totalMessages: 4,
    });
  });

  it("requests history around a search result message id", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createSessionsHistoryTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        requests.push(request);
        return {
          messages: [
            { role: "user", content: "before" },
            { role: "assistant", content: "matching message" },
            { role: "user", content: "after" },
          ],
        } as T;
      },
    });

    const result = await tool.execute("call-1", {
      sessionKey: "main",
      limit: 3,
      messageId: "matching-message",
      sessionId: "matching-session",
    });

    expect(requests[0]).toMatchObject({
      method: "chat.history",
      params: {
        sessionKey: "main",
        limit: 3,
        messageId: "matching-message",
        sessionId: "matching-session",
      },
    });
    expect(result.details).toMatchObject({
      messages: [{ content: "before" }, { content: "matching message" }, { content: "after" }],
    });
  });

  it("keeps the anchored message when the history byte cap trims neighbors", async () => {
    const anchorId = "message-10";
    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index + 1} ${"x".repeat(4_000)}`,
      __openclaw: { id: `message-${index + 1}`, seq: index + 1 },
    }));
    const tool = createSessionsHistoryTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(): Promise<T> =>
        ({ messages, offset: 0, totalMessages: messages.length }) as T,
    });

    const result = await tool.execute("call-1", {
      sessionKey: "main",
      messageId: anchorId,
    });
    const details = readHistoryDetails(result);
    const returnedMessages = details.messages as unknown[];

    expect(returnedMessages.length).toBeLessThan(messages.length);
    expect(returnedMessages.some((message) => readMessageId(message) === anchorId)).toBe(true);
    expect(details).toMatchObject({ truncated: true, droppedMessages: true });
    expect(details.offset).toBeUndefined();
    expect(details.nextOffset).toBeUndefined();
    expect(details.hasMore).toBeUndefined();
  });

  it("recomputes pagination after the tool byte cap drops older returned messages", async () => {
    const messages: HistoryMessage[] = Array.from({ length: 30 }, (_, index) => ({
      role: "assistant",
      content: `message-${index + 1} ${"x".repeat(10_000)}`,
      __openclaw: { seq: index + 1 },
    }));
    const tool = createSessionsHistoryTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(): Promise<T> =>
        ({
          messages,
          offset: 0,
          nextOffset: 30,
          hasMore: false,
          totalMessages: 30,
        }) as T,
    });

    const result = await tool.execute("call-1", { sessionKey: "main", offset: 0 });
    const details = readHistoryDetails(result);
    const returnedMessages = details.messages as unknown[];
    const oldestReturnedSeq = readMessageSeq(returnedMessages[0]);

    expect(returnedMessages.length).toBeGreaterThan(0);
    expect(returnedMessages.length).toBeLessThan(messages.length);
    expect(typeof oldestReturnedSeq).toBe("number");
    const expectedNextOffset = 30 - oldestReturnedSeq! + 1;
    expect(oldestReturnedSeq).toBeGreaterThan(1);
    expect(details).toMatchObject({
      offset: 0,
      nextOffset: expectedNextOffset,
      hasMore: true,
      totalMessages: 30,
      truncated: true,
      droppedMessages: true,
    });
    expect(details.nextOffset).not.toBe(30);
  });

  it("uses the oldest visible message for pagination after tool messages are filtered", async () => {
    const tool = createSessionsHistoryTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(): Promise<T> =>
        ({
          messages: [
            { role: "tool", content: "hidden", __openclaw: { seq: 6 } },
            { role: "assistant", content: "visible", __openclaw: { seq: 7 } },
            { role: "assistant", content: "latest", __openclaw: { seq: 8 } },
          ],
          offset: 0,
          nextOffset: 5,
          hasMore: true,
          totalMessages: 10,
        }) as T,
    });

    const result = await tool.execute("call-1", { sessionKey: "main", offset: 0 });
    const details = readHistoryDetails(result);

    expect(details.messages).toEqual([
      { role: "assistant", content: "visible", __openclaw: { seq: 7 } },
      { role: "assistant", content: "latest", __openclaw: { seq: 8 } },
    ]);
    expect(details).toMatchObject({
      offset: 0,
      nextOffset: 4,
      hasMore: true,
      totalMessages: 10,
    });
  });
});
