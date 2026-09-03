// File Transfer tests cover dir fetch tar validation through the tool boundary.
import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DIR_FETCH_HARD_MAX_BYTES, FILE_TRANSFER_SUBDIR } from "./descriptors.js";

const appendFileTransferAudit = vi.fn(async () => undefined);
const saveMediaBuffer = vi.fn<() => Promise<{ path: string }>>();
const invokeNodeToolPayload = vi.fn<typeof import("./node-tool-invoke.js").invokeNodeToolPayload>();
let createDirFetchTool: typeof import("./dir-fetch-tool.js").createDirFetchTool;
let tmpRoot: string;

beforeAll(async () => {
  // Keep the real archive runtime stable; only the node payload and saved path vary per case.
  vi.resetModules();
  vi.doMock("openclaw/plugin-sdk/media-store", () => ({ saveMediaBuffer }));
  vi.doMock("../shared/audit.js", () => ({ appendFileTransferAudit }));
  vi.doMock("./node-tool-invoke.js", () => ({
    readRequiredNodePath: (params: Record<string, unknown>) => ({
      node: String(params.node),
      requestedPath: String(params.path),
    }),
    invokeNodeToolPayload,
  }));
  ({ createDirFetchTool } = await import("./dir-fetch-tool.js"));
});

beforeEach(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dir-fetch-tool-test-")));
});

afterEach(async () => {
  appendFileTransferAudit.mockReset();
  saveMediaBuffer.mockReset();
  invokeNodeToolPayload.mockReset();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/media-store");
  vi.doUnmock("../shared/audit.js");
  vi.doUnmock("./node-tool-invoke.js");
  vi.resetModules();
});

async function createTarBuffer(params: {
  entries: string[];
  setup: (sourceDir: string) => Promise<void>;
}): Promise<Buffer> {
  const sourceDir = path.join(tmpRoot, `source-${randomUUID()}`);
  await fs.mkdir(sourceDir, { recursive: true });
  await params.setup(sourceDir);
  const chunks: Buffer[] = [];
  for await (const chunk of tar.c({ cwd: sourceDir, gzip: true, portable: true }, params.entries)) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

type RawTarEntry = {
  path: string;
  contents?: string;
  type?: tar.Header["type"];
  linkpath?: string;
};

function createRawTarBuffer(entries: RawTarEntry[]): Buffer {
  const blocks = entries.flatMap(({ path: entryPath, contents = "", type = "File", linkpath }) => {
    const payload = Buffer.from(contents);
    const block = Buffer.alloc(512);
    const header = new tar.Header({
      path: entryPath,
      type,
      linkpath,
      size: payload.byteLength,
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: new Date(0),
    });
    // Bypass tar.c and filesystem naming rules without letting the header encoder
    // truncate, split, or normalize the raw path these security cases exercise.
    expect(Buffer.byteLength(entryPath)).toBeLessThan(100);
    expect(header.encode(block)).toBe(false);
    expect(block.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "")).toBe(entryPath);
    return [block, payload, Buffer.alloc((512 - (payload.byteLength % 512)) % 512)];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function pathOverrideEntries(
  format: "PAX" | "GNU",
  rawPath: string,
  effectivePath: string,
): RawTarEntry[] {
  return [
    format === "PAX"
      ? {
          path: "PaxHeader",
          type: "ExtendedHeader",
          contents: new tar.Pax({ path: effectivePath }).encodeBody(),
        }
      : { path: "././@LongLink", type: "NextFileHasLongPath", contents: `${effectivePath}\0` },
    { path: rawPath, contents: "normalized" },
  ];
}

function prepareArchive(tarBuffer: Buffer) {
  const mediaDir = path.join(tmpRoot, "media");
  const archivePath = path.join(mediaDir, `archive-${randomUUID()}.tar.gz`);
  saveMediaBuffer.mockImplementation(async () => {
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(archivePath, tarBuffer);
    return { path: archivePath };
  });
  invokeNodeToolPayload.mockImplementation(async () => ({
    nodeId: "node-1",
    nodeDisplayName: "Node One",
    payload: {
      ok: true,
      path: "/tmp/project",
      tarBase64: tarBuffer.toString("base64"),
      tarBytes: tarBuffer.byteLength,
      sha256: crypto.createHash("sha256").update(tarBuffer).digest("hex"),
      fileCount: 3,
    },
    startedAt: Date.now(),
  }));
  return { archivePath, mediaDir };
}

async function executeDirFetch() {
  return await createDirFetchTool().execute("tool-call-1", {
    node: "node-1",
    path: "/tmp/project",
  });
}

async function expectUnsafeArchive(
  entries: RawTarEntry[],
  causeCode: "entry-path" | "entry-filtered" = "entry-path",
  message = /^dir\.fetch UNSAFE_ARCHIVE:/u,
) {
  const { archivePath, mediaDir } = prepareArchive(createRawTarBuffer(entries));
  await expect(executeDirFetch()).rejects.toMatchObject({
    message: expect.stringMatching(message),
    cause: { name: "ArchiveSecurityError", code: causeCode },
  });
  await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.readdir(mediaDir)).resolves.toEqual([]);
  expect(appendFileTransferAudit).toHaveBeenLastCalledWith(
    expect.objectContaining({ decision: "error", errorCode: "UNSAFE_ARCHIVE" }),
  );
}

describe("dir.fetch archive extraction", () => {
  it("extracts a bounded tar and returns the plugin-side manifest", async () => {
    const tarBuffer = await createTarBuffer({
      entries: ["ok.txt", "nested", ".root-note", ".hidden"],
      setup: async (sourceDir) => {
        await fs.writeFile(path.join(sourceDir, "ok.txt"), "ok");
        await fs.mkdir(path.join(sourceDir, "nested"));
        await fs.writeFile(path.join(sourceDir, "nested", "also-ok.txt"), "also ok");
        await fs.writeFile(path.join(sourceDir, ".root-note"), "hidden root");
        await fs.mkdir(path.join(sourceDir, ".hidden"));
        await fs.writeFile(path.join(sourceDir, ".hidden", "note.txt"), "hidden member");
      },
    });
    prepareArchive(tarBuffer);

    const result = await executeDirFetch();

    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Fetched 4 files") }],
      details: {
        path: "/tmp/project",
        fileCount: 4,
      },
    });
    const files = (result.details as { files: Array<{ relPath: string; localPath: string }> })
      .files;
    expect(files).toHaveLength(4);
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relPath: "ok.txt",
          size: 2,
          sha256: crypto.createHash("sha256").update("ok").digest("hex"),
        }),
        expect.objectContaining({
          relPath: path.join("nested", "also-ok.txt"),
          size: 7,
          sha256: crypto.createHash("sha256").update("also ok").digest("hex"),
        }),
      ]),
    );
    const localPath = files.find((file) => file.relPath === "ok.txt")?.localPath;
    await expect(fs.readFile(localPath!, "utf8")).resolves.toBe("ok");
    for (const [relPath, contents] of [
      [".root-note", "hidden root"],
      [path.join(".hidden", "note.txt"), "hidden member"],
    ]) {
      const hiddenFile = files.find((file) => file.relPath === relPath);
      expect(hiddenFile).toBeDefined();
      await expect(fs.readFile(hiddenFile!.localPath, "utf8")).resolves.toBe(contents);
    }
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      tarBuffer,
      "application/gzip",
      FILE_TRANSFER_SUBDIR,
      DIR_FETCH_HARD_MAX_BYTES,
    );
    expect(appendFileTransferAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: "allowed" }),
    );
  });

  it.each(["SymbolicLink", "Link", "CharacterDevice", "BlockDevice", "FIFO"] as const)(
    "rejects a Fleet-shaped archive containing a %s",
    async (type) => {
      // A symlink entry used to hang extraction instead of rejecting; the test
      // timeout bounds settling without a wall-clock race, including on Windows.
      await expectUnsafeArchive(
        [
          { path: "data", type: "Directory" },
          { path: "data/state.json", contents: "{}" },
          { path: "auth", type: "Directory" },
          { path: "auth/token", contents: "secret" },
          {
            path: "data/token-link",
            type,
            ...(type === "SymbolicLink" || type === "Link" ? { linkpath: "../auth/token" } : {}),
          },
        ],
        "entry-filtered",
        /dir\.fetch UNSAFE_ARCHIVE:.*link/iu,
      );
    },
  );

  it.each([
    {
      name: "backslash",
      entries: [{ path: "dir\\note.txt", contents: "normalized" }],
      expectedPath: ["dir", "note.txt"],
    },
    {
      name: "mixed separators and dots",
      entries: [{ path: "./pkg//dir\\note.txt", contents: "normalized" }],
      expectedPath: ["pkg", "dir", "note.txt"],
    },
    ...(["PAX", "GNU"] as const).map((format) => ({
      name: `${format} override`,
      entries: pathOverrideEntries(format, "raw.txt", "./pkg//dir\\note.txt"),
      expectedPath: ["pkg", "dir", "note.txt"],
    })),
  ])(
    "extracts canonical $name names beneath the destination",
    async ({ entries, expectedPath }) => {
      const { mediaDir } = prepareArchive(createRawTarBuffer(entries));
      const result = await executeDirFetch();
      const details = result.details as {
        rootDir: string;
        files: Array<{ relPath: string; localPath: string }>;
      };
      expect(details.files).toMatchObject([
        {
          relPath: path.join(...expectedPath),
          localPath: path.join(details.rootDir, ...expectedPath),
        },
      ]);
      expect(path.dirname(details.rootDir)).toBe(mediaDir);
      await expect(fs.readFile(details.files[0]!.localPath, "utf8")).resolves.toBe("normalized");
      expect(appendFileTransferAudit).toHaveBeenLastCalledWith(
        expect.objectContaining({ decision: "allowed" }),
      );
    },
  );

  it.each([
    "../escape.txt",
    "..\\escape.txt",
    "dir/../escape.txt",
    "dir\\..\\escape.txt",
    "dir/..\\escape.txt",
    "dir\\../escape.txt",
    "a/b\\..\\escape.txt",
    "/escape.txt",
    "\\escape.txt",
    "\\\\server\\share\\escape.txt",
    "C:/escape.txt",
    "C:\\escape.txt",
    "C:escape.txt",
    "dir/C:escape.txt",
  ])("rejects unsafe raw path %j", async (entryPath) => {
    await expectUnsafeArchive([{ path: entryPath, contents: "blocked" }]);
  });

  it.each(["PAX", "GNU"] as const)(
    "does not let a safe %s override hide an unsafe raw name",
    async (format) => {
      await expectUnsafeArchive(pathOverrideEntries(format, "dir\\..\\escape.txt", "safe.txt"));
    },
  );

  it.each(["dir\\note.txt", "./dir//note.txt"])(
    "rejects canonical collision with %j",
    async (entryPath) => {
      await expectUnsafeArchive([
        { path: "dir/note.txt", contents: "first" },
        { path: entryPath, contents: "second" },
      ]);
    },
  );

  it("maps single-entry expansion limits to TREE_TOO_LARGE", async () => {
    const tarBuffer = await createTarBuffer({
      entries: ["large.bin"],
      setup: async (sourceDir) => {
        await fs.writeFile(path.join(sourceDir, "large.bin"), Buffer.alloc(16 * 1024 * 1024 + 1));
      },
    });
    const { archivePath, mediaDir } = prepareArchive(tarBuffer);

    await expect(executeDirFetch()).rejects.toThrow(
      /dir\.fetch UNCOMPRESSED_TOO_LARGE: archive entry extracted size exceeds limit/iu,
    );
    await expect(fs.access(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(mediaDir)).resolves.toEqual([]);
    expect(appendFileTransferAudit).toHaveBeenLastCalledWith(
      expect.objectContaining({ decision: "error", errorCode: "TREE_TOO_LARGE" }),
    );
  });
});
