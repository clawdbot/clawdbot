/** Tests block reply pipeline buffering, dedupe, and final flush behavior. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import {
  createBlockReplyContentKey,
  createBlockReplyPayloadKey,
  createBlockReplyPipeline,
} from "./block-reply-pipeline.js";

const waitForAbort = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createBlockReplyPayloadKey", () => {
  it("produces different keys for payloads differing only by replyToId", () => {
    const a = createBlockReplyPayloadKey({ text: "hello world", replyToId: "post-1" });
    const b = createBlockReplyPayloadKey({ text: "hello world", replyToId: "post-2" });
    const c = createBlockReplyPayloadKey({ text: "hello world" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("produces different keys for payloads with different text", () => {
    const a = createBlockReplyPayloadKey({ text: "hello" });
    const b = createBlockReplyPayloadKey({ text: "world" });
    expect(a).not.toBe(b);
  });

  it("produces different keys for payloads with different media", () => {
    const a = createBlockReplyPayloadKey({ text: "hello", mediaUrl: "file:///a.png" });
    const b = createBlockReplyPayloadKey({ text: "hello", mediaUrl: "file:///b.png" });
    expect(a).not.toBe(b);
  });

  it("produces different keys for payloads with different presentation content", () => {
    const a = createBlockReplyPayloadKey({
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "Approve", value: "approve" }] }],
      },
    });
    const b = createBlockReplyPayloadKey({
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "Reject", value: "reject" }] }],
      },
    });
    expect(a).not.toBe(b);
  });

  it("trims whitespace from text for key comparison", () => {
    const a = createBlockReplyPayloadKey({ text: "  hello  " });
    const b = createBlockReplyPayloadKey({ text: "hello" });
    expect(a).toBe(b);
  });
});

describe("createBlockReplyContentKey", () => {
  it("produces the same key for payloads differing only by replyToId", () => {
    const a = createBlockReplyContentKey({ text: "hello world", replyToId: "post-1" });
    const b = createBlockReplyContentKey({ text: "hello world", replyToId: "post-2" });
    const c = createBlockReplyContentKey({ text: "hello world" });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("keeps rich content in the reply-independent content key", () => {
    const a = createBlockReplyContentKey({
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "Approve", value: "approve" }] }],
      },
      replyToId: "post-1",
    });
    const b = createBlockReplyContentKey({
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "Approve", value: "approve" }] }],
      },
      replyToId: "post-2",
    });
    const c = createBlockReplyContentKey({
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "Reject", value: "reject" }] }],
      },
      replyToId: "post-1",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("createBlockReplyPipeline dedup with threading", () => {
  it("keeps separate deliveries for same text with different replyToId", async () => {
    const sent: Array<{ text?: string; replyToId?: string }> = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push({ text: payload.text, replyToId: payload.replyToId });
      },
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "response text", replyToId: "thread-root-1" });
    pipeline.enqueue({ text: "response text", replyToId: undefined });
    await pipeline.flush({ force: true });

    expect(sent).toEqual([
      { text: "response text", replyToId: "thread-root-1" },
      { text: "response text", replyToId: undefined },
    ]);
  });

  it("hasSentPayload matches regardless of replyToId", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "response text", replyToId: "thread-root-1" });
    await pipeline.flush({ force: true });

    // Final payload with no replyToId should be recognized as already sent
    expect(pipeline.hasSentPayload({ text: "response text" })).toBe(true);
    expect(pipeline.hasSentPayload({ text: "response text", replyToId: "other-id" })).toBe(true);
  });

  it("tracks media URLs delivered via block replies", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    expect(pipeline.getSentMediaUrls()).toStrictEqual([]);

    pipeline.enqueue({ text: "caption", mediaUrl: "file:///a.ogg" });
    pipeline.enqueue({ mediaUrls: ["file:///b.ogg", "file:///c.ogg"] });
    await pipeline.flush({ force: true });

    expect(pipeline.getSentMediaUrls()).toEqual([
      "file:///a.ogg",
      "file:///b.ogg",
      "file:///c.ogg",
    ]);
  });

  it("keeps separate deliveries for distinct rich-only payloads", async () => {
    const sent: Array<{ presentation?: unknown }> = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push({ presentation: payload.presentation });
      },
      timeoutMs: 5000,
    });

    pipeline.enqueue({
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "Approve", value: "approve" }] }],
      },
    });
    pipeline.enqueue({
      presentation: {
        blocks: [{ type: "buttons", buttons: [{ label: "Reject", value: "reject" }] }],
      },
    });
    await pipeline.flush({ force: true });

    expect(sent).toHaveLength(2);
  });

  it("bypasses text coalescing for rich-only payloads", async () => {
    const sent: Array<{ presentation?: unknown }> = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push({ presentation: payload.presentation });
      },
      timeoutMs: 5000,
      coalescing: {
        minChars: 1,
        maxChars: 200,
        idleMs: 0,
        joiner: "\n\n",
      },
    });

    const presentation = {
      blocks: [{ type: "buttons" as const, buttons: [{ label: "Open", value: "open" }] }],
    };

    pipeline.enqueue({ presentation });
    await pipeline.flush({ force: true });

    expect(sent).toEqual([{ presentation }]);
  });

  it("merges coalesced text into a following media payload", async () => {
    const sent: Array<{ text?: string; mediaUrls?: string[] }> = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push({ text: payload.text, mediaUrls: payload.mediaUrls });
      },
      timeoutMs: 5000,
      coalescing: {
        minChars: 1,
        maxChars: 200,
        idleMs: 0,
        joiner: " ",
      },
    });

    pipeline.enqueue({ text: "Preview" });
    pipeline.enqueue({ text: "below" });
    pipeline.enqueue({ mediaUrls: ["file:///photo.png"] });
    await pipeline.flush({ force: true });

    expect(sent).toEqual([{ text: "Preview below", mediaUrls: ["file:///photo.png"] }]);
    expect(pipeline.getSentMediaUrls()).toEqual(["file:///photo.png"]);
    expect(pipeline.hasSentPayload({ text: "Preview below" })).toBe(true);
  });

  it("keeps media separate across assistant message boundaries", async () => {
    const sent: Array<{ text?: string; mediaUrls?: string[] }> = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push({ text: payload.text, mediaUrls: payload.mediaUrls });
      },
      timeoutMs: 5000,
      coalescing: {
        minChars: 1,
        maxChars: 200,
        idleMs: 0,
        joiner: " ",
      },
    });

    pipeline.enqueue(
      setReplyPayloadMetadata({ text: "First block" }, { assistantMessageIndex: 0 }),
    );
    pipeline.enqueue(
      setReplyPayloadMetadata({ mediaUrls: ["file:///photo.png"] }, { assistantMessageIndex: 1 }),
    );
    await pipeline.flush({ force: true });

    expect(sent).toEqual([
      { text: "First block", mediaUrls: undefined },
      { text: undefined, mediaUrls: ["file:///photo.png"] },
    ]);
  });

  it("does not track media when text-only blocks are delivered", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "hello" });
    pipeline.enqueue({ text: "world" });
    await pipeline.flush({ force: true });

    expect(pipeline.getSentMediaUrls()).toStrictEqual([]);
  });

  it("does not coalesce logical assistant blocks across assistantMessageIndex boundaries", async () => {
    const sent: string[] = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push(payload.text ?? "");
      },
      timeoutMs: 5000,
      coalescing: {
        minChars: 100,
        maxChars: 200,
        idleMs: 1000,
        joiner: "\n\n",
      },
    });

    pipeline.enqueue(setReplyPayloadMetadata({ text: "Alpha" }, { assistantMessageIndex: 0 }));
    pipeline.enqueue(setReplyPayloadMetadata({ text: "Beta" }, { assistantMessageIndex: 1 }));
    await pipeline.flush({ force: true });

    expect(sent).toEqual(["Alpha", "Beta"]);
  });
});

describe("createBlockReplyPipeline content coverage dedup", () => {
  it("matches final assembled text to successfully streamed text chunks after abort", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (_payload, options) => {
        callCount += 1;
        if (callCount === 3) {
          await waitForAbort(options?.abortSignal);
        }
      },
      timeoutMs: 1,
    });

    pipeline.enqueue({ text: "First paragraph." });
    pipeline.enqueue({ text: "Second paragraph." });
    pipeline.enqueue({ text: "Third paragraph." });
    const flushing = pipeline.flush({ force: true });
    await vi.advanceTimersByTimeAsync(1);
    await flushing;

    expect(pipeline.didStream()).toBe(true);
    expect(pipeline.isAborted()).toBe(true);
    expect(pipeline.hasSentPayload({ text: "First paragraph.\n\nSecond paragraph." })).toBe(true);
  });

  it("does not match final assembled text with content that was not streamed", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (_payload, options) => {
        callCount += 1;
        if (callCount === 2) {
          await waitForAbort(options?.abortSignal);
        }
      },
      timeoutMs: 1,
    });

    pipeline.enqueue({ text: "First paragraph." });
    pipeline.enqueue({ text: "Second paragraph." });
    const flushing = pipeline.flush({ force: true });
    await vi.advanceTimersByTimeAsync(1);
    await flushing;

    expect(pipeline.didStream()).toBe(true);
    expect(pipeline.isAborted()).toBe(true);
    expect(pipeline.hasSentPayload({ text: "First paragraph.\n\nSecond paragraph." })).toBe(false);
  });

  it("keeps status notices out of streamed final-content accounting", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "1. Inspect\n2. Patch", isStatusNotice: true });
    await pipeline.flush({ force: true });

    expect(pipeline.didStream()).toBe(false);
    expect(pipeline.hasSentPayload({ text: "1. Inspect\n2. Patch" })).toBe(false);
  });

  it("does not let a status notice de-dupe later matching assistant content", async () => {
    const sent: Array<{ text?: string; isStatusNotice?: boolean }> = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push({ text: payload.text, isStatusNotice: payload.isStatusNotice });
      },
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "same text", isStatusNotice: true });
    pipeline.enqueue({ text: "same text" });
    await pipeline.flush({ force: true });

    expect(sent).toEqual([{ text: "same text", isStatusNotice: true }, { text: "same text" }]);
    expect(pipeline.didStream()).toBe(true);
    expect(pipeline.hasSentPayload({ text: "same text" })).toBe(true);
  });

  it("does not suppress media payloads through streamed text coverage", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "Description" });
    await pipeline.flush({ force: true });

    expect(pipeline.hasSentPayload({ text: "Description", mediaUrl: "file:///photo.jpg" })).toBe(
      false,
    );
  });

  it("does not suppress unrelated shorter text that appears inside streamed content", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "Here is a summary." });
    await pipeline.flush({ force: true });

    expect(pipeline.hasSentPayload({ text: "summary" })).toBe(false);
  });
});
