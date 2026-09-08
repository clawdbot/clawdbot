import { describe, expect, it, vi } from "vitest";
import { copyPlaybackInputBounded } from "./playback-input.js";

function reader(contents: Buffer, maxRead = Number.POSITIVE_INFINITY) {
  return {
    read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => ({
      bytesRead: contents.copy(buffer, offset, position, position + Math.min(length, maxRead)),
    })),
  };
}

describe("bounded playback input copy", () => {
  it("preserves every byte across short reads and partial positioned writes", async () => {
    const contents = Buffer.from(
      "A short read must finish all its writes before reusing the scratch buffer. 🦞",
    );
    const source = reader(contents, 7);
    const actual = Buffer.alloc(contents.length);
    const target = {
      write: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => ({
        bytesWritten: buffer.copy(actual, position, offset, offset + Math.min(length, 3)),
      })),
    };
    await copyPlaybackInputBounded(source, target, contents.length, contents.length);
    expect(actual).toEqual(contents);
    expect(source.read.mock.calls.at(-1)?.[3]).toBe(contents.length);
    expect(target.write.mock.calls.length).toBeGreaterThan(source.read.mock.calls.length);
  });

  it("copies a file larger than the scratch buffer without dropping a tail", async () => {
    const contents = Buffer.from("0123456789".repeat(20_000) + "tail");
    const source = reader(contents);
    const actual = Buffer.alloc(contents.length);
    await copyPlaybackInputBounded(
      source,
      {
        write: async (buffer, offset, length, position) => ({
          bytesWritten: buffer.copy(actual, position, offset, offset + length),
        }),
      },
      contents.length,
      contents.length,
    );
    expect(actual).toEqual(contents);
    expect(source.read.mock.calls.length).toBeGreaterThan(2);
  });

  it.each([
    { name: "growth", contents: "123456789", expected: 5, cap: 5, readBytes: 6 },
    { name: "truncation", contents: "1234", expected: 5, cap: 5, readBytes: 4 },
    { name: "byte cap", contents: "123456789", expected: 8, cap: 5, readBytes: 6 },
  ])(
    "rejects $name with only the bounded overflow probe",
    async ({ contents, expected, cap, readBytes }) => {
      const source = reader(Buffer.from(contents));
      const target = {
        write: async (_buffer: Buffer, _offset: number, length: number) => ({
          bytesWritten: length,
        }),
      };
      await expect(copyPlaybackInputBounded(source, target, expected, cap)).rejects.toThrow(
        "Playback source changed during bounded read",
      );
      expect(
        (await Promise.all(source.read.mock.results.map((result) => result.value))).reduce(
          (sum, result) => sum + result.bytesRead,
          0,
        ),
      ).toBe(readBytes);
    },
  );

  it("rejects a write that cannot make progress", async () => {
    const write = vi.fn(async () => ({ bytesWritten: 0 }));
    await expect(
      copyPlaybackInputBounded(reader(Buffer.from("bytes")), { write }, 5, 5),
    ).rejects.toThrow("made no progress");
    expect(write).toHaveBeenCalledOnce();
  });

  it.each(["read", "write"] as const)("preserves the original %s failure", async (operation) => {
    const error = new Error("synthetic filesystem failure");
    const source =
      operation === "read"
        ? {
            read: async () => {
              throw error;
            },
          }
        : reader(Buffer.from("bytes"));
    const target = {
      write: vi.fn(async () => {
        throw error;
      }),
    };
    await expect(copyPlaybackInputBounded(source, target, 5, 5)).rejects.toBe(error);
    if (operation === "read") {
      expect(target.write).not.toHaveBeenCalled();
    }
  });
});
