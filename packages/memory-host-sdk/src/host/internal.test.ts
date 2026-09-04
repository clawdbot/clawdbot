// Memory Host SDK tests cover internal behavior.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFileEntry,
  buildMultimodalChunkForIndexing,
  chunkMarkdown,
  ensureDir,
  isMemoryPath,
  listMemoryFiles,
  normalizeExtraMemoryPathEntries,
  normalizeExtraMemoryPaths,
  remapChunkLines,
  runWithConcurrency,
  stripMemoryAnnotationCarriers,
} from "./internal.js";
import { normalizeMemoryMultimodalSettings, type MemoryMultimodalSettings } from "./multimodal.js";
import { readMemoryFile } from "./read-file.js";

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

function tryCreateSymlink(target: string, linkPath: string, type?: "dir"): boolean {
  try {
    fsSync.symlinkSync(target, linkPath, type);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      return false;
    }
    throw err;
  }
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

const multimodal: MemoryMultimodalSettings = normalizeMemoryMultimodalSettings({ enabled: true });

describe("memory host SDK package internals", () => {
  const getTmpDir = setupTempDirLifecycle("memory-package-");

  it.skipIf(process.platform === "win32")(
    "rejects an uppercase explicit extra file on case-sensitive hosts",
    async () => {
      const tmpDir = getTmpDir();
      const workspaceDir = path.join(tmpDir, "workspace");
      const upperPath = path.join(tmpDir, "NOTES.MD");
      await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
      await fs.writeFile(upperPath, "not lowercase Markdown", "utf8");

      await expect(listMemoryFiles(workspaceDir, [upperPath])).resolves.toEqual([]);
      await expect(
        readMemoryFile({ workspaceDir, extraPaths: [upperPath], relPath: upperPath }),
      ).rejects.toThrow("path required");
    },
  );

  it("drains in-flight work before propagating a concurrency failure", async () => {
    const failure = new Error("embedding failed");
    let releaseTask!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    const started: number[] = [];
    const completed: number[] = [];
    const run = runWithConcurrency(
      [
        async () => {
          started.push(0);
          await release;
          completed.push(0);
          return 0;
        },
        async () => {
          started.push(1);
          throw failure;
        },
        async () => {
          started.push(2);
          return 2;
        },
      ],
      2,
    );

    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    const onSettled = vi.fn();
    void run.then(onSettled, onSettled);
    await Promise.resolve();
    expect(onSettled).not.toHaveBeenCalled();

    releaseTask();
    await expect(run).rejects.toBe(failure);
    expect(completed).toEqual([0]);
    expect(started).toEqual([0, 1]);
  });

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
    expect(
      normalizeExtraMemoryPathEntries(workspaceDir, [
        { path: " notes ", pattern: " runbooks/**/*.md " },
        { path: "notes", pattern: "runbooks/**/*.md" },
        { path: "notes", pattern: "archive/**/*.md" },
      ]),
    ).toEqual([
      { path: path.resolve(workspaceDir, "notes"), pattern: "runbooks/**/*.md" },
      { path: path.resolve(workspaceDir, "notes"), pattern: "archive/**/*.md" },
    ]);
  });

  it("lists canonical markdown and enabled multimodal files", async () => {
    const tmpDir = getTmpDir();
    fsSync.writeFileSync(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    fsSync.writeFileSync(path.join(tmpDir, "USER.md"), "# User profile");
    fsSync.writeFileSync(path.join(tmpDir, "memory.md"), "# Legacy memory");
    const defaultMemoryDir = path.join(tmpDir, "memory");
    fsSync.mkdirSync(defaultMemoryDir, { recursive: true });
    fsSync.writeFileSync(path.join(defaultMemoryDir, "default-diagram.png"), Buffer.from("png"));
    const extraDir = path.join(tmpDir, "extra");
    fsSync.mkdirSync(extraDir, { recursive: true });
    fsSync.writeFileSync(path.join(extraDir, "note.md"), "# Note");
    fsSync.writeFileSync(path.join(extraDir, "diagram.png"), Buffer.from("png"));
    fsSync.writeFileSync(path.join(extraDir, "recording.m2a"), Buffer.from("audio"));
    fsSync.writeFileSync(path.join(extraDir, "ignore.txt"), "ignored");

    const files = await listMemoryFiles(
      tmpDir,
      [path.join(tmpDir, "memory.md"), extraDir],
      multimodal,
    );

    expect(files.map((file) => path.relative(tmpDir, file)).toSorted()).toEqual([
      "MEMORY.md",
      "USER.md",
      path.join("extra", "diagram.png"),
      path.join("extra", "note.md"),
      path.join("extra", "recording.m2a"),
    ]);
  });

  it.each([
    {
      label: "primary memory file",
      target: (workspaceDir: string) => path.join(workspaceDir, "USER.md"),
      extraPaths: (_workspaceDir: string) => undefined,
    },
    {
      label: "workspace memory directory",
      target: (workspaceDir: string) => path.join(workspaceDir, "memory"),
      extraPaths: (_workspaceDir: string) => undefined,
    },
    {
      label: "configured extra path",
      target: (workspaceDir: string) => path.join(workspaceDir, "extra"),
      extraPaths: (workspaceDir: string) => [path.join(workspaceDir, "extra")],
    },
  ])("propagates operational scan failures for $label", async ({ target, extraPaths }) => {
    const workspaceDir = getTmpDir();
    const failedPath = target(workspaceDir);
    const scanError = Object.assign(new Error(`I/O failure: ${failedPath}`), { code: "EIO" });
    const realLstat = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation(
      async (...args: Parameters<typeof fs.lstat>): ReturnType<typeof fs.lstat> => {
        if (path.resolve(String(args[0])) === failedPath) {
          throw scanError;
        }
        return await realLstat(...args);
      },
    );

    await expect(listMemoryFiles(workspaceDir, extraPaths(workspaceDir))).rejects.toMatchObject({
      name: "MemorySourceScanError",
      path: failedPath,
      code: "EIO",
      cause: scanError,
      message: `memory source scan failed at ${failedPath} (EIO): I/O failure: ${failedPath}`,
    });
  });

  it("propagates operational failures while discovering the canonical memory file", async () => {
    const workspaceDir = getTmpDir();
    const scanError = Object.assign(new Error(`I/O failure: ${workspaceDir}`), { code: "EIO" });
    const realReaddir = fs.readdir;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      if (path.resolve(String(args[0])) === workspaceDir) {
        throw scanError;
      }
      return await realReaddir(...args);
    });

    await expect(listMemoryFiles(workspaceDir)).rejects.toMatchObject({
      name: "MemorySourceScanError",
      path: workspaceDir,
      code: "EIO",
      cause: scanError,
    });
  });

  it("propagates operational failures while traversing a memory directory", async () => {
    const workspaceDir = getTmpDir();
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir);
    const scanError = Object.assign(new Error(`I/O failure: ${memoryDir}`), { code: "EIO" });
    const realReaddir = fs.readdir;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      if (path.resolve(String(args[0])) === memoryDir) {
        throw scanError;
      }
      return await realReaddir(...args);
    });

    await expect(listMemoryFiles(workspaceDir)).rejects.toMatchObject({
      name: "MemorySourceScanError",
      path: memoryDir,
      code: "EIO",
      cause: scanError,
    });
  });

  it("names the nested directory that blocks a memory scan", async () => {
    const workspaceDir = getTmpDir();
    const memoryDir = path.join(workspaceDir, "memory");
    const nestedDir = path.join(memoryDir, "nested");
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "ok.md"), "# ok\n");
    const scanError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const realReaddir = fs.readdir;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
      if (path.resolve(String(args[0])) === nestedDir) {
        throw scanError;
      }
      return await realReaddir(...args);
    });

    await expect(listMemoryFiles(workspaceDir)).rejects.toMatchObject({
      name: "MemorySourceScanError",
      path: nestedDir,
      code: "EACCES",
      cause: scanError,
      message: `memory source scan failed at ${nestedDir} (EACCES): permission denied`,
    });
  });

  it.each([
    { directory: "notes", rootFile: "root.md" },
    { directory: "..notes", rootFile: "..root.md" },
    { directory: "...notes", rootFile: "...root.md" },
  ])(
    "filters $directory by glob while preserving symlink skips",
    async ({ directory, rootFile }) => {
      const tmpDir = getTmpDir();
      const extraDir = path.join(tmpDir, "extra");
      const outsideDir = path.join(tmpDir, "outside");
      fsSync.mkdirSync(path.join(extraDir, directory, "nested"), { recursive: true });
      fsSync.mkdirSync(path.join(extraDir, "drafts"), { recursive: true });
      fsSync.mkdirSync(outsideDir, { recursive: true });
      fsSync.writeFileSync(path.join(extraDir, rootFile), "root");
      fsSync.writeFileSync(path.join(extraDir, directory, "keep.md"), "keep");
      fsSync.writeFileSync(path.join(extraDir, directory, "nested", "keep.md"), "nested");
      fsSync.writeFileSync(path.join(extraDir, "drafts", "skip.md"), "skip");
      fsSync.writeFileSync(path.join(extraDir, directory, "ignore.txt"), "ignore");
      fsSync.writeFileSync(path.join(outsideDir, "linked.md"), "linked");
      tryCreateSymlink(
        path.join(outsideDir, "linked.md"),
        path.join(extraDir, directory, "linked.md"),
      );
      tryCreateSymlink(outsideDir, path.join(extraDir, directory, "linked-dir"), "dir");

      const files = await listMemoryFiles(tmpDir, [
        { path: extraDir, pattern: rootFile },
        { path: extraDir, pattern: `${directory}/**/*.md` },
      ]);

      expect(files.map((file) => path.relative(extraDir, file)).toSorted()).toEqual(
        [
          path.join(directory, "keep.md"),
          path.join(directory, "nested", "keep.md"),
          rootFile,
        ].toSorted(),
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "skips a symlinked workspace root file instead of aborting enumeration",
    async () => {
      const tmpDir = getTmpDir();
      const outsideDir = path.join(tmpDir, "outside");
      fsSync.mkdirSync(outsideDir, { recursive: true });
      fsSync.writeFileSync(path.join(outsideDir, "shared-user.md"), "# Outside user profile");
      fsSync.writeFileSync(path.join(tmpDir, "USER.md"), "# placeholder, replaced below");
      fsSync.unlinkSync(path.join(tmpDir, "USER.md"));
      expect(
        tryCreateSymlink(path.join(outsideDir, "shared-user.md"), path.join(tmpDir, "USER.md")),
      ).toBe(true);
      const memoryDir = path.join(tmpDir, "memory");
      fsSync.mkdirSync(memoryDir, { recursive: true });
      fsSync.writeFileSync(path.join(memoryDir, "notes.md"), "# Notes");

      const files = await listMemoryFiles(tmpDir);

      expect(files.map((file) => path.relative(tmpDir, file))).toEqual([
        path.join("memory", "notes.md"),
      ]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "skips a symlink when building a file entry",
    async () => {
      const tmpDir = getTmpDir();
      const outsideDir = path.join(tmpDir, "outside");
      fsSync.mkdirSync(outsideDir, { recursive: true });
      const realPath = path.join(outsideDir, "kept.md");
      fsSync.writeFileSync(realPath, "# Kept");
      const linkedPath = path.join(tmpDir, "linked.md");
      expect(tryCreateSymlink(realPath, linkedPath)).toBe(true);

      await expect(buildFileEntry(linkedPath, tmpDir)).resolves.toBeNull();
      const entry = expectFileEntry(await buildFileEntry(realPath, tmpDir));
      expect(entry.path).toBe(path.relative(tmpDir, realPath));
    },
  );

  it("allows top-level dreams path casing variants", () => {
    expect(isMemoryPath("USER.md")).toBe(true);
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
      expect(() => encodeURIComponent(chunk.text)).not.toThrow();
    }
  });

  it("preserves a surrogate pair at the coarse split boundary", () => {
    const text = `${"a".repeat(39)}🌸${"b".repeat(39)}`;

    const chunks = chunkMarkdown(text, { tokens: 10, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    for (const chunk of chunks) {
      expect(() => encodeURIComponent(chunk.text)).not.toThrow();
    }
  });

  it("chunks top-level curated entries without carrying neighboring bullets", () => {
    const text = [
      "# Curated memory",
      "",
      "- Alpha entry",
      "  alpha continuation",
      "- Beta entry",
      "  beta continuation",
      "- Global entry",
    ].join("\n");

    const chunks = chunkMarkdown(text, { tokens: 400, overlap: 40, perEntry: true });

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "# Curated memory\n",
      "- Alpha entry\n  alpha continuation",
      "- Beta entry\n  beta continuation",
      "- Global entry",
    ]);
    expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 7],
    ]);
    expect(chunks.map((chunk) => [chunk.entryStartLine, chunk.entryEndLine])).toEqual([
      [undefined, undefined],
      [3, 4],
      [5, 6],
      [7, 7],
    ]);
  });

  it("strips recall annotation carriers while preserving source line positions", () => {
    const text = [
      "- Keep the gateway local. <!-- trigger: gateway setup --> <!-- importance: 9 -->",
      "  <!-- project: github.com/openclaw/openclaw -->",
      "  Keep this ordinary <!-- note: visible --> comment.",
    ].join("\n");

    const stripped = stripMemoryAnnotationCarriers(text);

    expect(stripped).toBe(
      [
        "- Keep the gateway local.",
        "",
        "  Keep this ordinary <!-- note: visible --> comment.",
      ].join("\n"),
    );
    expect(stripped.split("\n")).toHaveLength(text.split("\n").length);
  });

  it("keeps promotion headings and markers out of neighboring entries", () => {
    const text = [
      "- Alpha entry <!-- project: github.com/acme/alpha -->",
      "### Project: github.com/acme/beta",
      "",
      "<!-- openclaw-memory-promotion:memory:beta -->",
      "- Beta entry <!-- project: github.com/acme/beta -->",
    ].join("\n");

    const chunks = chunkMarkdown(text, { tokens: 400, overlap: 40, perEntry: true });

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "- Alpha entry <!-- project: github.com/acme/alpha -->",
      "### Project: github.com/acme/beta\n\n<!-- openclaw-memory-promotion:memory:beta -->",
      "- Beta entry <!-- project: github.com/acme/beta -->",
    ]);
    expect(chunks.map((chunk) => [chunk.entryStartLine, chunk.entryEndLine])).toEqual([
      [1, 1],
      [undefined, undefined],
      [5, 5],
    ]);
  });

  it("remaps chunk lines using JSONL source line maps", () => {
    const lineMap = [4, 6, 7, 10, 13];
    const chunks = chunkMarkdown(
      "User: Hello\nAssistant: Hi\nUser: Question\nAssistant: Answer\nUser: Thanks",
      { tokens: 400, overlap: 0 },
    );

    remapChunkLines(chunks, lineMap);

    expect(expectDefined(chunks[0], "chunks[0] test invariant").startLine).toBe(4);
    expect(
      expectDefined(chunks[chunks.length - 1], "chunks[chunks.length - 1] test invariant").endLine,
    ).toBe(13);
  });
});
