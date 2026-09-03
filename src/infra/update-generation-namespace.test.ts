import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  captureUpdateGenerationManifest,
  createUpdateGenerationId,
  materializeUpdateGeneration,
  removeObsoleteUpdateGeneration,
  replaceUpdateGenerationSelector,
} from "../../test/helpers/update-generation-path-store.js";
import { withTestDir } from "../test-helpers/temp-dir.js";

async function writeRuntime(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","version":"1.0.0"}\n');
  await fs.writeFile(path.join(root, "entry.mjs"), 'console.log("1.0.0");\n', { mode: 0o755 });
}

async function makeFixtureWritable(root: string): Promise<void> {
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat || stat.isSymbolicLink()) {
    return;
  }
  if (stat.isDirectory()) {
    await fs.chmod(root, stat.mode | 0o700);
    for (const entry of await fs.readdir(root)) {
      await makeFixtureWritable(path.join(root, entry));
    }
  } else {
    await fs.chmod(root, stat.mode | 0o600);
  }
}

async function withGenerationTestDir(run: (base: string) => Promise<void>): Promise<void> {
  await withTestDir({ prefix: "openclaw-generation-owned-root-swap-" }, async (base) => {
    try {
      await run(base);
    } finally {
      await makeFixtureWritable(base);
    }
  });
}

async function snapshotTreeBytesAndMetadata(root: string) {
  const entries: Array<Record<string, string | number>> = [];
  const walk = async (current: string, relativePath: string): Promise<void> => {
    const stat = await fs.lstat(current, { bigint: true });
    const entry: Record<string, string | number> = {
      path: relativePath,
      mode: Number(stat.mode),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
    };
    if (stat.isSymbolicLink()) {
      entry.type = "symlink";
      entry.contents = await fs.readlink(current);
    } else if (stat.isDirectory()) {
      entry.type = "directory";
    } else {
      entry.type = "file";
      entry.contents = (await fs.readFile(current)).toString("base64");
    }
    entries.push(entry);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const child of (await fs.readdir(current)).toSorted()) {
        await walk(path.join(current, child), relativePath ? `${relativePath}/${child}` : child);
      }
    }
  };
  await walk(root, ".");
  return entries;
}

async function listGenerationResidue(root: string): Promise<string[]> {
  const residue: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const child of await fs.readdir(current, { withFileTypes: true })) {
      const childPath = path.join(current, child.name);
      if (/^\.(?:incoming|retired|selector|launcher)-/u.test(child.name)) {
        residue.push(childPath);
      }
      if (child.isDirectory() && !child.isSymbolicLink()) {
        await walk(childPath);
      }
    }
  };
  await walk(root);
  return residue;
}

describe("update generation namespace mutation boundaries", () => {
  it.each(
    (["materialize", "select", "cleanup"] as const).flatMap((operation) =>
      (["namespace", "generations"] as const).map((rootKind) => ({ operation, rootKind })),
    ),
  )(
    "rejects a $rootKind swap before $operation without touching the external target",
    async ({ operation, rootKind }) => {
      await withGenerationTestDir(async (base) => {
        const namespaceRoot = path.join(base, "managed");
        const generationsRoot = path.join(namespaceRoot, "generations");
        const stageRoot = path.join(base, "stage");
        const outsideRoot = path.join(base, "outside");
        await Promise.all([
          fs.mkdir(generationsRoot, { recursive: true }),
          writeRuntime(stageRoot),
          fs.mkdir(outsideRoot),
        ]);
        await fs.writeFile(path.join(outsideRoot, "sentinel"), "external bytes");
        const generationId = createUpdateGenerationId();
        const manifest = await captureUpdateGenerationManifest(stageRoot);
        let existing: Awaited<ReturnType<typeof materializeUpdateGeneration>> | null = null;
        if (operation !== "materialize") {
          existing = await materializeUpdateGeneration({
            namespaceRoot,
            sourceRoot: stageRoot,
            generationId,
            expectedManifest: manifest,
            packageVersion: "1.0.0",
            entrypointRelativePath: "entry.mjs",
          });
        }
        const targetRoot = rootKind === "namespace" ? namespaceRoot : generationsRoot;
        const heldRoot = `${targetRoot}.held`;
        const externalBefore = await snapshotTreeBytesAndMetadata(outsideRoot);
        const realRealpath = fs.realpath.bind(fs);
        let swapped = false;
        const realpath = vi.spyOn(fs, "realpath").mockImplementation(async (requestedPath) => {
          if (!swapped && path.resolve(String(requestedPath)) === path.resolve(targetRoot)) {
            swapped = true;
            await fs.rename(targetRoot, heldRoot);
            await fs.symlink(
              outsideRoot,
              targetRoot,
              process.platform === "win32" ? "junction" : undefined,
            );
          }
          return await realRealpath(requestedPath);
        });
        try {
          if (operation === "materialize") {
            await expect(
              materializeUpdateGeneration({
                namespaceRoot,
                sourceRoot: stageRoot,
                generationId,
                expectedManifest: manifest,
                packageVersion: "1.0.0",
                entrypointRelativePath: "entry.mjs",
              }),
            ).rejects.toThrow(/Invalid update generation|changed during path resolution/u);
          } else if (operation === "select") {
            if (!existing) {
              throw new Error("selector fixture is missing its generation");
            }
            const { packageVersion: _packageVersion, ...next } = existing.generation;
            await expect(
              replaceUpdateGenerationSelector({ namespaceRoot, expected: null, next }),
            ).rejects.toThrow(/Invalid update generation|changed during path resolution/u);
          } else {
            await expect(
              removeObsoleteUpdateGeneration({
                namespaceRoot,
                generationId,
                protectedGenerationIds: [],
              }),
            ).rejects.toThrow(/Invalid update generation|changed during path resolution/u);
          }
        } finally {
          realpath.mockRestore();
        }
        expect(swapped).toBe(true);
        expect(await snapshotTreeBytesAndMetadata(outsideRoot)).toEqual(externalBefore);
        const retainedNamespace = rootKind === "namespace" ? heldRoot : namespaceRoot;
        const retainedGenerations =
          rootKind === "namespace" ? path.join(heldRoot, "generations") : heldRoot;
        await expect(listGenerationResidue(retainedNamespace)).resolves.toEqual([]);
        await expect(fs.lstat(path.join(retainedNamespace, "selector.json"))).rejects.toMatchObject(
          {
            code: "ENOENT",
          },
        );
        if (operation === "materialize") {
          await expect(
            fs.lstat(path.join(retainedGenerations, generationId)),
          ).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          await expect(
            fs.lstat(path.join(retainedGenerations, generationId)),
          ).resolves.toBeDefined();
        }
      });
    },
  );
});
