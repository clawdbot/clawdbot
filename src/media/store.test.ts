// Media store tests cover persisted media records and local file storage.
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core";
import JSZip from "jszip";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer, createTinyJpegBuffer } from "../../test/helpers/image-fixtures.js";
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

  async function expectPathMissing(targetPath: string): Promise<void> {
    let statError: unknown;
    try {
      await fs.stat(targetPath);
    } catch (error) {
      statError = error;
    }
    expect(statError).toBeInstanceOf(Error);
    expect((statError as NodeJS.ErrnoException).code).toBe("ENOENT");
  }

  async function expectOriginalFilenameCase(params: {
    filename: string;
    expected: string;
    basePath?: string;
  }) {
    await withTempStore(async (storeLocal23) => {
      expect(
        storeLocal23.extractOriginalFilename(`${params.basePath ?? "/path/to"}/${params.filename}`),
      ).toBe(params.expected);
    });
  }

  async function expectRetryAfterPrunedWriteCase(params: {
    segment: string;
    run: (store: typeof import("./store.js"), home: string) => Promise<{ path: string }>;
  }) {
    const mockKey = `./store.js?scope=retry-pruned-write-${params.segment}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let injectedEnoent = false;
    vi.doMock("../infra/file-store.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../infra/file-store.js")>();
      return {
        ...actual,
        fileStore: (options: Parameters<typeof actual.fileStore>[0]) => {
          const actualStore = actual.fileStore(options);
          return {
            ...actualStore,
            write: async (...args: Parameters<typeof actualStore.write>) => {
              const [relativePath] = args;
              if (!injectedEnoent && relativePath.includes(`${params.segment}${path.sep}`)) {
                injectedEnoent = true;
                await fs.rm(path.dirname(actualStore.path(relativePath)), {
                  recursive: true,
                  force: true,
                });
                const err = new Error("missing dir") as NodeJS.ErrnoException;
                err.code = "ENOENT";
                throw err;
              }
              return await actualStore.write(...args);
            },
          };
        },
      };
    });

    try {
      const storeWithMock = await importFreshModule<typeof import("./store.js")>(
        import.meta.url,
        mockKey,
      );
      await withTempStore(async (_store, homeLocal8) => {
        const saved = await params.run(storeWithMock, homeLocal8);
        const savedStat = await fs.stat(saved.path);
        expect(injectedEnoent).toBe(true);
        expect(savedStat.isFile()).toBe(true);
      });
    } finally {
      vi.doUnmock("../infra/file-store.js");
    }
  }

  async function expectFailedBufferWriteCase() {
    const mockKey = `./store.js?scope=failed-buffer-write-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const attemptedRelPaths: string[] = [];
    vi.doMock("../infra/file-store.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../infra/file-store.js")>();
      return {
        ...actual,
        fileStore: (options: Parameters<typeof actual.fileStore>[0]) => {
          const actualStore = actual.fileStore(options);
          return {
            ...actualStore,
            write: async (...args: Parameters<typeof actualStore.write>) => {
              const [relativePath] = args;
              if (relativePath.includes(`failed-buffer${path.sep}`)) {
                attemptedRelPaths.push(relativePath);
                const err = new Error("no space left on device") as NodeJS.ErrnoException;
                err.code = "ENOSPC";
                throw err;
              }
              return await actualStore.write(...args);
            },
          };
        },
      };
    });

    try {
      const storeWithMock = await importFreshModule<typeof import("./store.js")>(
        import.meta.url,
        mockKey,
      );
      await withTempStore(async (_store) => {
        const mediaDir = await storeWithMock.ensureMediaDir();
        let saveError: unknown;
        try {
          await storeWithMock.saveMediaBuffer(Buffer.from("voice"), "audio/ogg", "failed-buffer");
        } catch (error) {
          saveError = error;
        }
        expect(saveError).toBeInstanceOf(Error);
        expect((saveError as NodeJS.ErrnoException).code).toBe("ENOSPC");

        const failedDir = path.join(mediaDir, "failed-buffer");
        const entries = await fs.readdir(failedDir).catch(() => []);
        expect(attemptedRelPaths).toHaveLength(1);
        expect(path.basename(attemptedRelPaths[0] ?? "")).toMatch(/^[^/\\]+\.ogg$/);
        expect(entries).toStrictEqual([]);
      });
    } finally {
      vi.doUnmock("../infra/file-store.js");
    }
  }

  async function expectSavedOriginalFilenameCase(params: {
    originalFilename?: string;
    expectedIdPattern: RegExp;
    expectedExtractedFilename?: string;
    expectUuidOnly?: boolean;
    maxBaseNameLength?: number;
  }) {
    await withTempStore(async (storeLocal22) => {
      const saved = await storeLocal22.saveMediaBuffer(
        Buffer.from("test content"),
        "text/plain",
        "inbound",
        5 * 1024 * 1024,
        params.originalFilename,
      );

      expect(saved.id).toMatch(params.expectedIdPattern);
      if (params.expectedExtractedFilename) {
        expect(storeLocal22.extractOriginalFilename(saved.path)).toBe(
          params.expectedExtractedFilename,
        );
      }
      if (params.expectUuidOnly) {
        expect(saved.id).not.toContain("---");
      }
      if (params.maxBaseNameLength !== undefined) {
        const baseName = expectDefined(
          path.parse(saved.id).name.split("---")[0],
          'path.parse(saved.id).name.split("---")[0] test invariant',
        );
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
    await withTempStore(async (storeLocal21, homeLocal7) => {
      const sourcePath = path.join(homeLocal7, params.relativeSourcePath);
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, params.contents);
      await params.mutateSource?.(sourcePath);
      const saved = await storeLocal21.saveMediaSource(sourcePath);
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
        await expectPathMissing(saved.path);
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
    await withTempStore(async (storeLocal20) => {
      const saved = await storeLocal20.saveMediaBuffer(
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
    await withTempStore(async (storeLocal19, homeLocal6) => {
      const sourcePath =
        params.setupSource !== undefined
          ? await params.setupSource(homeLocal6)
          : path.join(homeLocal6, params.relativeSourcePath ?? "");
      if (typeof params.expectedError === "string") {
        const rejection = expect(storeLocal19.saveMediaSource(sourcePath)).rejects;
        await rejection.toThrow(params.expectedError);
        return;
      }
      let sourceError: unknown;
      try {
        await storeLocal19.saveMediaSource(sourcePath);
      } catch (error) {
        sourceError = error;
      }
      expect(sourceError).toBeInstanceOf(Error);
      for (const [key, value] of Object.entries(params.expectedError)) {
        expect((sourceError as Record<string, unknown>)[key]).toStrictEqual(value);
      }
    });
  }

  async function createSymlinkSource(homeLocal5: string) {
    const target = path.join(homeLocal5, "sensitive.txt");
    const source = path.join(
      homeLocal5,
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
    await withTempStore(async (storeLocal18) => {
      const state = await params.setup(storeLocal18);
      await params.run(storeLocal18);
      for (const removedFile of state.removedFiles) {
        await expectPathMissing(removedFile);
      }
      for (const preservedFile of state.preservedFiles) {
        const stat = await fs.stat(preservedFile);
        expect(stat.isFile()).toBe(true);
      }
      for (const removedDir of state.removedDirs ?? []) {
        await expectPathMissing(removedDir);
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
        await withTempStore(async (storeLocal17, homeLocal4) => {
          const dir = await storeLocal17.ensureMediaDir();
          expect(isPathWithinBase(homeLocal4, dir)).toBe(true);
          expect(path.normalize(dir)).toContain(`${path.sep}.openclaw${path.sep}media`);
          const stat = await fs.stat(dir);
          expect(stat.isDirectory()).toBe(true);
        });
      },
    },
    {
      name: "enforces the media size limit",
      run: async () => {
        await withTempStore(async (storeLocal16) => {
          const huge = Buffer.alloc(5 * 1024 * 1024 + 1);
          await expect(storeLocal16.saveMediaBuffer(huge)).rejects.toThrow(
            "Media exceeds 5MB limit",
          );
        });
      },
    },
    {
      name: "allows callers to override the default source size limit",
      run: async () => {
        await withTempStore(async (storeLocal15, homeLocal3) => {
          const sourcePath = path.join(homeLocal3, "large-source.bin");
          await fs.writeFile(sourcePath, Buffer.alloc(6 * 1024 * 1024, 0x41));

          const saved = await storeLocal15.saveMediaSource(
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
        await withTempStore(async (storeLocal14, homeLocal2) => {
          const sourcePath = path.join(homeLocal2, "too-large-source.bin");
          await fs.writeFile(sourcePath, Buffer.alloc(7 * 1024 * 1024, 0x41));

          await expect(
            storeLocal14.saveMediaSource(sourcePath, undefined, "outbound", 6 * 1024 * 1024),
          ).rejects.toThrow("Media exceeds 6MB limit");
        });
      },
    },
    {
      name: "retries buffer writes when cleanup prunes the target directory",
      run: async () => {
        await expectRetryAfterPrunedWriteCase({
          segment: "race-buffer",
          run: async (storeLocal13) => {
            return await storeLocal13.saveMediaBuffer(
              Buffer.from("hello"),
              "text/plain",
              "race-buffer",
            );
          },
        });
      },
    },
    {
      name: "does not leave final media artifacts when buffer writes fail",
      run: async () => {
        await expectFailedBufferWriteCase();
      },
    },
    {
      name: "saves streams with detected extension without buffering first",
      run: async () => {
        await withTempStore(async (storeLocal12) => {
          const saved = await storeLocal12.saveMediaStream(
            Readable.from([Buffer.from([0xff, 0xd8, 0xff, 0x00])]),
            undefined,
            "stream-inbound",
            1024,
            "photo.bin",
          );

          expect(saved.id).toMatch(/^photo---[a-f0-9-]{36}\.jpg$/);
          expect(saved.size).toBe(4);
          expect(saved.contentType).toBe("image/jpeg");
          await expect(fs.readFile(saved.path)).resolves.toEqual(
            Buffer.from([0xff, 0xd8, 0xff, 0x00]),
          );
        });
      },
    },
    {
      name: "uses original filename to detect generic stream content type",
      run: async () => {
        await withTempStore(async (storeLocal11) => {
          const saved = await storeLocal11.saveMediaStream(
            Readable.from([Buffer.from("name,value\none,1\n")]),
            "application/octet-stream",
            "stream-inbound",
            1024,
            "report.csv",
          );

          expect(saved.id).toMatch(/^report---[a-f0-9-]{36}\.csv$/);
          expect(saved.contentType).toBe("text/csv");
        });
      },
    },
    {
      name: "prefers detected stream mime over generic zip header extension",
      run: async () => {
        await withTempStore(async (storeLocal10) => {
          const saved = await storeLocal10.saveMediaStream(
            Readable.from([Buffer.from("docx")]),
            "application/zip",
            "stream-inbound",
            1024,
            undefined,
            "document.docx",
          );

          expect(saved.id).toMatch(/^[a-f0-9-]{36}\.docx$/);
          expect(saved.contentType).toBe(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          );
        });
      },
    },
    {
      name: "rejects oversized streams before writing a final artifact",
      run: async () => {
        await withTempStore(async (storeLocal9, homeInner) => {
          await expect(
            storeLocal9.saveMediaStream(
              Readable.from([Buffer.alloc(4), Buffer.alloc(4)]),
              "application/octet-stream",
              "oversized-stream",
              7,
            ),
          ).rejects.toThrow("Media exceeds 0MB limit");

          const targetDir = path.join(homeInner, ".openclaw", "media", "oversized-stream");
          const entries = await fs.readdir(targetDir).catch(() => []);
          expect(entries).toStrictEqual([]);
        });
      },
    },
    {
      name: "saves buffers when the best-effort fsync step reports EPERM",
      run: async () => {
        await withTempStore(async (storeLocal8) => {
          const originalOpen = fs.open.bind(fs);
          vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await originalOpen(...args);
            const filePath = args[0];
            if (
              typeof filePath === "string" &&
              filePath.includes(`${path.sep}fsync-eperm${path.sep}`)
            ) {
              vi.spyOn(handle, "sync").mockRejectedValueOnce(
                Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
              );
            }
            return handle;
          });

          const saved = await storeLocal8.saveMediaBuffer(
            Buffer.from("docx"),
            "application/zip",
            "fsync-eperm",
          );

          await expect(fs.readFile(saved.path, "utf8")).resolves.toBe("docx");
        });
      },
    },
    {
      name: "rejects traversal media subdirs before saving buffers",
      run: async () => {
        await withTempStore(async (storeLocal7, homeScoped) => {
          const mediaDir = await storeLocal7.ensureMediaDir();
          const outsideDir = path.join(homeScoped, "outside-media");
          const traversalSubdir = path.relative(mediaDir, outsideDir);

          await expect(
            storeLocal7.saveMediaBuffer(Buffer.from("escape"), "text/plain", traversalSubdir),
          ).rejects.toThrow("unsafe media subdir");
          await expectPathMissing(outsideDir);
        });
      },
    },
    {
      name: "rejects traversal media subdirs before resolving IDs",
      run: async () => {
        await withTempStore(async (storeLocal6, homeItem) => {
          const mediaDir = await storeLocal6.ensureMediaDir();
          const outsideDir = path.join(homeItem, "outside-media-resolve");
          await fs.mkdir(outsideDir, { recursive: true });
          await fs.writeFile(path.join(outsideDir, "passwd"), "not media");

          await expect(
            storeLocal6.resolveMediaBufferPath("passwd", path.relative(mediaDir, outsideDir)),
          ).rejects.toThrow("unsafe media subdir");
        });
      },
    },
    {
      name: "reads media IDs through the media root boundary",
      run: async () => {
        await withTempStore(async (storeLocal5) => {
          const saved = await storeLocal5.saveMediaBuffer(
            Buffer.from("source bytes"),
            "text/plain",
          );

          const read = await storeLocal5.readMediaBuffer(saved.id, "inbound");

          await expect(fs.realpath(read.path)).resolves.toBe(await fs.realpath(saved.path));
          expect(read.size).toBe("source bytes".length);
          expect(read.buffer.toString("utf8")).toBe("source bytes");
        });
      },
    },
    {
      name: "rejects oversized media ID reads before materializing the file",
      run: async () => {
        await withTempStore(async (storeLocal4) => {
          const saved = await storeLocal4.saveMediaBuffer(Buffer.from("too large"), "text/plain");

          await expect(storeLocal4.readMediaBuffer(saved.id, "inbound", 3)).rejects.toThrow(
            "maximum is 3 bytes",
          );
        });
      },
    },
    {
      name: "rejects traversal media subdirs before reading IDs",
      run: async () => {
        await withTempStore(async (storeLocal3, homeCandidate) => {
          const mediaDir = await storeLocal3.ensureMediaDir();
          const outsideDir = path.join(homeCandidate, "outside-media-read");
          await fs.mkdir(outsideDir, { recursive: true });
          await fs.writeFile(path.join(outsideDir, "passwd"), "not media");

          await expect(
            storeLocal3.readMediaBuffer("passwd", path.relative(mediaDir, outsideDir)),
          ).rejects.toThrow("unsafe media subdir");
        });
      },
    },
    {
      name: "retries local-source writes when cleanup prunes the target directory",
      run: async () => {
        await expectRetryAfterPrunedWriteCase({
          segment: "race-source",
          run: async (storeLocal2, homeEntry) => {
            const srcFile = path.join(homeEntry, "tmp-src-race.txt");
            await fs.writeFile(srcFile, "local file");
            return await storeLocal2.saveMediaSource(srcFile, undefined, "race-source");
          },
        });
      },
    },
    {
      name: "rejects directory sources with typed error code",
      run: async () => {
        await expectRejectedSourceCase({
          setupSource: async (homeResult) => homeResult,
          expectedError: { code: "not-file" },
        });
      },
    },
    {
      name: "cleans old media files in first-level subdirectories",
      run: async () => {
        await withTempStore(async (storeInner) => {
          const saved = await storeInner.saveMediaBuffer(
            Buffer.from("nested"),
            "text/plain",
            "inbound",
          );
          const inboundDir = path.dirname(saved.path);
          const past = Date.now() - 10_000;
          await fs.utimes(saved.path, past / 1000, past / 1000);

          await storeInner.cleanOldMedia(1);

          await expectPathMissing(saved.path);
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
        return createTinyJpegBuffer();
      },
      contentType: "image/jpeg",
      expectedContentType: "image/jpeg",
      expectedExtension: ".jpg",
    },
    {
      name: "uses original filename to detect generic buffer content type",
      buffer: Buffer.from("name,value\none,1\n"),
      contentType: "application/octet-stream",
      originalFilename: "report.csv",
      expectedContentType: "text/csv",
      expectedExtension: ".csv",
    },
    {
      name: "preserves original extension for generic file buffers",
      buffer: Buffer.from("custom binary"),
      contentType: "application/octet-stream",
      originalFilename: "report.custom",
      expectedContentType: "application/octet-stream",
      expectedExtension: ".custom",
    },
    {
      name: "does not preserve image header extensions for generic container buffers",
      bufferFactory: async () => {
        const zip = new JSZip();
        zip.file("hello.txt", "hi");
        return await zip.generateAsync({ type: "nodebuffer" });
      },
      contentType: "image/png",
      originalFilename: "fake.png",
      expectedContentType: "application/zip",
      expectedExtension: ".zip",
      assertSaved: async (saved: Awaited<ReturnType<typeof store.saveMediaBuffer>>) => {
        expect(path.basename(saved.path)).toMatch(/^fake---[a-f0-9-]{36}\.zip$/);
      },
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
              const escapedExtension = testCase.expectedExtension.replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&",
              );
              expect(path.basename(saved.path)).toMatch(
                new RegExp(`^report---.+${escapedExtension}$`),
              );
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
      setup: async (storeScoped: typeof import("./store.js")) => {
        const oldNested = await storeScoped.saveMediaBuffer(
          Buffer.from("old nested"),
          "text/plain",
          path.join("remote-cache", "session-1", "images"),
        );
        const freshNested = await storeScoped.saveMediaBuffer(
          Buffer.from("fresh nested"),
          "text/plain",
          path.join("remote-cache", "session-1", "docs"),
        );
        const oldFlat = await storeScoped.saveMediaBuffer(
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
      run: async (storeItem: typeof import("./store.js")) =>
        await storeItem.cleanOldMedia(1_000, { recursive: true, pruneEmptyDirs: true }),
    },
    {
      name: "keeps nested remote-cache files during shallow cleanup",
      setup: async (storeCandidate: typeof import("./store.js")) => {
        const nested = await storeCandidate.saveMediaBuffer(
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
      run: async (storeEntry: typeof import("./store.js")) => await storeEntry.cleanOldMedia(1_000),
    },
    {
      name: "stays at the media root during non-recursive cleanup and retains first-level subdirs",
      setup: async (storeRoot: typeof import("./store.js")) => {
        const rootFile = await storeRoot.saveMediaBuffer(Buffer.from("old root"), "text/plain", "");
        const inbound = await storeRoot.saveMediaBuffer(
          Buffer.from("retained inbound"),
          "text/plain",
          "inbound",
        );
        const past = Date.now() - 10_000;
        await fs.utimes(rootFile.path, past / 1000, past / 1000);
        await fs.utimes(inbound.path, past / 1000, past / 1000);
        return {
          // recursive:false must stay at the media root, so retained subdir media survives even
          // when older than the TTL. Guards the fs-safe maxDepth/recursive mapping in cleanOldMedia.
          removedFiles: [rootFile.path],
          preservedFiles: [inbound.path],
        };
      },
      run: async (storeNonRecursive: typeof import("./store.js")) =>
        await storeNonRecursive.cleanOldMedia(1_000, { recursive: false }),
    },
    {
      name: "prunes empty directory chains after recursive cleanup",
      setup: async (storeResult: typeof import("./store.js")) => {
        const nested = await storeResult.saveMediaBuffer(
          Buffer.from("old nested"),
          "text/plain",
          path.join("remote-cache", "session-prune", "images"),
        );
        const mediaDir = await storeResult.ensureMediaDir();
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
      run: async (storeValue: typeof import("./store.js")) =>
        await storeValue.cleanOldMedia(1_000, { recursive: true, pruneEmptyDirs: true }),
    },
  ] as const)("$name", async ({ setup, run }) => {
    await expectCleanupBehaviorCase({ setup, run });
  });

  it.runIf(process.platform !== "win32")(
    "does not follow symlinked top-level directories during recursive cleanup",
    async () => {
      await withTempStore(async (storeLocal, homeValue) => {
        const mediaDir = await storeLocal.ensureMediaDir();
        const outsideDir = path.join(homeValue, "outside-media");
        const outsideFile = path.join(outsideDir, "old.txt");
        const symlinkPath = path.join(mediaDir, "linked-dir");
        await fs.mkdir(outsideDir, { recursive: true });
        await fs.writeFile(outsideFile, "outside");
        const past = Date.now() - 10_000;
        await fs.utimes(outsideFile, past / 1000, past / 1000);
        await fs.symlink(outsideDir, symlinkPath);

        await storeLocal.cleanOldMedia(1_000, { recursive: true, pruneEmptyDirs: true });

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
        return createSolidPngBuffer(2, 2, { r: 0, g: 255, b: 0 });
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
    await withTempStore(async (_store, homeLocal) => {
      vi.doMock("@openclaw/media-core/mime", async () => {
        const actual = await vi.importActual<typeof import("@openclaw/media-core/mime")>(
          "@openclaw/media-core/mime",
        );
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
        expect(saved.path.startsWith(homeLocal)).toBe(true);
      } finally {
        vi.doUnmock("@openclaw/media-core/mime");
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
      {
        name: "extracts from Windows paths on non-Windows hosts",
        filename: "report---a1b2c3d4-e5f6-7890-abcd-ef1234567890.pdf",
        expected: "report.pdf",
        basePath: String.raw`C:\media\inbound`,
      },
      {
        name: "extracts from mixed-separator paths",
        filename: "photo---a1b2c3d4-e5f6-7890-abcd-ef1234567890.png",
        expected: "photo.png",
        basePath: String.raw`C:\media/inbound`,
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
        name: "does not split supplementary-plane letters at the filename cap",
        originalFilename: `${"a".repeat(59)}𐐀.txt`,
        expectedIdPattern: /^a{59}---[a-f0-9-]{36}\.txt$/,
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
