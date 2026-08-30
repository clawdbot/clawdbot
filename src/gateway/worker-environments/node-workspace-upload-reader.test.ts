import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { RequestByteReader } from "./node-workspace-upload-reader.js";

function createReader(chunks: Buffer[]): RequestByteReader {
  const request = Readable.from(chunks) as unknown as IncomingMessage;
  return new RequestByteReader(request, new AbortController().signal, () => {});
}

describe("workspace upload byte stream", () => {
  it.each(["coalesced", "fragmented"])(
    "preserves consecutive headers and bodies in %s chunks",
    async (chunking) => {
      const bodies = [
        Buffer.from("base manifest"),
        Buffer.from("current manifest"),
        Buffer.from("file\0bytes"),
      ];
      const headers = bodies.map((body, index) => {
        const header = Buffer.alloc(index === 2 ? 8 : 4);
        if (header.length === 8) {
          header.writeBigUInt64BE(BigInt(body.length));
        } else {
          header.writeUInt32BE(body.length);
        }
        return header;
      });
      const parts = bodies.flatMap((body, index) => [headers[index]!, body]);
      const payload = Buffer.concat(parts);
      const chunks =
        chunking === "coalesced" ? [payload] : Array.from(payload, (byte) => Buffer.from([byte]));
      const reader = createReader(chunks);

      for (const part of parts) {
        await expect(reader.readExactly(part.length)).resolves.toEqual(part);
      }
      await expect(reader.readExactly(0)).resolves.toEqual(Buffer.alloc(0));
      await expect(reader.assertEnd()).resolves.toBeUndefined();
      expect(reader.bytesRead).toBe(payload.length);
    },
  );

  it("rejects premature EOF across chunk boundaries", async () => {
    const reader = createReader([Buffer.from("ab"), Buffer.from("c")]);

    await expect(reader.readExactly(4)).rejects.toThrow("ended before its declared payload");
  });

  it.each(["buffered", "next chunk"])("rejects trailing bytes in the %s suffix", async (suffix) => {
    const reader = createReader(
      suffix === "buffered" ? [Buffer.from("abc!")] : [Buffer.from("abc"), Buffer.from("!")],
    );

    await expect(reader.readExactly(3)).resolves.toEqual(Buffer.from("abc"));
    await expect(reader.assertEnd()).rejects.toThrow("contains trailing bytes");
  });
});
