/** Tests block reply pipeline buffering, dedupe, and final flush behavior. */
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  createAudioAsVoiceBuffer,
  createBlockReplyContentKey,
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
    expect(createBlockReplyContentKey({ location: { latitude: 1, longitude: 2 } })).not.toBe(
      createBlockReplyContentKey({ location: { latitude: 3, longitude: 4 } }),
    );
  });
});

describe("createBlockReplyPipeline dedup with threading", () => {
  it("keeps an un-aborted delivery signal when timeouts are disabled", async () => {
    let deliverySignal: AbortSignal | undefined;
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (_payload, options) => {
        deliverySignal = options?.abortSignal;
      },
      timeoutMs: 0,
    });

    pipeline.enqueue({ text: "response text" });
    await pipeline.flush({ force: true });

    expect(deliverySignal).toBeDefined();
    expect(deliverySignal?.aborted).toBe(false);
  });

  it("does not count reasoning or commentary as a terminal reply", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "reasoning", isReasoning: true });
    pipeline.enqueue({ text: "commentary", isCommentary: true });
    pipeline.enqueue({ audioAsVoice: true });
    await pipeline.flush({ force: true });

    expect(pipeline.didStream()).toBe(true);
    expect(pipeline.didStreamTerminalReply?.()).toBe(false);

    pipeline.enqueue({ text: "final answer" });
    await pipeline.flush({ force: true });

    expect(pipeline.didStreamTerminalReply?.()).toBe(true);
  });

  it.each([
    { lane: "reasoning", payload: { text: "Same answer", isReasoning: true } },
    { lane: "commentary", payload: { text: "Same answer", isCommentary: true } },
  ])("keeps $lane separate from a matching visible answer", async ({ payload }) => {
    for (const coalescing of [
      undefined,
      { minChars: 100, maxChars: 200, idleMs: 0, joiner: " " },
    ]) {
      const sent: ReplyPayload[] = [];
      const pipeline = createBlockReplyPipeline({
        onBlockReply: async (reply) => {
          sent.push(reply);
        },
        timeoutMs: 5000,
        ...(coalescing ? { coalescing } : {}),
      });

      pipeline.enqueue(payload);
      pipeline.enqueue({ text: "Same answer" });
      await pipeline.flush({ force: true });

      expect(sent).toEqual([payload, { text: "Same answer" }]);
      expect(pipeline.didStreamTerminalReply?.()).toBe(true);
    }
  });

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
    expect(pipeline.hasSentExactPayload?.({ text: "response text" })).toBe(true);
    expect(pipeline.hasSentExactPayload?.({ text: "response text", replyToId: "other-id" })).toBe(
      true,
    );
  });

  it("keeps exact payload evidence separate from streamed text coverage", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "constx=1" });
    await pipeline.flush({ force: true });

    expect(pipeline.hasSentPayload({ text: "const x = 1" })).toBe(true);
    expect(pipeline.hasSentExactPayload?.({ text: "const x = 1" })).toBe(false);
    expect(
      pipeline.hasSentExactPayload?.({
        text: "constx=1",
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
        },
      }),
    ).toBe(false);
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

  it.each([
    {
      name: "coalesced text on both sides of audio",
      payloads: [{ text: "Before" }, { mediaUrl: "file:///voice.ogg" }, { text: "After" }],
      expected: [{ text: "Before" }, { mediaUrl: "file:///voice.ogg" }, { text: "After" }],
    },
    {
      name: "audio before a following image",
      payloads: [{ mediaUrls: ["file:///voice.ogg"] }, { mediaUrls: ["file:///photo.png"] }],
      expected: [{ mediaUrls: ["file:///voice.ogg"] }, { mediaUrls: ["file:///photo.png"] }],
    },
    {
      name: "a late voice marker before following text",
      payloads: [{ mediaUrl: "file:///voice.ogg" }, { text: "After", audioAsVoice: true }],
      expected: [
        { mediaUrl: "file:///voice.ogg", audioAsVoice: true },
        { text: "After", audioAsVoice: true },
      ],
    },
    {
      name: "distinct portable location replies",
      payloads: [
        { location: { latitude: 1, longitude: 2 } },
        { location: { latitude: 3, longitude: 4 } },
      ],
      expected: [
        { location: { latitude: 1, longitude: 2 } },
        { location: { latitude: 3, longitude: 4 } },
      ],
    },
    {
      name: "normal and round videos sharing the same media",
      payloads: [
        { mediaUrl: "file:///reply.mp4" },
        { mediaUrl: "file:///reply.mp4", videoAsNote: false },
        { mediaUrl: "file:///reply.mp4", videoAsNote: true },
      ],
      expected: [
        { mediaUrl: "file:///reply.mp4" },
        { mediaUrl: "file:///reply.mp4", videoAsNote: true },
      ],
    },
  ])("preserves streamed delivery order for $name", async ({ payloads, expected }) => {
    const sent: ReplyPayload[] = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push(payload);
      },
      timeoutMs: 5000,
      coalescing: {
        minChars: 1,
        maxChars: 200,
        idleMs: 0,
        joiner: " ",
      },
      buffer: createAudioAsVoiceBuffer({
        isAudioPayload: (payload) =>
          [payload.mediaUrl, ...(payload.mediaUrls ?? [])].some((url) => url?.endsWith(".ogg")),
      }),
    });

    for (const payload of payloads) {
      pipeline.enqueue(payload);
    }
    await pipeline.flush({ force: true });

    expect(sent).toHaveLength(expected.length);
    expect(sent).toMatchObject(expected);
    expect(pipeline.getSentMediaUrls()).toEqual(
      Array.from(
        new Set(
          expected.flatMap((payload) =>
            "mediaUrls" in payload
              ? payload.mediaUrls
              : "mediaUrl" in payload
                ? [payload.mediaUrl]
                : [],
          ),
        ),
      ),
    );
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

  it.each([
    { name: "reply-to-current text", routing: { replyToCurrent: true }, media: false },
    { name: "explicit-tag text", routing: { replyToTag: true }, media: false },
    { name: "reply-to-current media", routing: { replyToCurrent: true }, media: true },
    { name: "explicit-tag media", routing: { replyToTag: true }, media: true },
  ] as const)(
    "preserves explicit reply routing and metadata for $name",
    async ({ routing, media }) => {
      const sent: ReplyPayload[] = [];
      const pipeline = createBlockReplyPipeline({
        onBlockReply: async (payload) => {
          sent.push(payload);
        },
        timeoutMs: 5000,
        coalescing: { minChars: 1, maxChars: 200, idleMs: 0, joiner: " " },
      });

      pipeline.enqueue(
        setReplyPayloadMetadata(
          { text: "Explicit answer", replyToId: "100", ...routing },
          { assistantMessageIndex: 7, replyToIdExplicit: true },
        ),
      );
      if (media) {
        pipeline.enqueue(
          setReplyPayloadMetadata(
            {
              mediaUrls: ["file:///photo.png"],
              replyToId: "100",
              replyToCurrent: undefined,
              replyToTag: undefined,
            },
            { assistantMessageIndex: 7, assistantTranscriptMediaUrls: ["file:///photo.png"] },
          ),
        );
      }
      await pipeline.flush({ force: true });

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        text: "Explicit answer",
        replyToId: "100",
        ...routing,
        ...(media ? { mediaUrls: ["file:///photo.png"] } : {}),
      });
      expect(sent.map(getReplyPayloadMetadata)).toEqual([
        expect.objectContaining({
          assistantMessageIndex: 7,
          replyToIdExplicit: true,
          ...(media ? { assistantTranscriptMediaUrls: ["file:///photo.png"] } : {}),
        }),
      ]);
    },
  );

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

  it("preserves assistant metadata on coalesced text flushes", async () => {
    const sent: Array<{ assistantMessageIndex?: number; text?: string }> = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        sent.push({
          assistantMessageIndex: getReplyPayloadMetadata(payload)?.assistantMessageIndex,
          text: payload.text,
        });
      },
      timeoutMs: 5000,
      coalescing: {
        minChars: 100,
        maxChars: 200,
        idleMs: 1000,
        joiner: " ",
      },
    });

    pipeline.enqueue(setReplyPayloadMetadata({ text: "Alpha" }, { assistantMessageIndex: 0 }));
    pipeline.enqueue(setReplyPayloadMetadata({ text: "Beta" }, { assistantMessageIndex: 0 }));
    await pipeline.flush({ force: true });

    expect(sent).toEqual([{ assistantMessageIndex: 0, text: "Alpha Beta" }]);
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

  it.each([
    { lane: "reasoning", payload: { text: "Same answer", isReasoning: true } },
    { lane: "commentary", payload: { text: "Same answer", isCommentary: true } },
  ])("keeps $lane out of visible final-content accounting", async ({ payload }) => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue(payload);
    await pipeline.flush({ force: true });

    expect(pipeline.didStream()).toBe(true);
    expect(pipeline.didStreamTerminalReply?.()).toBe(false);
    expect(pipeline.hasSentPayload({ text: "Same answer" })).toBe(false);
    expect(pipeline.hasSentExactPayload?.({ text: "Same answer" })).toBe(false);
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

  it("clamps oversized delivery timeouts before arming timers", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const observedTimeouts: number[] = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (_payload, options) => {
        observedTimeouts.push(options?.timeoutMs ?? 0);
        await waitForAbort(options?.abortSignal);
      },
      timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
    });

    pipeline.enqueue({ text: "slow block" });
    const flushing = pipeline.flush({ force: true });
    await Promise.resolve();

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    expect(observedTimeouts).toEqual([MAX_TIMER_TIMEOUT_MS]);

    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
    await flushing;

    expect(pipeline.isAborted()).toBe(true);
    setTimeoutSpy.mockRestore();
  });
});
