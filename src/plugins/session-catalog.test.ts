import { beforeEach, describe, expect, it, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntime } from "./runtime/types.js";
import { importSessionCatalogHistory } from "./session-catalog-history-import.js";
import { listSessionCatalogEntries } from "./session-catalog.js";

const transcript = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  lockCalls: 0,
}));

vi.mock("../plugin-sdk/session-transcript-runtime.js", () => ({
  withSessionTranscriptWriteLock: async (
    _params: unknown,
    run: (context: {
      appendMessage: (params: {
        message: Record<string, unknown>;
        idempotencyLookup?: string;
        beforeCommitInTransaction?: () => void;
      }) => Promise<void>;
    }) => Promise<void>,
  ) => {
    transcript.lockCalls += 1;
    await run({
      appendMessage: async ({ message, idempotencyLookup, beforeCommitInTransaction }) => {
        beforeCommitInTransaction?.();
        const key = message.idempotencyKey;
        if (
          idempotencyLookup === "scan" &&
          typeof key === "string" &&
          transcript.messages.some((candidate) => candidate.idempotencyKey === key)
        ) {
          return;
        }
        transcript.messages.push(message);
      },
    });
  },
}));

type CatalogItem = Parameters<Parameters<typeof importSessionCatalogHistory>[0]["read"]>[0];
type TranscriptItem = Awaited<
  ReturnType<Parameters<typeof importSessionCatalogHistory>[0]["read"]>
>["items"][number];

function catalogReader(items: TranscriptItem[], maxPageSize = Number.POSITIVE_INFINITY) {
  return vi.fn(async ({ cursor, limit }: CatalogItem) => {
    const offset = cursor ? Number(cursor) : 0;
    const pageLimit = Math.min(limit, maxPageSize);
    const end = Math.max(0, items.length - offset);
    const start = Math.max(0, end - pageLimit);
    const page = items.slice(start, end).toReversed();
    const consumed = offset + page.length;
    return {
      hostId: "gateway",
      threadId: "thread-1",
      items: page,
      ...(consumed < items.length ? { nextCursor: String(consumed) } : {}),
    };
  });
}

function importHistory(
  items: TranscriptItem[],
  options: {
    continuationNotice?: string;
    commitGuard?: () => void;
    maxPageSize?: number;
    read?: ReturnType<typeof catalogReader>;
  } = {},
) {
  const read = options.read ?? catalogReader(items, options.maxPageSize);
  return {
    read,
    result: importSessionCatalogHistory({
      catalogId: "pi",
      threadId: "thread-1",
      read,
      sessionId: "session-1",
      sessionKey: "agent:main:catalog-adopt",
      agentId: "main",
      config: {} as OpenClawConfig,
      continuationNotice: options.continuationNotice,
      commitGuard: options.commitGuard,
    }),
  };
}

function messageText(message: Record<string, unknown>): string | undefined {
  if (typeof message.content === "string") {
    return message.content;
  }
  const content = Array.isArray(message.content) ? message.content[0] : undefined;
  return content && typeof content === "object" && "text" in content
    ? String(content.text)
    : undefined;
}

describe("listSessionCatalogEntries", () => {
  it("scans the retained compatibility owner first", () => {
    const config = retainLegacyDefaultAgentId(
      {
        agents: { list: [{ id: "alpha" }, { id: "beta" }] },
      } as OpenClawConfig,
      "beta",
    );
    const listSessionEntries = vi.fn((_params: { agentId: string }) => []);
    const runtime = {
      agent: { session: { listSessionEntries } },
    } as unknown as PluginRuntime;

    expect(listSessionCatalogEntries({ config, runtime })).toEqual([]);
    expect(listSessionEntries.mock.calls.map(([params]) => params.agentId)).toEqual([
      "beta",
      "alpha",
    ]);
  });

  it("requires and scopes an owner under explicit multi-agent ownership", () => {
    const config = {
      agents: {
        ownership: "explicit",
        list: [{ id: "alpha" }, { id: "beta" }],
      },
    } as OpenClawConfig;
    const listSessionEntries = vi.fn(() => []);
    const runtime = {
      agent: { session: { listSessionEntries } },
    } as unknown as PluginRuntime;

    expect(() => listSessionCatalogEntries({ config, runtime })).toThrow(
      "session agent resolution has no explicit owner",
    );
    expect(listSessionCatalogEntries({ agentId: "beta", config, runtime })).toEqual([]);
    expect(listSessionEntries).toHaveBeenCalledOnce();
    expect(listSessionEntries).toHaveBeenCalledWith({ agentId: "beta", readOnly: true });
  });
});

describe("importSessionCatalogHistory", () => {
  beforeEach(() => {
    transcript.messages.length = 0;
    transcript.lockCalls = 0;
  });

  it("imports newest-first pages in source order regardless of timestamps with native provenance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
    try {
      const { result } = importHistory(
        [
          { id: "u-1", type: "userMessage", text: "repeat me", timestamp: "not-a-date" },
          { id: "u-2", type: "userMessage", text: "numeric year", timestamp: "2026" },
          { id: "u-3", type: "userMessage", text: "numeric zero", timestamp: "0" },
          { id: "r-empty", type: "reasoning" },
          {
            id: "r-1",
            type: "reasoning",
            text: "careful",
            timestamp: "1969-12-31T23:59:59.000Z",
          },
          { id: "a-1", type: "agentMessage", text: "answer", model: "anthropic/claude" },
          { id: "t-1", type: "toolCall", text: "bash" },
          { id: "o-1", type: "other", text: "checkpoint" },
        ],
        { maxPageSize: 2 },
      );
      await result;
    } finally {
      vi.useRealTimers();
    }

    expect(transcript.messages.map(messageText)).toEqual([
      "repeat me",
      "numeric year",
      "numeric zero",
      "Thinking\n\ncareful",
      "answer",
      "Tool call\n\nbash",
      "Other\n\ncheckpoint",
    ]);
    expect(transcript.messages[0]?.["__openclaw"]).toEqual({
      mirrorOrigin: "pi-catalog-import",
    });
    expect(transcript.messages[0]?.timestamp).toBe(Date.parse("2026-07-25T12:00:00.000Z"));
    expect(transcript.messages[1]?.timestamp).toBe(Date.parse("2026"));
    expect(transcript.messages[2]?.timestamp).toBe(Date.parse("0"));
    expect(transcript.messages[3]?.timestamp).toBe(-1_000);
    expect(transcript.messages[4]?.model).toBe("anthropic/claude");
    expect(transcript.messages.map((message) => message.idempotencyKey)).toEqual([
      "pi-catalog:thread-1:u-1",
      "pi-catalog:thread-1:u-2",
      "pi-catalog:thread-1:u-3",
      "pi-catalog:thread-1:r-1",
      "pi-catalog:thread-1:a-1",
      "pi-catalog:thread-1:t-1",
      "pi-catalog:thread-1:o-1",
    ]);
  });

  it("deduplicates a recovered import by scanning item idempotency keys", async () => {
    const items: TranscriptItem[] = [
      { id: "u-1", type: "userMessage", text: "hello" },
      { id: "a-1", type: "agentMessage", text: "hi" },
    ];

    await importHistory(items).result;
    await importHistory(items).result;

    expect(transcript.lockCalls).toBe(2);
    expect(transcript.messages).toHaveLength(2);
  });

  it("keeps only the most recent 200 items and returns them oldest-first", async () => {
    const items: TranscriptItem[] = Array.from({ length: 205 }, (_, index) => ({
      id: `item-${String(index)}`,
      type: "agentMessage",
      text: `message-${String(index)}`,
    }));

    const { read, result } = importHistory(items);
    await result;

    expect(read).toHaveBeenCalledTimes(2);
    expect(transcript.messages).toHaveLength(200);
    expect(messageText(transcript.messages[0]!)).toBe("message-5");
    expect(messageText(transcript.messages.at(-1)!)).toBe("message-204");
  });

  it("keeps the recent suffix within the 512 KiB serialized-item budget", async () => {
    const items: TranscriptItem[] = Array.from({ length: 10 }, (_, index) => ({
      id: `item-${String(index)}`,
      type: "agentMessage",
      text: `${String(index)}${"x".repeat(100 * 1024)}`,
    }));

    await importHistory(items, { maxPageSize: 2 }).result;

    expect(transcript.messages).toHaveLength(5);
    expect(messageText(transcript.messages[0]!)?.startsWith("5")).toBe(true);
    expect(messageText(transcript.messages.at(-1)!)?.startsWith("9")).toBe(true);
  });

  it("truncates a newest item that alone exceeds the byte budget", async () => {
    await importHistory([{ id: "oversized", type: "toolResult", text: "x".repeat(600 * 1024) }])
      .result;

    const text = messageText(transcript.messages[0]!);
    expect(text).toMatch(/^Tool result\n\n/u);
    expect(text).toMatch(/…$/u);
    expect(Buffer.byteLength(text ?? "", "utf8")).toBeLessThan(512 * 1024);
  });

  it("does not let an unused raw payload hide visible history", async () => {
    await importHistory([
      {
        id: "raw-heavy",
        type: "agentMessage",
        text: "visible answer",
        raw: "x".repeat(600 * 1024),
      },
    ]).result;

    expect(transcript.messages.map(messageText)).toEqual(["visible answer"]);
  });

  it("does not open the transcript write lock when a paged read fails", async () => {
    const read = vi
      .fn<Parameters<typeof importSessionCatalogHistory>[0]["read"]>()
      .mockResolvedValueOnce({
        hostId: "gateway",
        threadId: "thread-1",
        items: [{ id: "a-1", type: "agentMessage", text: "latest" }],
        nextCursor: "older",
      })
      .mockRejectedValueOnce(new Error("catalog read failed"));

    await expect(importHistory([], { read }).result).rejects.toThrow("catalog read failed");
    expect(transcript.lockCalls).toBe(0);
    expect(transcript.messages).toEqual([]);
  });

  it("appends one idempotent continuation notice under the caller authority guard", async () => {
    const commitGuard = vi.fn();
    const options = {
      continuationNotice: "Copied snapshot; using openai/gpt-5.6-sol.",
      commitGuard,
    };

    await importHistory([{ id: "u-1", type: "userMessage", text: "Continue" }], options).result;
    await importHistory([{ id: "u-1", type: "userMessage", text: "Continue" }], options).result;

    expect(transcript.messages.map(messageText)).toEqual([
      "Continue",
      "Copied snapshot; using openai/gpt-5.6-sol.",
    ]);
    expect(transcript.messages[1]).toMatchObject({
      provider: "openclaw",
      model: "session-catalog",
      idempotencyKey: "pi-catalog:thread-1:continuation-notice",
    });
    expect(commitGuard).toHaveBeenCalledTimes(4);
  });
});
