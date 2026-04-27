import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.ts";
import { isPathWithinBase } from "../../test/helpers/paths.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

describe("media store", () => {
  let store: typeof import("./store.js");
  let home = "";
  let tempHome: TempHomeEnv;

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-test-home-");
    home = tempHome.home;
    store = await import("./store.js");
  });

  afterAll(async () => {
    try {
      await tempHome.restore();
    } catch {
      // ignore cleanup failures in tests
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function withTempStore<T>(
    fn: (store: typeof import("./store.js"), home: string) => Promise<T>,
  ): Promise<T> {
    return await fn(store, home);
  }

  async function expectOriginalFilenameCase(params: {
    filename: string;
    expected: string;
    basePath?: string;
  }) {
    await withTempStore(async (store) => {
      expect(
        store.extractOriginalFilename(`${params.basePath ?? "/path/to"}/${params.filename}`),
      ).toBe(params.expected);
    });
  }

  async function expectRetryAfterPrunedWriteCase(params: {
    segment: string;
    run: (store: typeof import("./store.js"), home: string) => Promise<{ path: string }>;
  }) {
    await withTempStore(async (store, home) => {
      const originalWriteFile = fs.writeFile.bind(fs);
      let injectedEnoent = false;
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        const [filePath] = args;
        if (
          !injectedEnoent &&
          typeof filePath === "string" &&
          filePath.includes(`${path.sep}${params.segment}${path.sep}`)
        ) {
          injectedEnoent = true;
          await fs.rm(path.dirname(filePath), { recursive: true, force: true });
          const err = new Error("missing dir") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return await originalWriteFile(...args);
      });

      const saved = await params.run(store, home);
      const savedStat = await fs.stat(saved.path);
      expect(injectedEnoent).toBe(true);
      expect(savedStat.isFile()).toBe(true);
    });
  }

  async function expectSavedOriginalFilenameCase(params: {
    originalFilename?: string;
    expectedIdPattern: RegExp;
    expectedExtractedFilename?: string;
    expectUuidOnly?: boolean;
    maxBaseNameLength?: number;
  }) {
    await withTempStore(async (store) => {
      const saved = await store.saveMediaBuffer(
        Buffer.from("test content"),
        "text/plain",
        "inbound",
        5 * 1024 * 1024,
        params.originalFilename,
      );

      expect(saved.id).toMatch(params.expectedIdPattern);
      if (params.expectedExtractedFilename) {
        expect(store.extractOriginalFilename(saved.path)).toBe(params.expectedExtractedFilename);
      }
      if (params.expectUuidOnly) {
        expect(saved.id).not.toContain("---");
      }
      if (params.maxBaseNameLength !== undefined) {
        const baseName = path.parse(saved.id).name.split("---")[0];
        expect(baseName.length).toBeLessThanOrEqual(params.maxBaseNameLength);
      }
    });
  }

  async function expectSavedSourceCase(params: {
    relativeSourcePath: string;
    contents: string | Buffer;
    expectedContentType?: string;
    expectedExtension?: string;
    mutateSource?: (filePath: string) => Promise<void>;
    assertSaved: (saved: Awaited<ReturnType<typeof store.saveMediaSource>>) => Promise<void> | void;
  }) {
    await withTempStore(async (store, home) => {
      const sourcePath = path.join(home, params.relativeSourcePath);
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, params.contents);
      await params.mutateSource?.(sourcePath);
      const saved = await store.saveMediaSource(sourcePath);
      if (params.expectedContentType) {
        expect(saved.contentType).toBe(params.expectedContentType);
      }
      if (params.expectedExtension) {
        expect(path.extname(saved.path)).toBe(params.expectedExtension);
      }
      await params.assertSaved(saved);
    });
  }

  async function expectCleanedSavedSourceCase(params: {
    relativeSourcePath: string;
    contents: string | Buffer;
    expectedExtension: string;
    expectedSize: number;
  }) {
    await expectSavedSourceCase({
      relativeSourcePath: params.relativeSourcePath,
      contents: params.contents,
      expectedExtension: params.expectedExtension,
      assertSaved: async (saved) => {
        expect(saved.size).toBe(params.expectedSize);
        const savedStat = await fs.stat(saved.path);
        expect(savedStat.isFile()).toBe(true);
        const past = Date.now() - 10_000;
        await fs.utimes(saved.path, past / 1000, past / 1000);
        await store.cleanOldMedia(1);
        await expect(fs.stat(saved.path)).rejects.toThrow();
      },
    });
  }

  async function expectSavedBufferCase(params: {
    buffer: Buffer;
    contentType?: string;
    originalFilename?: string;
    expectedContentType: string;
    expectedExtension: string;
    assertSaved?: (
      saved: Awaited<ReturnType<typeof store.saveMediaBuffer>>,
      buffer: Buffer,
    ) => Promise<void> | void;
  }) {
    await withTempStore(async (store) => {
      const saved = await store.saveMediaBuffer(
        params.buffer,
        params.contentType,
        "inbound",
        5 * 1024 * 1024,
        params.originalFilename,
      );
      expect(saved.contentType).toBe(params.expectedContentType);
      expect(saved.path.endsWith(params.expectedExtension)).toBe(true);
      await params.assertSaved?.(saved, params.buffer);
    });
  }

  async function expectRejectedSourceCase(params: {
    relativeSourcePath?: string;
    setupSource?: (home: string) => Promise<string>;
    expectedError: string | Record<string, unknown>;
  }) {
    await withTempStore(async (store, home) => {
      const sourcePath =
        params.setupSource !== undefined
          ? await params.setupSource(home)
          : path.join(home, params.relativeSourcePath ?? "");
      const rejection = expect(store.saveMediaSource(sourcePath)).rejects;
      if (typeof params.expectedError === "string") {
        await rejection.toThrow(params.expectedError);
        return;
      }
      await rejection.toMatchObject(params.expectedError);
    });
  }

  async function createSymlinkSource(home: string) {
    const target = path.join(home, "sensitive.txt");
    const source = path.join(
      home,
      `source-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
    );
    await fs.writeFile(target, "sensitive");
    await fs.rm(source, { force: true });
    await fs.symlink(target, source);
    return source;
  }

  async function expectCleanupBehaviorCase(params: {
    setup: (store: typeof import("./store.js")) => Promise<{
      removedFiles: string[];
      preservedFiles: string[];
      removedDirs?: string[];
      preservedDirs?: string[];
    }>;
    run: (store: typeof import("./store.js")) => Promise<void>;
  }) {
    await withTempStore(async (store) => {
      const state = await params.setup(store);
      await params.run(store);
      for (const removedFile of state.removedFiles) {
        await expect(fs.stat(removedFile)).rejects.toThrow();
      }
      for (const preservedFile of state.preservedFiles) {
        const stat = await fs.stat(preservedFile);
        expect(stat.isFile()).toBe(true);
      }
      for (const removedDir of state.removedDirs ?? []) {
        await expect(fs.stat(removedDir)).rejects.toThrow();
      }
      for (const preservedDir of state.preservedDirs ?? []) {
        const stat = await fs.stat(preservedDir);
        expect(stat.isDirectory()).toBe(true);
      }
    });
  }

  async function expectTempStoreCase(run: () => Promise<void>) {
    await run();
  }

  it.each([
    {
      name: "creates and returns media directory",
      run: async () => {
        await withTempStore(async (store, home) => {
          const dir = await store.ensureMediaDir();
          expect(isPathWithinBase(home, dir)).toBe(true);
          expect(path.normalize(dir)).toContain(`${path.sep}.openclaw${path.sep}media`);
          const stat = await fs.stat(dir);
          expect(stat.isDirectory()).toBe(true);
        });
      },
    },
    {
      name: "enforces the media size limit",
      run: async () => {
        await withTempStore(async (store) => {
          const huge = Buffer.alloc(5 * 1024 * 1024 + 1);
          await expect(store.saveMediaBuffer(huge)).rejects.toThrow("Media exceeds 5MB limit");
        });
      },
    },
    {
      name: "allows callers to override the default source size limit",
      run: async () => {
        await withTempStore(async (store, home) => {
          const sourcePath = path.join(home, "large-source.bin");
          await fs.writeFile(sourcePath, Buffer.alloc(6 * 1024 * 1024, 0x41));

          const saved = await store.saveMediaSource(
            sourcePath,
            undefined,
            "outbound",
            8 * 1024 * 1024,
          );

          expect(saved.size).toBe(6 * 1024 * 1024);
        });
      },
    },
    {
      name: "reports the effective source size limit in too-large errors",
      run: async () => {
        await withTempStore(async (store, home) => {
          const sourcePath = path.join(home, "too-large-source.bin");
          await fs.writeFile(sourcePath, Buffer.alloc(7 * 1024 * 1024, 0x41));

          await expect(
            store.saveMediaSource(sourcePath, undefined, "outbound", 6 * 1024 * 1024),
          ).rejects.toThrow("Media exceeds 6MB limit");
        });
      },
    },
    {
      name: "retries buffer writes when cleanup prunes the target directory",
      run: async () => {
        await expectRetryAfterPrunedWriteCase({
          segment: "race-buffer",
          run: async (store) => {
            return await store.saveMediaBuffer(Buffer.from("hello"), "text/plain", "race-buffer");
          },
        });
      },
    },
    {
      name: "retries local-source writes when cleanup prunes the target directory",
      run: async () => {
        await expectRetryAfterPrunedWriteCase({
          segment: "race-source",
          run: async (store, home) => {
            const srcFile = path.join(home, "tmp-src-race.txt");
            await fs.writeFile(srcFile, "local file");
            return await store.saveMediaSource(srcFile, undefined, "race-source");
          },
        });
      },
    },
    {
      name: "rejects directory sources with typed error code",
      run: async () => {
        await expectRejectedSourceCase({
          setupSource: async (home) => home,
          expectedError: { code: "not-file" },
        });
      },
    },
    {
      name: "cleans old media files in first-level subdirectories",
      run: async () => {
        await withTempStore(async (store) => {
          const saved = await store.saveMediaBuffer(Buffer.from("nested"), "text/plain", "inbound");
          const inboundDir = path.dirname(saved.path);
          const past = Date.now() - 10_000;
          await fs.utimes(saved.path, past / 1000, past / 1000);

          await store.cleanOldMedia(1);

          await expect(fs.stat(saved.path)).rejects.toThrow();
          const inboundStat = await fs.stat(inboundDir);
          expect(inboundStat.isDirectory()).toBe(true);
        });
      },
    },
  ] as const)("$name", async ({ run }) => {
    await expectTempStoreCase(run);
  });

  it.each([
    {
      name: "saves text buffers with the expected size and extension",
      buffer: Buffer.from("hello"),
      contentType: "text/plain",
      expectedContentType: "text/plain",
      expectedExtension: ".txt",
      assertSaved: async (
        saved: Awaited<ReturnType<typeof store.saveMediaBuffer>>,
        buffer: Buffer,
      ) => {
        const savedStat = await fs.stat(saved.path);
        expect(savedStat.size).toBe(buffer.length);
      },
    },
    {
      name: "saves jpeg buffers with the detected extension",
      bufferFactory: async () => {
        return await sharp({
          create: { width: 2, height: 2, channels: 3, background: "#123456" },
        })
          .jpeg({ quality: 80 })
          .toBuffer();
      },
      contentType: "image/jpeg",
      expectedContentType: "image/jpeg",
      expectedExtension: ".jpg",
    },
    {
      name: "preserves original extension for generic file buffers",
      buffer: Buffer.from("custom binary"),
      contentType: "application/octet-stream",
      originalFilename: "report.custom",
      expectedContentType: "application/octet-stream",
      expectedExtension: ".custom",
    },
  ] as const)("$name", async (testCase) => {
    const buffer =
      "bufferFactory" in testCase && testCase.bufferFactory
        ? await testCase.bufferFactory()
        : testCase.buffer;
    await expectSavedBufferCase({
      buffer,
      contentType: testCase.contentType,
      ...("originalFilename" in testCase ? { originalFilename: testCase.originalFilename } : {}),
      expectedContentType: testCase.expectedContentType,
      expectedExtension: testCase.expectedExtension,
      ...("originalFilename" in testCase
        ? {
            assertSaved: async (saved: Awaited<ReturnType<typeof store.saveMediaBuffer>>) => {
              expect(path.basename(saved.path)).toMatch(/^report---.+\.custom$/);
            },
          }
        : {}),
      ...("assertSaved" in testCase ? { assertSaved: testCase.assertSaved } : {}),
    });
  });

  it("copies local files and cleans old media", async () => {
    await expectCleanedSavedSourceCase({
      relativeSourcePath: "tmp-src.txt",
      contents: "local file",
      expectedExtension: ".txt",
      expectedSize: 10,
    });
  });

  it.runIf(process.platform !== "win32")("rejects symlink sources", async () => {
    await expectRejectedSourceCase({
      setupSource: createSymlinkSource,
      expectedError: "symlink",
    });
    await expectRejectedSourceCase({
      setupSource: createSymlinkSource,
      expectedError: { code: "invalid-path" },
    });
  });

  it.each([
    {
      name: "cleans old media files in nested subdirectories and preserves fresh siblings",
      setup: async (store: typeof import("./store.js")) => {
        const oldNested = await store.saveMediaBuffer(
          Buffer.from("old nested"),
          "text/plain",
          path.join("remote-cache", "session-1", "images"),
        );
        const freshNested = await store.saveMediaBuffer(
          Buffer.from("fresh nested"),
          "text/plain",
          path.join("remote-cache", "session-1", "docs"),
        );
        const oldFlat = await store.saveMediaBuffer(
          Buffer.from("old flat"),
          "text/plain",
          "inbound",
        );
        const past = Date.now() - 10_000;
        await fs.utimes(oldNested.path, past / 1000, past / 1000);
        await fs.utimes(oldFlat.path, past / 1000, past / 1000);
        return {
          removedFiles: [oldNested.path, oldFlat.path],
          preservedFiles: [freshNested.path],
          removedDirs: [path.dirname(oldNested.path)],
        };
      },
      run: async (store: typeof import("./store.js")) =>
        await store.cleanOldMedia(1_000, { recursive: true, pruneEmptyDirs: true }),
    },
    {
      name: "keeps nested remote-cache files during shallow cleanup",
      setup: async (store: typeof import("./store.js")) => {
        const nested = await store.saveMediaBuffer(
          Buffer.from("old nested"),
          "text/plain",
          path.join("remote-cache", "session-1", "images"),
        );
        const past = Date.now() - 10_000;
        await fs.utimes(nested.path, past / 1000, past / 1000);
        return {
          removedFiles: [],
          preservedFiles: [nested.path],
        };
      },
      run: async (store: typeof import("./store.js")) => await store.cleanOldMedia(1_000),
    },
    {
      name: "prunes empty directory chains after recursive cleanup",
      setup: async (store: typeof import("./store.js")) => {
        const nested = await store.saveMediaBuffer(
          Buffer.from("old nested"),
          "text/plain",
          path.join("remote-cache", "session-prune", "images"),
        );
        const mediaDir = await store.ensureMediaDir();
        const sessionDir = path.dirname(path.dirname(nested.path));
        const remoteCacheDir = path.dirname(sessionDir);
        const past = Date.now() - 10_000;
        await fs.utimes(nested.path, past / 1000, past / 1000);
        return {
          removedFiles: [nested.path],
          preservedFiles: [],
          removedDirs: [sessionDir],
          preservedDirs: [remoteCacheDir, mediaDir],
        };
      },
      run: async (store: typeof import("./store.js")) =>
        await store.cleanOldMedia(1_000, { recursive: true, pruneEmptyDirs: true }),
    },
  ] as const)("$name", async ({ setup, run }) => {
    await expectCleanupBehaviorCase({ setup, run });
  });

  it.runIf(process.platform !== "win32")(
    "does not follow symlinked top-level directories during recursive cleanup",
    async () => {
      await withTempStore(async (store, home) => {
        const mediaDir = await store.ensureMediaDir();
        const outsideDir = path.join(home, "outside-media");
        const outsideFile = path.join(outsideDir, "old.txt");
        const symlinkPath = path.join(mediaDir, "linked-dir");
        await fs.mkdir(outsideDir, { recursive: true });
        await fs.writeFile(outsideFile, "outside");
        const past = Date.now() - 10_000;
        await fs.utimes(outsideFile, past / 1000, past / 1000);
        await fs.symlink(outsideDir, symlinkPath);

        await store.cleanOldMedia(1_000, { recursive: true, pruneEmptyDirs: true });

        const outsideStat = await fs.stat(outsideFile);
        const symlinkStat = await fs.lstat(symlinkPath);
        expect(outsideStat.isFile()).toBe(true);
        expect(symlinkStat.isSymbolicLink()).toBe(true);
      });
    },
  );

  it.each([
    {
      name: "sets correct mime for xlsx by extension",
      relativeSourcePath: "sheet.xlsx",
      contents: "not really an xlsx",
      expectedContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      expectedExtension: ".xlsx",
      assertSaved: async () => {},
    },
    {
      name: "renames media based on detected mime even when extension is wrong",
      relativeSourcePath: "image-wrong.bin",
      contentsFactory: async () => {
        return await sharp({
          create: { width: 2, height: 2, channels: 3, background: "#00ff00" },
        })
          .png()
          .toBuffer();
      },
      expectedContentType: "image/png",
      expectedExtension: ".png",
      assertSaved: async (
        saved: Awaited<ReturnType<typeof store.saveMediaSource>>,
        contents: Buffer,
      ) => {
        const buf = await fs.readFile(saved.path);
        expect(buf.equals(contents)).toBe(true);
      },
    },
    {
      name: "sniffs xlsx mime for zip buffers and renames extension",
      relativeSourcePath: "sheet.bin",
      contentsFactory: async () => {
        const zip = new JSZip();
        zip.file(
          "[Content_Types].xml",
          '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
        );
        zip.file("xl/workbook.xml", "<workbook/>");
        return await zip.generateAsync({ type: "nodebuffer" });
      },
      expectedContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      expectedExtension: ".xlsx",
      assertSaved: async () => {},
    },
  ] as const)("$name", async (testCase) => {
    const contents =
      "contentsFactory" in testCase && testCase.contentsFactory
        ? await testCase.contentsFactory()
        : testCase.contents;
    await expectSavedSourceCase({
      relativeSourcePath: testCase.relativeSourcePath,
      contents,
      expectedContentType: testCase.expectedContentType,
      expectedExtension: testCase.expectedExtension,
      assertSaved: async (saved) => {
        if ("assertSaved" in testCase) {
          await testCase.assertSaved(saved, contents as Buffer);
        }
      },
    });
  });

  it("prefers header mime extension when sniffed mime lacks mapping", async () => {
    await withTempStore(async (_store, home) => {
      vi.doMock("./mime.js", async () => {
        const actual = await vi.importActual<typeof import("./mime.js")>("./mime.js");
        return {
          ...actual,
          detectMime: vi.fn(async () => "audio/opus"),
        };
      });

      try {
        const storeWithMock = await importFreshModule<typeof import("./store.js")>(
          import.meta.url,
          "./store.js?scope=sniffed-mime-header-extension",
        );
        const saved = await storeWithMock.saveMediaBuffer(
          Buffer.from("fake-audio"),
          "audio/ogg; codecs=opus",
        );
        expect(path.extname(saved.path)).toBe(".ogg");
        expect(saved.path.startsWith(home)).toBe(true);
      } finally {
        vi.doUnmock("./mime.js");
      }
    });
  });

  describe("extractOriginalFilename", () => {
    it.each([
      {
        name: "extracts original filename from embedded pattern",
        filename: "report---a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf",
        expected: "report.pdf",
      },
      {
        name: "handles uppercase UUID pattern",
        filename: "Document---A1B2C3D4-E5F6-7890-ABCD-EF1234567890.docx",
        expected: "Document.docx",
        basePath: "/media/inbound",
      },
      {
        name: "falls back to basename for UUID-only filenames",
        filename: "a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf",
        expected: "a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf",
        basePath: "/path",
      },
      {
        name: "falls back to basename for regular filenames",
        filename: "regular.txt",
        expected: "regular.txt",
      },
      {
        name: "falls back to basename for invalid UUID suffixes",
        filename: "foo---bar.txt",
        expected: "foo---bar.txt",
      },
      {
        name: "preserves original name with special characters",
        filename: "报告_2024---a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf",
        expected: "报告_2024.pdf",
        basePath: "/media",
      },
    ] as const)("$name", async ({ filename, expected, basePath }) => {
      await expectOriginalFilenameCase({ filename, expected, basePath });
    });
  });

  describe("saveMediaBuffer with originalFilename", () => {
    it.each([
      {
        name: "embeds original filename in stored path when provided",
        originalFilename: "report.txt",
        expectedIdPattern: /^report---[a-f0-9-]{36}\.txt$/,
        expectedExtractedFilename: "report.txt",
      },
      {
        name: "sanitizes unsafe characters in original filename",
        originalFilename: "my<file>:test.txt",
        expectedIdPattern: /^my_file_test---[a-f0-9-]{36}\.txt$/,
      },
      {
        name: "truncates long original filenames",
        originalFilename: `${"a".repeat(100)}.txt`,
        expectedIdPattern: /^a+---[a-f0-9-]{36}\.txt$/,
        maxBaseNameLength: 60,
      },
      {
        name: "falls back to UUID-only when originalFilename not provided",
        expectedIdPattern: /^[a-f0-9-]{36}\.txt$/,
        expectUuidOnly: true,
      },
    ] as const)("$name", async (testCase) => {
      await expectSavedOriginalFilenameCase(testCase);
    });
  });
});
