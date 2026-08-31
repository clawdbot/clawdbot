import { describe, expect, it } from "vitest";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";

function blockFor(text: string, assistantMessageIndex: number) {
  return setReplyPayloadMetadata({ text }, { assistantMessageIndex });
}

describe("block reply pipeline multi-assistant-message suppression", () => {
  it("recognizes each fully-streamed message across a multi-message turn", async () => {
    const sent: string[] = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        if (payload.text) {
          sent.push(payload.text);
        }
      },
      timeoutMs: 5000,
    });

    pipeline.enqueue(blockFor("Alpha one.", 0));
    pipeline.enqueue(blockFor("Alpha two.", 0));
    pipeline.enqueue(blockFor("Beta one.", 1));
    pipeline.enqueue(blockFor("Beta two.", 1));
    await pipeline.flush({ force: true });

    expect(sent).toEqual(["Alpha one.", "Alpha two.", "Beta one.", "Beta two."]);
    expect(pipeline.hasSentPayload({ text: "Alpha one. Alpha two." })).toBe(true);
    expect(pipeline.hasSentPayload({ text: "Beta one. Beta two." })).toBe(true);
  });

  it("does not treat one message as covering another message's text", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue(blockFor("Alpha one.", 0));
    pipeline.enqueue(blockFor("Alpha two.", 0));
    pipeline.enqueue(blockFor("Beta one.", 1));
    pipeline.enqueue(blockFor("Beta two.", 1));
    await pipeline.flush({ force: true });

    expect(pipeline.hasSentPayload({ text: "Alpha one. Alpha two. Beta one. Beta two." })).toBe(
      false,
    );
  });

  it("delivers matching text from separate assistant messages", async () => {
    for (const coalescing of [
      undefined,
      { minChars: 100, maxChars: 200, idleMs: 0, joiner: " " },
    ]) {
      const sent: string[] = [];
      const pipeline = createBlockReplyPipeline({
        onBlockReply: async (payload) => {
          if (payload.text) {
            sent.push(payload.text);
          }
        },
        timeoutMs: 5000,
        ...(coalescing ? { coalescing } : {}),
      });

      pipeline.enqueue(blockFor("Same answer", 0));
      pipeline.enqueue(blockFor("Same answer", 1));
      await pipeline.flush({ force: true });

      expect(sent).toEqual(["Same answer", "Same answer"]);
    }
  });

  it.each([false, true])(
    "keeps a matching final answer from a different assistant message (coalescing=%s)",
    async (coalescingEnabled) => {
      const pipeline = createBlockReplyPipeline({
        onBlockReply: async () => {},
        timeoutMs: 5000,
        ...(coalescingEnabled
          ? { coalescing: { minChars: 100, maxChars: 200, idleMs: 0, joiner: " " } }
          : {}),
      });

      pipeline.enqueue(blockFor("Same answer", 0));
      await pipeline.flush({ force: true });
      const finalPayload = blockFor("Same answer", 1);
      const { replyPayloads } = await buildReplyPayloads({
        payloads: [finalPayload],
        isHeartbeat: false,
        didLogHeartbeatStrip: false,
        blockStreamingEnabled: true,
        blockReplyPipeline: pipeline,
        replyToMode: "off",
      });

      expect(pipeline.hasSentExactPayload?.(finalPayload)).toBe(false);
      expect(pipeline.hasSentPayload(finalPayload)).toBe(false);
      expect(replyPayloads).toEqual([expect.objectContaining({ text: "Same answer" })]);
    },
  );

  it("suppresses a single message split into multiple blocks", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
    });

    pipeline.enqueue(blockFor("Gamma one.", 0));
    pipeline.enqueue(blockFor("Gamma two.", 0));
    await pipeline.flush({ force: true });

    expect(pipeline.hasSentPayload({ text: "Gamma one. Gamma two." })).toBe(true);
  });
});
