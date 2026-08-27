import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractArchiveWithRegularFileAliases,
  setArchiveRegularFileAliasTestHooks,
} from "./archive-regular-file-aliases.js";

const tempRoots: string[] = [];

afterEach(async () => {
  setArchiveRegularFileAliasTestHooks(undefined);
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
}) {
  return extractArchiveWithRegularFileAliases({
    archivePath: params.archivePath,
    destDir: params.destination,
    kind: "tar",
    tarGzip: true,
    timeoutMs: params.timeoutMs ?? 15_000,
    limits: { maxEntries: 20, maxExtractedBytes: params.maxExtractedBytes ?? 64 },
    entryFilter: (entry) => (entry.kind === "symlink" ? "skip" : "extract"),
    onFiltered: "skip-entry",
    regularFileAliasRoot: "package",
    regularFileAliases: [["libexample.so.1", ["libexample.so"]]],
    requiredRegularFiles: ["server"],
  });
}

describe("extractArchiveWithRegularFileAliases", () => {
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

  it("aborts a stalled alias copy at the shared absolute deadline", async () => {
    const fixture = await createArchiveCase();
    let stalledCopies = 0;
    setArchiveRegularFileAliasTestHooks({
      beforeCopy: async () => {
        stalledCopies += 1;
        await new Promise<void>(() => {
          // Intentionally unresolved: the shared absolute deadline must abort this phase.
        });
      },
    });

    await expect(extractCase({ ...fixture, timeoutMs: 500 })).rejects.toThrow(
      /regular-file aliases timed out/u,
    );
    expect(stalledCopies).toBe(1);
    await expect(
      fs.lstat(path.join(fixture.destination, "package", "libexample.so")),
    ).rejects.toThrow();
  });
});
