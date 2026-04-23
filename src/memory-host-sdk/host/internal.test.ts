import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMultimodalChunkForIndexing,
  buildFileEntry,
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

let sharedTempRoot = "";
let sharedTempId = 0;

beforeAll(async () => {
  sharedTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-host-sdk-tests-"));
});

afterAll(async () => {
  if (sharedTempRoot) {
    await fs.rm(sharedTempRoot, { recursive: true, force: true });
  }
});

function setupTempDirLifecycle(prefix: string): () => string {
  let tmpDir = "";
  beforeEach(async () => {
    tmpDir = path.join(sharedTempRoot, `${prefix}${sharedTempId++}`);
    await fs.mkdir(tmpDir, { recursive: true });
  });
  return () => tmpDir;
}

describe("normalizeExtraMemoryPaths", () => {
  it("trims, resolves, and dedupes paths", () => {
    const workspaceDir = path.join(os.tmpdir(), "memory-test-workspace");
    const absPath = path.resolve(path.sep, "shared-notes");
    const result = normalizeExtraMemoryPaths(workspaceDir, [
      " notes ",
      "./notes",
      absPath,
      absPath,
      "",
    ]);
    expect(result).toEqual([path.resolve(workspaceDir, "notes"), absPath]);
  });
});

describe("listMemoryFiles", () => {
  const getTmpDir = setupTempDirLifecycle("memory-test-");
  const multimodal: MemoryMultimodalSettings = {
    enabled: true,
    modalities: ["image", "audio"],
    maxFileBytes: DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES,
  };

  it("includes files from additional paths (directory)", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const extraDir = path.join(tmpDir, "extra-notes");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "note1.md"), "# Note 1");
    await fs.writeFile(path.join(extraDir, "note2.md"), "# Note 2");
    await fs.writeFile(path.join(extraDir, "ignore.txt"), "Not a markdown file");

    const files = await listMemoryFiles(tmpDir, [extraDir]);
    expect(files).toHaveLength(3);
    expect(files.some((file) => file.endsWith("MEMORY.md"))).toBe(true);
    expect(files.some((file) => file.endsWith("note1.md"))).toBe(true);
    expect(files.some((file) => file.endsWith("note2.md"))).toBe(true);
    expect(files.some((file) => file.endsWith("ignore.txt"))).toBe(false);
  });

  it("includes files from additional paths (single file)", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const singleFile = path.join(tmpDir, "standalone.md");
    await fs.writeFile(singleFile, "# Standalone");

    const files = await listMemoryFiles(tmpDir, [singleFile]);
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.endsWith("standalone.md"))).toBe(true);
  });

  it("ignores lowercase root memory.md when canonical MEMORY.md is absent", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "memory.md"), "# Legacy memory");

    const files = await listMemoryFiles(tmpDir, [path.join(tmpDir, "memory.md")]);

    expect(files).toEqual([]);
  });

  it("prefers canonical MEMORY.md over legacy root memory.md even through extra paths", async () => {
    const tmpDir = getTmpDir();
    const canonicalPath = path.join(tmpDir, "MEMORY.md");
    const legacyPath = path.join(tmpDir, "memory.md");
    const actualLstat = fs.lstat.bind(fs);
    const actualReaddir = fs.readdir.bind(fs);
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (target) => {
      if (target === canonicalPath || target === legacyPath) {
        return {
          isSymbolicLink: () => false,
          isFile: () => true,
          isDirectory: () => false,
        } as Awaited<ReturnType<typeof fs.lstat>>;
      }
      return actualLstat(target);
    });
    const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation((async (
      target: unknown,
      options: unknown,
    ) => {
      if (
        target === tmpDir &&
        typeof options === "object" &&
        options !== null &&
        "withFileTypes" in options &&
        options.withFileTypes
      ) {
        return [
          {
            name: "MEMORY.md",
            isSymbolicLink: () => false,
            isDirectory: () => false,
            isFile: () => true,
          },
          {
            name: "memory.md",
            isSymbolicLink: () => false,
            isDirectory: () => false,
            isFile: () => true,
          },
        ] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
      }
      return actualReaddir(target as never, options as never);
    }) as never);

    try {
      const files = await listMemoryFiles(tmpDir, [legacyPath, path.join(tmpDir, ".")]);
      expect(files).toEqual([canonicalPath]);
    } finally {
      lstatSpy.mockRestore();
      readdirSpy.mockRestore();
    }
  });

  it("skips root-memory repair backups from extra workspace paths", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const repairDir = path.join(tmpDir, ".openclaw-repair", "root-memory", "2026-04-23");
    await fs.mkdir(repairDir, { recursive: true });
    await fs.writeFile(path.join(repairDir, "memory.md"), "# Archived legacy memory");

    const files = await listMemoryFiles(tmpDir, [tmpDir]);

    expect(files).toHaveLength(1);
    expect(files[0]).toBe(path.join(tmpDir, "MEMORY.md"));
  });

  it("skips explicit root-memory repair directories from extra paths", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const repairDir = path.join(tmpDir, ".openclaw-repair", "root-memory", "2026-04-23");
    await fs.mkdir(repairDir, { recursive: true });
    await fs.writeFile(path.join(repairDir, "memory.md"), "# Archived legacy memory");

    const files = await listMemoryFiles(tmpDir, [
      path.join(tmpDir, ".openclaw-repair", "root-memory"),
    ]);

    expect(files).toHaveLength(1);
    expect(files[0]).toBe(path.join(tmpDir, "MEMORY.md"));
  });

  it("handles relative paths in additional paths", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const extraDir = path.join(tmpDir, "subdir");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "nested.md"), "# Nested");

    const files = await listMemoryFiles(tmpDir, ["subdir"]);
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.endsWith("nested.md"))).toBe(true);
  });

  it("ignores non-existent additional paths", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");

    const files = await listMemoryFiles(tmpDir, ["/does/not/exist"]);
    expect(files).toHaveLength(1);
  });

  it("ignores symlinked files and directories", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const extraDir = path.join(tmpDir, "extra");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "note.md"), "# Note");

    const targetFile = path.join(tmpDir, "target.md");
    await fs.writeFile(targetFile, "# Target");
    const linkFile = path.join(extraDir, "linked.md");

    const targetDir = path.join(tmpDir, "target-dir");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "nested.md"), "# Nested");
    const linkDir = path.join(tmpDir, "linked-dir");

    let symlinksOk = true;
    try {
      await fs.symlink(targetFile, linkFile, "file");
      await fs.symlink(targetDir, linkDir, "dir");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        symlinksOk = false;
      } else {
        throw err;
      }
    }

    const files = await listMemoryFiles(tmpDir, [extraDir, linkDir]);
    expect(files.some((file) => file.endsWith("note.md"))).toBe(true);
    if (symlinksOk) {
      expect(files.some((file) => file.endsWith("linked.md"))).toBe(false);
      expect(files.some((file) => file.endsWith("nested.md"))).toBe(false);
    }
  });

  it("dedupes overlapping extra paths that resolve to the same file", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const files = await listMemoryFiles(tmpDir, [tmpDir, ".", path.join(tmpDir, "MEMORY.md")]);
    const memoryMatches = files.filter((file) => file.endsWith("MEMORY.md"));
    expect(memoryMatches).toHaveLength(1);
  });

  it("includes image and audio files from extra paths when multimodal is enabled", async () => {
    const tmpDir = getTmpDir();
    const extraDir = path.join(tmpDir, "media");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "diagram.png"), Buffer.from("png"));
    await fs.writeFile(path.join(extraDir, "note.wav"), Buffer.from("wav"));
    await fs.writeFile(path.join(extraDir, "ignore.bin"), Buffer.from("bin"));

    const files = await listMemoryFiles(tmpDir, [extraDir], multimodal);
    expect(files.some((file) => file.endsWith("diagram.png"))).toBe(true);
    expect(files.some((file) => file.endsWith("note.wav"))).toBe(true);
    expect(files.some((file) => file.endsWith("ignore.bin"))).toBe(false);
  });
});

describe("isMemoryPath", () => {
  it("allows explicit access to top-level DREAMS.md", () => {
    expect(isMemoryPath("DREAMS.md")).toBe(true);
  });
});

describe("buildFileEntry", () => {
  const getTmpDir = setupTempDirLifecycle("memory-build-entry-");
  const multimodal: MemoryMultimodalSettings = {
    enabled: true,
    modalities: ["image", "audio"],
    maxFileBytes: DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES,
  };

  it("returns null when the file disappears before reading", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "ghost.md");
    await fs.writeFile(target, "ghost", "utf-8");
    await fs.rm(target);
    const entry = await buildFileEntry(target, tmpDir);
    expect(entry).toBeNull();
  });

  it("returns metadata when the file exists", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "note.md");
    await fs.writeFile(target, "hello", "utf-8");
    const entry = await buildFileEntry(target, tmpDir);
    expect(entry).not.toBeNull();
    expect(entry?.path).toBe("note.md");
    expect(entry?.size).toBeGreaterThan(0);
  });

  it("returns multimodal metadata for eligible image files", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "diagram.png");
    await fs.writeFile(target, Buffer.from("png"));

    const entry = await buildFileEntry(target, tmpDir, multimodal);

    expect(entry).toMatchObject({
      path: "diagram.png",
      kind: "multimodal",
      modality: "image",
      mimeType: "image/png",
      contentText: "Image file: diagram.png",
    });
  });

  it("builds a multimodal chunk lazily for indexing", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "diagram.png");
    await fs.writeFile(target, Buffer.from("png"));

    const entry = await buildFileEntry(target, tmpDir, multimodal);
    const built = await buildMultimodalChunkForIndexing(entry!);

    expect(built?.chunk.embeddingInput?.parts).toEqual([
      { type: "text", text: "Image file: diagram.png" },
      expect.objectContaining({ type: "inline-data", mimeType: "image/png" }),
    ]);
    expect(built?.structuredInputBytes).toBeGreaterThan(0);
  });

  it("skips lazy multimodal indexing when the file grows after discovery", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "diagram.png");
    await fs.writeFile(target, Buffer.from("png"));

    const entry = await buildFileEntry(target, tmpDir, multimodal);
    await fs.writeFile(target, Buffer.alloc(entry!.size + 32, 1));

    await expect(buildMultimodalChunkForIndexing(entry!)).resolves.toBeNull();
  });

  it("skips lazy multimodal indexing when file bytes change after discovery", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "diagram.png");
    await fs.writeFile(target, Buffer.from("png"));

    const entry = await buildFileEntry(target, tmpDir, multimodal);
    await fs.writeFile(target, Buffer.from("gif"));

    await expect(buildMultimodalChunkForIndexing(entry!)).resolves.toBeNull();
  });

  it("skips lazy multimodal indexing when the file disappears before loading bytes", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "diagram.png");
    await fs.writeFile(target, Buffer.from("png"));

    const entry = await buildFileEntry(target, tmpDir, multimodal);
    await fs.rm(target);

    await expect(buildMultimodalChunkForIndexing(entry!)).resolves.toBeNull();
  });
});

describe("chunkMarkdown", () => {
  it("splits overly long lines into max-sized chunks", () => {
    const chunkTokens = 400;
    const maxChars = chunkTokens * 4;
    const content = "a".repeat(maxChars * 3 + 25);
    const chunks = chunkMarkdown(content, { tokens: chunkTokens, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(maxChars);
    }
  });

  it("produces more chunks for CJK text than for equal-length ASCII text", () => {
    // CJK chars ≈ 1 token each; ASCII chars ≈ 0.25 tokens each.
    // For the same raw character count, CJK content should produce more chunks
    // because each character "weighs" ~4× more in token estimation.
    const chunkTokens = 50;

    // 400 ASCII chars → ~100 tokens → fits in ~2 chunks
    const asciiLines = Array.from({ length: 20 }, () => "a".repeat(20)).join("\n");
    const asciiChunks = chunkMarkdown(asciiLines, { tokens: chunkTokens, overlap: 0 });

    // 400 CJK chars → ~400 tokens → needs ~8 chunks
    const cjkLines = Array.from({ length: 20 }, () => "你".repeat(20)).join("\n");
    const cjkChunks = chunkMarkdown(cjkLines, { tokens: chunkTokens, overlap: 0 });

    expect(cjkChunks.length).toBeGreaterThan(asciiChunks.length);
  });

  it("respects token budget for Chinese text", () => {
    // With tokens=100, each CJK char ≈ 1 token, so chunks should hold ~100 CJK chars.
    const chunkTokens = 100;
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push("这是一个测试句子用来验证分块逻辑是否正确处理中文文本内容");
    }
    const content = lines.join("\n");
    const chunks = chunkMarkdown(content, { tokens: chunkTokens, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk's CJK content should not vastly exceed the token budget.
    // With CJK-aware estimation, each char ≈ 1 token, so chunk text length
    // (in CJK chars) should be roughly <= tokens budget (with some tolerance
    // for line boundaries).
    for (const chunk of chunks) {
      // Count actual CJK characters in the chunk
      const cjkCount = (chunk.text.match(/[\u4e00-\u9fff]/g) ?? []).length;
      // Allow 2× tolerance for line-boundary rounding
      expect(cjkCount).toBeLessThanOrEqual(chunkTokens * 2);
    }
  });

  it("keeps English chunking behavior unchanged", () => {
    const chunkTokens = 100;
    const maxChars = chunkTokens * 4; // 400 chars
    const content = "hello world this is a test. ".repeat(50);
    const chunks = chunkMarkdown(content, { tokens: chunkTokens, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(maxChars);
    }
  });

  it("handles mixed CJK and ASCII content correctly", () => {
    const chunkTokens = 50;
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) {
      lines.push(`Line ${i}: 这是中英文混合的测试内容 with some English text`);
    }
    const content = lines.join("\n");
    const chunks = chunkMarkdown(content, { tokens: chunkTokens, overlap: 0 });
    // Should produce multiple chunks and not crash
    expect(chunks.length).toBeGreaterThan(1);
    // Verify all content is preserved
    const reconstructed = chunks.map((c) => c.text).join("\n");
    // Due to overlap=0, the concatenated chunks should cover all lines
    expect(reconstructed).toContain("Line 0");
    expect(reconstructed).toContain("Line 29");
  });

  it("splits very long CJK lines into budget-sized segments", () => {
    // A single line of 2000 CJK characters (no newlines).
    // With tokens=200, each CJK char ≈ 1 token.
    const longCjkLine = "中".repeat(2000);
    const chunks = chunkMarkdown(longCjkLine, { tokens: 200, overlap: 0 });
    expect(chunks.length).toBeGreaterThanOrEqual(8);
    for (const chunk of chunks) {
      const cjkCount = (chunk.text.match(/[\u4E00-\u9FFF]/g) ?? []).length;
      expect(cjkCount).toBeLessThanOrEqual(200 * 2);
    }
  });
  it("does not break surrogate pairs when splitting long CJK lines", () => {
    // "𠀀" (U+20000) is a surrogate pair: 2 UTF-16 code units per character.
    // With an odd token budget, the fine-split must not cut inside a pair.
    const surrogateChar = "\u{20000}"; // 𠀀
    const longLine = surrogateChar.repeat(120);
    const chunks = chunkMarkdown(longLine, { tokens: 31, overlap: 0 });
    for (const chunk of chunks) {
      // No chunk should contain the Unicode replacement character U+FFFD,
      // which would indicate a broken surrogate pair.
      expect(chunk.text).not.toContain("\uFFFD");
      // Every character in the chunk should be a valid string (no lone surrogates).
      for (let i = 0; i < chunk.text.length; i += 1) {
        const code = chunk.text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          // High surrogate must be followed by a low surrogate
          const next = chunk.text.charCodeAt(i + 1);
          expect(next).toBeGreaterThanOrEqual(0xdc00);
          expect(next).toBeLessThanOrEqual(0xdfff);
        }
      }
    }
  });
  it("does not over-split long Latin lines (backward compat)", () => {
    // 2000 ASCII chars / 800 maxChars -> about 3 segments, not 10 tiny ones.
    const longLatinLine = "a".repeat(2000);
    const chunks = chunkMarkdown(longLatinLine, { tokens: 200, overlap: 0 });
    expect(chunks.length).toBeLessThanOrEqual(5);
  });
});

describe("remapChunkLines", () => {
  it("remaps chunk line numbers using a lineMap", () => {
    // Simulate 5 content lines that came from JSONL lines [4, 6, 7, 10, 13] (1-indexed)
    const lineMap = [4, 6, 7, 10, 13];

    // Create chunks from content that has 5 lines
    const content = "User: Hello\nAssistant: Hi\nUser: Question\nAssistant: Answer\nUser: Thanks";
    const chunks = chunkMarkdown(content, { tokens: 400, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(0);

    // Before remapping, startLine/endLine reference content line numbers (1-indexed)
    expect(chunks[0].startLine).toBe(1);

    // Remap
    remapChunkLines(chunks, lineMap);

    // After remapping, line numbers should reference original JSONL lines
    // Content line 1 → JSONL line 4, content line 5 → JSONL line 13
    expect(chunks[0].startLine).toBe(4);
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.endLine).toBe(13);
  });

  it("preserves original line numbers when lineMap is undefined", () => {
    const content = "Line one\nLine two\nLine three";
    const chunks = chunkMarkdown(content, { tokens: 400, overlap: 0 });
    const originalStart = chunks[0].startLine;
    const originalEnd = chunks[chunks.length - 1].endLine;

    remapChunkLines(chunks, undefined);

    expect(chunks[0].startLine).toBe(originalStart);
    expect(chunks[chunks.length - 1].endLine).toBe(originalEnd);
  });

  it("handles multi-chunk content with correct remapping", () => {
    // Use small chunk size to force multiple chunks
    // lineMap: 10 content lines from JSONL lines [2, 5, 8, 11, 14, 17, 20, 23, 26, 29]
    const lineMap = [2, 5, 8, 11, 14, 17, 20, 23, 26, 29];
    const contentLines = lineMap.map((_, i) =>
      i % 2 === 0 ? `User: Message ${i}` : `Assistant: Reply ${i}`,
    );
    const content = contentLines.join("\n");

    // Use very small chunk size to force splitting
    const chunks = chunkMarkdown(content, { tokens: 10, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);

    remapChunkLines(chunks, lineMap);

    // First chunk should start at JSONL line 2
    expect(chunks[0].startLine).toBe(2);
    // Last chunk should end at JSONL line 29
    expect(chunks[chunks.length - 1].endLine).toBe(29);

    // Each chunk's startLine should be ≤ its endLine
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeLessThanOrEqual(chunk.endLine);
    }
  });
});
