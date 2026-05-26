import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createDiscordOpusEncodeStream,
  decodeOpusStream,
  decodeOpusStreamChunks,
} from "./audio.js";

async function collectBuffers(stream: Readable): Promise<Buffer[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return chunks;
}

describe("discord voice opus codec", () => {
  it("defaults to libopus-wasm for receive decoding", async () => {
    const verbose: string[] = [];
    const warnings: string[] = [];

    const decoded = await decodeOpusStream(Readable.from([]), {
      onVerbose: (message) => verbose.push(message),
      onWarn: (message) => warnings.push(message),
    });

    expect(decoded.length).toBe(0);
    expect(verbose).toContain("opus decoder: libopus-wasm");
    expect(warnings).toEqual([]);
  });

  it("encodes raw Discord PCM into Opus packets for realtime playback", async () => {
    const encoder = createDiscordOpusEncodeStream();
    const packetsPromise = collectBuffers(encoder);

    encoder.end(Buffer.alloc(960 * 2 * 2));
    const packets = await packetsPromise;

    expect(packets).toHaveLength(1);
    expect(packets[0]?.length).toBeGreaterThan(0);

    const decoded = await decodeOpusStream(Readable.from(packets), {
      onVerbose: vi.fn(),
      onWarn: vi.fn(),
    });
    expect(decoded.length).toBe(960 * 2 * 2);
  });

  it("pads final partial PCM frames before encoding", async () => {
    const encoder = createDiscordOpusEncodeStream();
    const packetsPromise = collectBuffers(encoder);

    encoder.end(Buffer.alloc((960 * 2 * 2) / 2));
    const packets = await packetsPromise;

    expect(packets).toHaveLength(1);
  });

  it("surfaces chunk decode stream failures to callers", async () => {
    const err = new Error("memory access out of bounds");
    const onError = vi.fn();
    const stream = new Readable({
      read() {
        this.destroy(err);
      },
    });

    await decodeOpusStreamChunks(stream, {
      onChunk: vi.fn(),
      onError,
      onVerbose: vi.fn(),
      onWarn: vi.fn(),
    });

    expect(onError).toHaveBeenCalledWith(err);
  });
});
