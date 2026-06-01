import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readByteStreamWithLimit } from "./read-byte-stream-with-limit.js";

describe("readByteStreamWithLimit", () => {
  it("returns concatenated bytes up to the limit", async () => {
    const buffer = await readByteStreamWithLimit(Readable.from([Buffer.from("ab"), "cd"]), {
      maxBytes: 4,
    });

    expect(buffer).toEqual(Buffer.from("abcd"));
  });

  it("throws and destroys node streams after overflow", async () => {
    const stream = Readable.from([Buffer.alloc(4), Buffer.alloc(4)]);
    const destroySpy = vi.spyOn(stream, "destroy");

    await expect(
      readByteStreamWithLimit(stream, {
        maxBytes: 7,
        onOverflow: ({ size, maxBytes }) => new Error(`too large ${size}/${maxBytes}`),
      }),
    ).rejects.toThrow("too large 8/7");
    expect(destroySpy).toHaveBeenCalled();
  });
});
