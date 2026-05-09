import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  chunkMarkdown,
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

  it("normalizes additional memory paths", () => {
    const workspaceDir = path.join(os.tmpdir(), "memory-test-workspace");
    const absPath = path.resolve(path.sep, "shared-notes");
    expect(
      normalizeExtraMemoryPaths(workspaceDir, [" notes ", "./notes", absPath, absPath, ""]),
    ).toEqual([path.resolve(workspaceDir, "notes"), absPath]);
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

    expect(note).toMatchObject({ path: "note.md", kind: "markdown" });
    expect(image).toMatchObject({
      path: "diagram.png",
      kind: "multimodal",
      modality: "image",
      mimeType: "image/png",
      contentText: "Image file: diagram.png",
    });
  });

  it("builds multimodal chunks lazily and rejects changed files", async () => {
    const tmpDir = getTmpDir();
    const imagePath = path.join(tmpDir, "diagram.png");
    fsSync.writeFileSync(imagePath, Buffer.from("png"));

    const entry = expectFileEntry(await buildFileEntry(imagePath, tmpDir, multimodal));
    const built = expectMultimodalIndexingChunk(await buildMultimodalChunkForIndexing(entry));
    expect(expectEmbeddingInput(built.chunk).parts).toEqual([
      { type: "text", text: "Image file: diagram.png" },
      expect.objectContaining({ type: "inline-data", mimeType: "image/png" }),
    ]);

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
