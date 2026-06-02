import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  chunkMarkdown,
  ensureDir,
  isMemoryPath,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  remapChunkLines,
} from "./internal.js";
import {
  DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES,
  type MemoryMultimodalSettings,
} from "./multimodal.js";

type FileEntry = NonNullable<Awaited<ReturnType<typeof buildFileEntry>>>;
type MultimodalIndexingChunk = NonNullable<
  Awaited<ReturnType<typeof buildMultimodalChunkForIndexing>>
>;

let sharedTempRoot = "";
let sharedTempId = 0;

beforeAll(() => {
  sharedTempRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "memory-host-sdk-package-tests-"));
});

afterAll(() => {
  if (sharedTempRoot) {
    fsSync.rmSync(sharedTempRoot, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setupTempDirLifecycle(prefix: string): () => string {
  let tmpDir = "";
  beforeEach(() => {
    tmpDir = path.join(sharedTempRoot, `${prefix}${sharedTempId++}`);
    fsSync.mkdirSync(tmpDir, { recursive: true });
  });
  return () => tmpDir;
}

function expectFileEntry(entry: Awaited<ReturnType<typeof buildFileEntry>>): FileEntry {
  if (!entry) {
    throw new Error("Expected file entry to be built");
  }
  return entry;
}

function expectMultimodalIndexingChunk(
  built: Awaited<ReturnType<typeof buildMultimodalChunkForIndexing>>,
): MultimodalIndexingChunk {
  if (!built) {
    throw new Error("Expected multimodal indexing chunk to be built");
  }
  return built;
}

function expectEmbeddingInput(
  chunk: MultimodalIndexingChunk["chunk"],
): NonNullable<MultimodalIndexingChunk["chunk"]["embeddingInput"]> {
  if (!chunk.embeddingInput) {
    throw new Error("Expected multimodal chunk embedding input");
  }
  return chunk.embeddingInput;
}

const multimodal: MemoryMultimodalSettings = {
  enabled: true,
  modalities: ["image", "audio"],
  maxFileBytes: DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES,
};

describe("memory host SDK package internals", () => {
  const getTmpDir = setupTempDirLifecycle("memory-package-");

  it("propagates directory creation failures", () => {
    const mkdirError = new Error("disk full");
    const targetDir = path.join(getTmpDir(), "blocked");
    const mkdirSync = vi.spyOn(fsSync, "mkdirSync").mockImplementation(() => {
      throw mkdirError;
    });

    expect(() => ensureDir(targetDir)).toThrow(mkdirError);
    expect(mkdirSync).toHaveBeenCalledWith(targetDir, { recursive: true });
  });

  it("normalizes additional memory paths", () => {
    const workspaceDir = path.join(os.tmpdir(), "memory-test-workspace");
    const absPath = path.resolve(path.sep, "shared-notes");
    expect(
      normalizeExtraMemoryPaths(workspaceDir, [
        " notes ",
        "./notes",
        absPath,
        absPath,
        "~/shared-notes",
        "~",
        "",
      ]),
    ).toEqual([
      path.resolve(workspaceDir, "notes"),
      absPath,
      path.join(os.homedir(), "shared-notes"),
      os.homedir(),
    ]);
  });

  it("lists canonical markdown and enabled multimodal files", async () => {
    const tmpDir = getTmpDir();
    fsSync.writeFileSync(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    fsSync.writeFileSync(path.join(tmpDir, "memory.md"), "# Legacy memory");
    const extraDir = path.join(tmpDir, "extra");
    fsSync.mkdirSync(extraDir, { recursive: true });
    fsSync.writeFileSync(path.join(extraDir, "note.md"), "# Note");
    fsSync.writeFileSync(path.join(extraDir, "diagram.png"), Buffer.from("png"));
    fsSync.writeFileSync(path.join(extraDir, "ignore.txt"), "ignored");

    const files = await listMemoryFiles(
      tmpDir,
      [path.join(tmpDir, "memory.md"), extraDir],
      multimodal,
    );

    expect(files.map((file) => path.relative(tmpDir, file)).toSorted()).toEqual([
      "MEMORY.md",
      path.join("extra", "diagram.png"),
      path.join("extra", "note.md"),
    ]);
  });

  it("allows top-level dreams path casing variants", () => {
    expect(isMemoryPath("dreams.md")).toBe(true);
    expect(isMemoryPath("DREAMS.md")).toBe(true);
  });

  it("builds markdown and multimodal file entries", async () => {
    const tmpDir = getTmpDir();
    const notePath = path.join(tmpDir, "note.md");
    const imagePath = path.join(tmpDir, "diagram.png");
    fsSync.writeFileSync(notePath, "hello", "utf-8");
    fsSync.writeFileSync(imagePath, Buffer.from("png"));

    const note = await buildFileEntry(notePath, tmpDir);
    const image = await buildFileEntry(imagePath, tmpDir, multimodal);

    const noteEntry = expectFileEntry(note);
    expect(noteEntry.path).toBe("note.md");
    expect(noteEntry.kind).toBe("markdown");
    const imageEntry = expectFileEntry(image);
    expect(imageEntry.path).toBe("diagram.png");
    expect(imageEntry.kind).toBe("multimodal");
    expect(imageEntry.modality).toBe("image");
    expect(imageEntry.mimeType).toBe("image/png");
    expect(imageEntry.contentText).toBe("Image file: diagram.png");
  });

  it("retries transient markdown reads while building file entries", async () => {
    const tmpDir = getTmpDir();
    const notePath = path.join(tmpDir, "note.md");
    fsSync.writeFileSync(notePath, "hello", "utf-8");

    const realOpen = fs.open;
    let attempts = 0;
    const openSpy = vi
      .spyOn(fs, "open")
      .mockImplementation(async (...args: Parameters<typeof realOpen>) => {
        const [target, flags, mode] = args;
        if (typeof target === "string" && path.resolve(target) === notePath && attempts++ === 0) {
          const err = new Error(
            "Unknown system error -11: Unknown system error -11, open",
          ) as NodeJS.ErrnoException;
          err.code = "UNKNOWN";
          err.errno = -11;
          throw err;
        }
        return await realOpen(target, flags, mode);
      });

    try {
      const entry = expectFileEntry(await buildFileEntry(notePath, tmpDir));
      expect(entry.path).toBe("note.md");
      expect(entry.kind).toBe("markdown");
      expect(attempts).toBe(2);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("builds multimodal chunks lazily and rejects changed files", async () => {
    const tmpDir = getTmpDir();
    const imagePath = path.join(tmpDir, "diagram.png");
    fsSync.writeFileSync(imagePath, Buffer.from("png"));

    const entry = expectFileEntry(await buildFileEntry(imagePath, tmpDir, multimodal));
    const built = expectMultimodalIndexingChunk(await buildMultimodalChunkForIndexing(entry));
    const parts = expectEmbeddingInput(built.chunk).parts ?? [];
    expect(parts[0]).toEqual({ type: "text", text: "Image file: diagram.png" });
    const inlinePart = parts[1];
    if (inlinePart?.type !== "inline-data") {
      throw new Error("Expected multimodal inline-data embedding part");
    }
    expect(inlinePart.mimeType).toBe("image/png");

    fsSync.writeFileSync(imagePath, Buffer.alloc(entry.size + 32, 1));
    await expect(buildMultimodalChunkForIndexing(entry)).resolves.toBeNull();
  });

  it("chunks mixed text and preserves surrogate pairs", () => {
    const mixed = Array.from(
      { length: 30 },
      (_, index) => `Line ${index}: 这是中英文混合的测试内容 with English`,
    ).join("\n");
    const mixedChunks = chunkMarkdown(mixed, { tokens: 50, overlap: 0 });
    expect(mixedChunks.length).toBeGreaterThan(1);
    expect(mixedChunks.map((chunk) => chunk.text).join("\n")).toContain("Line 29");

    const surrogateChar = "\u{20000}";
    const surrogateChunks = chunkMarkdown(surrogateChar.repeat(120), {
      tokens: 31,
      overlap: 0,
    });
    for (const chunk of surrogateChunks) {
      expect(chunk.text).not.toContain("\uFFFD");
    }
  });

  it("remaps chunk lines using JSONL source line maps", () => {
    const lineMap = [4, 6, 7, 10, 13];
    const chunks = chunkMarkdown(
      "User: Hello\nAssistant: Hi\nUser: Question\nAssistant: Answer\nUser: Thanks",
      { tokens: 400, overlap: 0 },
    );

    remapChunkLines(chunks, lineMap);

    expect(chunks[0].startLine).toBe(4);
    expect(chunks[chunks.length - 1].endLine).toBe(13);
  });
});
