// Read tool tests cover bounded file reads and safe, actionable continuation.
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { createReadToolDefinition } from "./read.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./truncate.js";

const decodeWindowsTextFileBufferMock = vi.hoisted(() =>
  vi.fn(({ buffer }: { buffer: Buffer }) => buffer.toString("utf8")),
);
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

const plainTheme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as never;

function renderReadCall(args: { path: string; offset?: number; limit?: number }): string {
  const tool = createReadToolDefinition("/workspace");
  const component = tool.renderCall?.(args, plainTheme, {
    lastComponent: undefined,
    expanded: true,
    cwd: "/workspace",
  } as never);
  return component?.render(120).join("\n").trimEnd() ?? "";
}

describe("read tool", () => {
  beforeEach(() => {
    decodeWindowsTextFileBufferMock.mockReset();
    decodeWindowsTextFileBufferMock.mockImplementation(({ buffer }) => buffer.toString("utf8"));
  });

  it("describes image reads as private model context", () => {
    const description = createReadToolDefinition("/workspace").description;

    expect(description).toContain("images attach to model context");
    expect(description).not.toContain("images attach.");
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

  it("explains that directory paths must be listed before reading a file", async () => {
    const tempDir = tempDirs.make("openclaw-read-directory-");
    const tool = createReadToolDefinition(tempDir);

    await expect(
      tool.execute("call-directory", { path: "." }, undefined, undefined, {} as never),
    ).rejects.toThrow(
      "Read requires a file path, but . is a directory. List the directory, then read a specific file.",
    );
  });

  it.runIf(process.platform !== "win32")(
    "refuses a FIFO without waiting for a writer",
    async () => {
      const tempDir = tempDirs.make("openclaw-read-fifo-");
      const fifoPath = path.join(tempDir, "live.pipe");
      expect(spawnSync("mkfifo", [fifoPath]).status).toBe(0);
      const tool = createReadToolDefinition(tempDir);
      const read = tool.execute("call-fifo", { path: fifoPath }, undefined, undefined, {} as never);
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        read.then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        ),
        new Promise<{ kind: "timeout" }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "timeout" }), 1_000);
        }),
      ]);
      if (timer) {
        clearTimeout(timer);
      }

      if (outcome.kind === "timeout") {
        const writer = spawn(
          "/bin/sh",
          ["-c", 'while :; do printf x > "$1"; done', "openclaw-read-fifo", fifoPath],
          { stdio: "ignore" },
        );
        const writerExit = new Promise<void>((resolve) => {
          writer.once("exit", () => resolve());
        });
        await Promise.race([
          read.catch(() => undefined),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 2_000);
          }),
        ]);
        writer.kill("SIGKILL");
        await writerExit;
      }

      expect(outcome).toMatchObject({
        kind: "rejected",
        error: { message: expect.stringMatching(/regular file/i) },
      });
    },
  );

  it("describes empty files instead of returning blank content", async () => {
    const tempDir = tempDirs.make("openclaw-read-empty-");
    await fs.writeFile(path.join(tempDir, "empty.txt"), "");
    const tool = createReadToolDefinition(tempDir);

    const result = await tool.execute(
      "call-empty",
      { path: "empty.txt" },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe("File is empty (0 bytes).");
  });

  it("reports the byte count when a BOM-only file decodes to empty text", async () => {
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from([0xef, 0xbb, 0xbf]),
      },
    });

    const result = await tool.execute(
      "call-bom-only",
      { path: "bom.txt" },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe("File contains no readable text (3 bytes).");
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("describes %s-only files instead of returning blank content", async (_label, contents) => {
    const tempDir = tempDirs.make("openclaw-read-blank-line-");
    await fs.writeFile(path.join(tempDir, "blank.txt"), contents);
    const tool = createReadToolDefinition(tempDir);

    const result = await tool.execute(
      "call-blank-line",
      { path: "blank.txt" },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe("File contains 1 blank line.");
  });

  it("applies line limits before describing blank-only content", async () => {
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from("\n\n"),
      },
    });

    const result = await tool.execute(
      "call-blank-range",
      { path: "blank.txt", limit: 1 },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe(
      "Selected range contains 1 blank line.\n\n[1 more line in file. Use offset=2 to continue.]",
    );
  });

  it("does not classify plaintext from a custom backend by its extension", async () => {
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from("plain text"),
      },
    });

    const result = await tool.execute(
      "call-custom-png",
      { path: "report.png" },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe("plain text");
  });

  it("resolves one Unicode-equivalent filename and names the correction", async () => {
    const tempDir = tempDirs.make("openclaw-read-unicode-");
    const storedName = "re\u0301sume\u0301 3.04\u202fPM d\u2019accord.txt";
    await fs.writeFile(path.join(tempDir, storedName), "matched");
    const tool = createReadToolDefinition(tempDir);

    const result = await tool.execute(
      "call-unicode",
      { path: "r\u00e9sum\u00e9 3.04 PM d'accord.txt" },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toContain("Resolved filename");
    expect(textContent(result)).toContain("matched");
  });

  it("counts filename-resolution notes inside the complete 50 KiB read ceiling", async () => {
    const tempDir = tempDirs.make("openclaw-read-unicode-budget-");
    const storedName = "re\u0301sume\u0301 3.04\u202fPM d\u2019accord.txt";
    await fs.writeFile(path.join(tempDir, storedName), "x".repeat(DEFAULT_MAX_BYTES));
    const tool = createReadToolDefinition(tempDir);

    const result = await tool.execute(
      "call-unicode-budget",
      { path: "r\u00e9sum\u00e9 3.04 PM d'accord.txt" },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toContain("Resolved filename");
    expect(textContent(result)).toContain("cursor=");
    expect(Buffer.byteLength(textContent(result), "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  });

  it("keeps an exact Unicode spelling ahead of equivalent filenames", async () => {
    const tempDir = tempDirs.make("openclaw-read-unicode-exact-");
    await fs.writeFile(path.join(tempDir, "report\u00a0.txt"), "exact");
    await fs.writeFile(path.join(tempDir, "report .txt"), "equivalent");
    const tool = createReadToolDefinition(tempDir);

    const result = await tool.execute(
      "call-unicode-exact",
      { path: "report\u00a0.txt" },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe("exact");
  });

  it("refuses ambiguous Unicode-equivalent filenames", async () => {
    const tempDir = tempDirs.make("openclaw-read-unicode-ambiguous-");
    await fs.writeFile(path.join(tempDir, "d'accord.txt"), "straight");
    await fs.writeFile(path.join(tempDir, "d\u2019accord.txt"), "curly");
    const tool = createReadToolDefinition(tempDir);

    await expect(
      tool.execute(
        "call-unicode-ambiguous",
        { path: "d\u2018accord.txt" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/ambiguous.*d'accord\.txt.*d\u2019accord\.txt/i);
  });

  it("suggests a close filename without reading it", async () => {
    const tempDir = tempDirs.make("openclaw-read-suggestion-");
    await fs.writeFile(path.join(tempDir, "AGENTS.md"), "instructions");
    const tool = createReadToolDefinition(tempDir);

    await expect(
      tool.execute("call-suggestion", { path: "AGENT.md" }, undefined, undefined, {} as never),
    ).rejects.toThrow(/Did you mean: AGENTS\.md\?/);
  });

  it.each([
    {
      name: "minified JSON",
      text: JSON.stringify({ generated: "x".repeat(DEFAULT_MAX_BYTES * 2) }),
    },
    { name: "astral emoji", text: `prefix${"🦞".repeat(DEFAULT_MAX_BYTES)}` },
  ])("continues an oversized $name line without splitting characters", async ({ text }) => {
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        detectImageMimeType: async () => null,
        readFile: async () => Buffer.from(text),
      },
    });

    let reconstructed = "";
    let cursor: number | undefined;
    for (let page = 0; page < 12; page += 1) {
      const args = { path: "generated.json", ...(cursor === undefined ? {} : { cursor }) };
      const result = await tool.execute(`call-${page}`, args, undefined, undefined, {} as never);
      const output = textContent(result);
      expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
      expect(output).not.toMatch(/\b(?:bash|sed|head)\b/);
      if (result.details.kind !== "truncated") {
        reconstructed += output;
        break;
      }
      const continuation = (
        result.details as { continuation?: { kind: string; offset: number; cursor: number } }
      ).continuation;
      expect(continuation).toMatchObject({ kind: "cursor", offset: 1 });
      expect(continuation?.cursor).toBeGreaterThan(cursor ?? 0);
      expect(output).toContain(`offset=1, cursor=${continuation?.cursor}`);
      reconstructed += output.replace(/\n\n\[Showing[^\]]*\]$/, "");
      cursor = continuation?.cursor;
    }

    expect(reconstructed).toBe(text);
  });

  it("rejects an intra-line cursor inside a UTF-16 surrogate pair", async () => {
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from("a🦞b"),
      },
    });

    await expect(
      tool.execute(
        "call-surrogate",
        { path: "emoji.txt", cursor: 2 },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/cursor.*surrogate.*(?:1|3)/i);
  });

  it.each([4, 5])("explains an intra-line cursor at or past EOF (%s)", async (cursor) => {
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from("done"),
      },
    });

    const result = await tool.execute(
      "call-cursor-eof",
      { path: "done.txt", cursor },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toMatch(/cursor.*(?:end|beyond).*line 1/i);
  });

  it("finishes an oversized selected line before continuing at the next line", async () => {
    const longLine = "x".repeat(DEFAULT_MAX_BYTES + 100);
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from(`before\n${longLine}\nafter`),
      },
    });

    const first = await tool.execute(
      "call-line-first",
      { path: "lines.txt", offset: 2, limit: 1 },
      undefined,
      undefined,
      {} as never,
    );
    const continuation = (
      first.details as { continuation?: { kind: string; offset: number; cursor: number } }
    ).continuation;
    expect(continuation).toMatchObject({ kind: "cursor", offset: 2 });

    const second = await tool.execute(
      "call-line-second",
      { path: "lines.txt", offset: 2, cursor: continuation?.cursor, limit: 1 },
      undefined,
      undefined,
      {} as never,
    );
    const firstChunk = textContent(first).replace(/\n\n\[Showing[^\]]*\]$/, "");
    const secondChunk = textContent(second).replace(/\n\n\[\d+ more lines[^\]]*\]$/, "");
    expect(`${firstChunk}${secondChunk}`).toBe(longLine);
    expect(textContent(second)).toContain("offset=3");
  });

  it("preserves ordinary multi-line selection and trailing newlines", async () => {
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        readFile: async () => Buffer.from("first\r\nsecond\r\nthird\r\n"),
      },
    });

    const selected = await tool.execute(
      "call-lines",
      { path: "lines.txt", offset: 2 },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(selected)).toBe("second\nthird\n");
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

  it.each([
    { limit: -1, range: ":1-1" },
    { limit: 1.5, range: ":1-1" },
    { limit: Number.POSITIVE_INFINITY, range: `:1-${DEFAULT_MAX_LINES}` },
  ])("normalizes read call line ranges for limit $limit", ({ limit, range }) => {
    expect(renderReadCall({ path: "notes.txt", limit })).toBe(`read notes.txt${range}`);
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
    expect(Value.Check(tool.parameters, { path: "notes.txt", cursor: 0 })).toBe(true);
    for (const offset of [0, -1, 1.5]) {
      expect(Value.Check(tool.parameters, { path: "notes.txt", offset })).toBe(false);
    }
    for (const cursor of [-1, 1.5]) {
      expect(Value.Check(tool.parameters, { path: "notes.txt", cursor })).toBe(false);
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

  it("strips one leading UTF-8 BOM without changing embedded markers", async () => {
    const tool = createReadToolDefinition("/workspace", {
      operations: {
        access: async () => {},
        detectImageMimeType: async () => null,
        readFile: async () => Buffer.from("\uFEFFimport value\nconst marker = '\uFEFF';"),
      },
    });

    const result = await tool.execute(
      "call-1",
      { path: "source.ts" },
      undefined,
      undefined,
      {} as never,
    );

    expect(textContent(result)).toBe("import value\nconst marker = '\uFEFF';");
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
