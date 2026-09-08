import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "./sqlite-readonly-location.js";

const MIB = 1024 * 1024;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });
});

function createFixture(bytes: Buffer) {
  const sourceRoot = tempDirs.make("openclaw-readonly-copy-source-");
  const sourcePath = path.join(sourceRoot, "source.sqlite");
  const stagingRoot = tempDirs.make("openclaw-readonly-copy-staging-");
  fs.writeFileSync(sourcePath, bytes, { mode: 0o600 });
  return { sourcePath, sourceRoot, stagingRoot };
}

function patternedBytes(size: number): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

function expectSnapshot(
  fixture: ReturnType<typeof createFixture>,
  expected: Buffer,
  inspect?: (location: string) => void,
): void {
  let prepared: ReturnType<typeof prepareSqliteReadOnlyLocationSyncInProcess> | undefined;
  try {
    prepared = prepareSqliteReadOnlyLocationSyncInProcess(fixture.sourcePath, fixture.stagingRoot);
    expect(fs.readFileSync(prepared.location).equals(expected)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(prepared.location).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(prepared.location)).mode & 0o777).toBe(0o700);
    }
    inspect?.(prepared.location);
  } finally {
    if (prepared) {
      expect(prepared.cleanup()).toBe(true);
    }
    expect(fs.readdirSync(fixture.stagingRoot)).toEqual([]);
    expect(fs.readFileSync(fixture.sourcePath).equals(expected)).toBe(true);
  }
}

function afterFirstCopy(operation: () => void): () => boolean {
  const fsync = fs.fsyncSync.bind(fs);
  let injected = false;
  vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
    fsync(descriptor);
    if (!injected) {
      injected = true;
      operation();
    }
  });
  return () => injected;
}

function interceptSourceReads(
  sourcePath: string,
  operation: (
    descriptor: number,
    buffer: NodeJS.ArrayBufferView,
    options: fs.ReadOptions,
  ) => number,
): void {
  const source = fs.statSync(sourcePath, { bigint: true });
  const read = fs.readSync.bind(fs);
  vi.spyOn(fs, "readSync").mockImplementation(
    (
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offsetOrOptions: number | fs.ReadOptions = {},
      length?: number,
      position?: fs.ReadPosition | null,
    ) => {
      const options =
        typeof offsetOrOptions === "number"
          ? { offset: offsetOrOptions, length, position }
          : offsetOrOptions;
      const opened = fs.fstatSync(descriptor, { bigint: true });
      return opened.dev === source.dev && opened.ino === source.ino
        ? operation(descriptor, buffer, options)
        : read(descriptor, buffer, options);
    },
  );
}

describe("stable read-only snapshot copies", () => {
  it.each([
    { label: "empty", size: 0 },
    { label: "partial chunk", size: 4099 },
    { label: "exact chunk", size: MIB },
    { label: "multiple chunks and a tail", size: 2 * MIB + 37 },
  ])("preserves every byte of an equal $label source", ({ size }) => {
    const bytes = patternedBytes(size);
    const fixture = createFixture(bytes);
    expectSnapshot(fixture, bytes);
    expect(fs.readdirSync(fixture.sourceRoot)).toEqual(["source.sqlite"]);
  });

  it("continues after positive short source reads", () => {
    const bytes = patternedBytes(MIB + 37);
    const fixture = createFixture(bytes);
    const read = fs.readSync.bind(fs);
    let shortened = 0;
    interceptSourceReads(fixture.sourcePath, (descriptor, buffer, options) => {
      const length = options.length ?? buffer.byteLength - (options.offset ?? 0);
      if (length > 4093) {
        shortened += 1;
      }
      return read(descriptor, buffer, { ...options, length: Math.min(length, 4093) });
    });

    expectSnapshot(fixture, bytes);
    expect(shortened).toBeGreaterThan(0);
  });

  it.each(["overwrite", "append", "truncate"] as const)(
    "retries a source that stabilizes after an intervening %s",
    (mutation) => {
      const before = patternedBytes(MIB);
      const fixture = createFixture(before);
      const after =
        mutation === "append"
          ? Buffer.concat([before, Buffer.from([251])])
          : mutation === "truncate"
            ? before.subarray(0, -1)
            : Buffer.from(before);
      if (mutation === "overwrite") {
        after.writeUInt8(after.readUInt8(after.length - 1) ^ 0xff, after.length - 1);
      }
      const injected = afterFirstCopy(() => fs.writeFileSync(fixture.sourcePath, after));

      expectSnapshot(fixture, after);
      expect(injected()).toBe(true);
      expect(fs.readdirSync(fixture.sourceRoot)).toEqual(["source.sqlite"]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "retries pathname replacement while the second pass still reads the original inode",
    () => {
      const before = patternedBytes(MIB + 37);
      const after = Buffer.from(before);
      after.writeUInt8(after.readUInt8(0) ^ 0xff, 0);
      const fixture = createFixture(before);
      const replacementPath = path.join(fixture.sourceRoot, "replacement.sqlite");
      const displacedPath = path.join(fixture.sourceRoot, "displaced.sqlite");
      fs.writeFileSync(replacementPath, after, { mode: 0o600 });
      const firstCopied = afterFirstCopy(() => {});
      const read = fs.readSync.bind(fs);
      let replaced = false;
      interceptSourceReads(fixture.sourcePath, (descriptor, buffer, options) => {
        const bytesRead = read(descriptor, buffer, options);
        const requested = options.length ?? buffer.byteLength - (options.offset ?? 0);
        // A later header probe cannot substitute for the complete second pass.
        if (firstCopied() && !replaced && bytesRead > 0 && requested > 20) {
          replaced = true;
          fs.renameSync(fixture.sourcePath, displacedPath);
          fs.renameSync(replacementPath, fixture.sourcePath);
        }
        return bytesRead;
      });

      expectSnapshot(fixture, after);
      expect(replaced).toBe(true);
      expect(fs.readFileSync(displacedPath)).toEqual(before);
      expect(fs.readdirSync(fixture.sourceRoot).toSorted()).toEqual([
        "displaced.sqlite",
        "source.sqlite",
      ]);
    },
  );

  it("releases pinned source handles when closing the private comparison handle fails", () => {
    const bytes = patternedBytes(4099);
    const fixture = createFixture(bytes);
    const closeError = Object.assign(new Error("private comparison close failed"), { code: "EIO" });
    const owned = new Map<number, { source: boolean; privateRead: boolean }>();
    const open = fs.openSync.bind(fs);
    const close = fs.closeSync.bind(fs);
    let injected = false;
    let sourcesAtFailure: number[] = [];
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, mode) => {
      const descriptor = open(pathname, flags, mode);
      const resolved = path.resolve(String(pathname));
      const source = resolved === fixture.sourcePath;
      const staged = resolved.startsWith(`${fixture.stagingRoot}${path.sep}`);
      if (source || staged) {
        owned.set(descriptor, { source, privateRead: staged && flags === "r" });
      }
      return descriptor;
    });
    const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
      const privateRead = owned.get(descriptor)?.privateRead;
      if (privateRead && !injected) {
        sourcesAtFailure = [...owned].filter(([, owner]) => owner.source).map(([fd]) => fd);
        injected = true;
        // A native close can release its descriptor before reporting an I/O error.
        close(descriptor);
        owned.delete(descriptor);
        throw closeError;
      }
      close(descriptor);
      owned.delete(descriptor);
    });

    try {
      expect(() =>
        prepareSqliteReadOnlyLocationSyncInProcess(fixture.sourcePath, fixture.stagingRoot),
      ).toThrow(closeError);
      expect(injected).toBe(true);
      for (const descriptor of sourcesAtFailure) {
        expect(() => fs.fstatSync(descriptor)).toThrowError(
          expect.objectContaining({ code: "EBADF" }),
        );
      }
    } finally {
      openSpy.mockRestore();
      closeSpy.mockRestore();
      for (const descriptor of owned.keys()) {
        close(descriptor);
      }
      expect(fs.readFileSync(fixture.sourcePath).equals(bytes)).toBe(true);
      expect(fs.readdirSync(fixture.sourceRoot)).toEqual(["source.sqlite"]);
      expect(fs.readdirSync(fixture.stagingRoot)).toEqual([]);
    }
  });

  it("snapshots a fixed 16 MiB database when staging can write one complete copy", () => {
    const fixture = createFixture(Buffer.alloc(0));
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(fixture.sourcePath);
    try {
      database.exec(`
        PRAGMA journal_mode = DELETE;
        CREATE TABLE probe (payload BLOB NOT NULL);
        INSERT INTO probe VALUES (zeroblob(${16 * MIB}));
      `);
    } finally {
      database.close();
    }
    const bytes = fs.readFileSync(fixture.sourcePath);
    const descriptors = new Set<number>();
    const open = fs.openSync.bind(fs);
    const close = fs.closeSync.bind(fs);
    const write = fs.writeSync.bind(fs);
    let written = 0;
    vi.spyOn(fs, "openSync").mockImplementation((pathname, flags, mode) => {
      const descriptor = open(pathname, flags, mode);
      if (path.resolve(String(pathname)).startsWith(`${fixture.stagingRoot}${path.sep}`)) {
        descriptors.add(descriptor);
      }
      return descriptor;
    });
    vi.spyOn(fs, "closeSync").mockImplementation((descriptor) => {
      close(descriptor);
      descriptors.delete(descriptor);
    });
    vi.spyOn(fs, "writeSync").mockImplementation(
      (
        descriptor: number,
        content: string | NodeJS.ArrayBufferView,
        offset?: number | null,
        lengthOrEncoding?: number | BufferEncoding | null,
        position?: number | null,
      ) => {
        const encoding = typeof lengthOrEncoding === "string" ? lengthOrEncoding : undefined;
        const length =
          typeof content === "string"
            ? Buffer.byteLength(content, encoding)
            : typeof lengthOrEncoding === "number"
              ? lengthOrEncoding
              : content.byteLength - (offset ?? 0);
        const staged = descriptors.has(descriptor);
        if (staged && written + length > bytes.length) {
          throw Object.assign(new Error("synthetic staging capacity exhausted"), {
            code: "ENOSPC",
          });
        }
        const count =
          typeof content === "string"
            ? write(descriptor, content, offset, encoding)
            : write(descriptor, content, offset, length, position);
        if (staged) {
          written += count;
        }
        return count;
      },
    );

    expectSnapshot(fixture, bytes, (location) => {
      const snapshot = new sqlite.DatabaseSync(location, { readOnly: true });
      try {
        expect(snapshot.prepare("SELECT length(payload) AS bytes FROM probe").get()).toEqual({
          bytes: 16 * MIB,
        });
      } finally {
        snapshot.close();
      }
    });
    expect(written).toBeLessThanOrEqual(bytes.length);
    expect(descriptors.size).toBe(0);
    expect(fs.readdirSync(fixture.sourceRoot)).toEqual(["source.sqlite"]);
  });
});
