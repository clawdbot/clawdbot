import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractArchiveInPrivateDestinationWithRegularFileAliases } from "./archive-regular-file-aliases.js";

const tempRoots: string[] = [];

afterEach(async () => {
  __setFsSafeTestHooksForTest();
  vi.restoreAllMocks();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createArchiveCase(): Promise<{
  root: string;
  archivePath: string;
  destination: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "archive-regular-aliases-"));
  tempRoots.push(root);
  const archiveRoot = path.join(root, "input", "package");
  await fs.mkdir(archiveRoot, { recursive: true });
  await fs.writeFile(path.join(archiveRoot, "server"), "x");
  await fs.writeFile(path.join(archiveRoot, "libexample.so.1"), "12345678");
  await fs.symlink("libexample.so.1", path.join(archiveRoot, "libexample.so"));
  await fs.symlink("../../../outside", path.join(archiveRoot, "unexpected-link"));
  const archivePath = path.join(root, "bundle.tar.gz");
  await tar.c({ cwd: path.join(root, "input"), file: archivePath, gzip: true }, ["package"]);
  const destination = path.join(root, "destination");
  await fs.mkdir(destination);
  return { root, archivePath, destination };
}

function extractCase(params: {
  archivePath: string;
  destination: string;
  timeoutMs?: number;
  maxExtractedBytes?: number;
  regularFileAliases?: ReadonlyArray<readonly [string, readonly string[]]>;
}) {
  return extractArchiveInPrivateDestinationWithRegularFileAliases({
    archivePath: params.archivePath,
    destDir: params.destination,
    kind: "tar",
    tarGzip: true,
    timeoutMs: params.timeoutMs ?? 15_000,
    limits: { maxEntries: 20, maxExtractedBytes: params.maxExtractedBytes ?? 64 },
    entryFilter: (entry) => (entry.kind === "symlink" ? "skip" : "extract"),
    onFiltered: "skip-entry",
    regularFileAliasRoot: "package",
    regularFileAliases: params.regularFileAliases ?? [["libexample.so.1", ["libexample.so"]]],
    requiredRegularFiles: ["server"],
  });
}

describe("extractArchiveInPrivateDestinationWithRegularFileAliases", () => {
  it("materializes only closed-manifest aliases as regular files", async () => {
    const fixture = await createArchiveCase();

    await extractCase(fixture);

    const aliasPath = path.join(fixture.destination, "package", "libexample.so");
    expect((await fs.lstat(aliasPath)).isFile()).toBe(true);
    await expect(fs.readFile(aliasPath, "utf8")).resolves.toBe("12345678");
    await expect(
      fs.lstat(path.join(fixture.destination, "package", "unexpected-link")),
    ).rejects.toThrow();
    await expect(fs.lstat(path.join(fixture.root, "outside"))).rejects.toThrow();
  });

  it("charges regular-file aliases to the combined extracted-byte budget", async () => {
    const fixture = await createArchiveCase();

    await expect(extractCase({ ...fixture, maxExtractedBytes: 16 })).rejects.toThrow(
      /archive extracted size exceeds limit/u,
    );
    await expect(
      fs.lstat(path.join(fixture.destination, "package", "libexample.so")),
    ).rejects.toThrow();
  });

  it("validates required regular files without an alias manifest", async () => {
    const fixture = await createArchiveCase();

    await expect(
      extractArchiveInPrivateDestinationWithRegularFileAliases({
        archivePath: fixture.archivePath,
        destDir: fixture.destination,
        kind: "tar",
        tarGzip: true,
        timeoutMs: 15_000,
        entryFilter: (entry) => (entry.kind === "symlink" ? "skip" : "extract"),
        onFiltered: "skip-entry",
        regularFileAliasRoot: "package",
        requiredRegularFiles: ["missing-server"],
      }),
    ).rejects.toThrow(/does not contain required regular file missing-server/u);
  });

  it("rejects a private destination that is not empty", async () => {
    const fixture = await createArchiveCase();
    const marker = path.join(fixture.destination, "marker");
    await fs.writeFile(marker, "preserve");

    await expect(extractCase(fixture)).rejects.toThrow(
      /private archive destination must be empty/u,
    );
    await expect(fs.readFile(marker, "utf8")).resolves.toBe("preserve");
  });

  it("aborts a stalled alias copy at the shared absolute deadline", async () => {
    const fixture = await createArchiveCase();
    let stalledCopies = 0;
    const destinations = ["libexample.so"];
    Object.defineProperty(destinations, Symbol.iterator, {
      *value() {
        stalledCopies += 1;
        const stalledStream = new PassThrough();
        vi.spyOn(fsSync, "createReadStream").mockImplementation(
          () => stalledStream as unknown as fsSync.ReadStream,
        );
        yield "libexample.so";
      },
    });

    await expect(
      extractCase({
        ...fixture,
        timeoutMs: 500,
        regularFileAliases: [["libexample.so.1", destinations]],
      }),
    ).rejects.toThrow(/regular-file aliases timed out/u);
    expect(stalledCopies).toBe(1);
    await expect(
      fs.lstat(path.join(fixture.destination, "package", "libexample.so")),
    ).rejects.toThrow();
  });

  it("joins a stalled extraction merge before rejecting at the shared deadline", async () => {
    const fixture = await createArchiveCase();
    let releaseMerge = () => undefined;
    const mergeReleased = new Promise<void>((resolve) => {
      releaseMerge = resolve;
    });
    let reportMergeStarted = () => undefined;
    const mergeStarted = new Promise<void>((resolve) => {
      reportMergeStarted = resolve;
    });
    let stalled = false;
    __setFsSafeTestHooksForTest({
      beforeArchiveOutputMutation: async (operation, targetPath) => {
        if (stalled || operation !== "mkdir" || !targetPath.startsWith(fixture.destination)) {
          return;
        }
        stalled = true;
        reportMergeStarted();
        await mergeReleased;
      },
    });

    const extraction = extractCase({ ...fixture, timeoutMs: 250 });
    let settled = false;
    void extraction.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await mergeStarted;
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    expect(settled).toBe(false);

    releaseMerge();
    await expect(extraction).rejects.toThrow(/timed out/u);
    await fs.rm(fixture.destination, { recursive: true, force: true });
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    await expect(fs.lstat(fixture.destination)).rejects.toThrow();
  });
});
