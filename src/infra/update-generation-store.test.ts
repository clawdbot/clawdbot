import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import type { UpdateGenerationSelection } from "./update-generation-contract.js";
import { updateGenerationPathIsEqualOrNested } from "./update-generation-manifest.js";
import {
  captureUpdateGenerationManifest,
  createUpdateGenerationId,
  ensureUpdateGenerationLauncher,
  materializeUpdateGeneration,
  readUpdateGenerationSelector,
  removeObsoleteUpdateGeneration,
  replaceUpdateGenerationSelector,
  resolveSelectedUpdateGeneration,
  resolveUpdateGenerationSelectorPath,
  stabilizeUpdateGenerationSelector,
  UPDATE_GENERATION_LAUNCHER_FILE_NAME,
  UPDATE_GENERATION_LAUNCHER_SOURCE,
} from "./update-generation-store.js";

async function writeRuntime(root: string, version: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "openclaw", version })}\n`,
  );
  await fs.writeFile(path.join(root, "entry.mjs"), `console.log(${JSON.stringify(version)});\n`, {
    mode: 0o755,
  });
}

async function materializeRuntime(params: {
  namespaceRoot: string;
  sourceRoot: string;
  generationId?: string;
  version: string;
}) {
  const manifest = await captureUpdateGenerationManifest(params.sourceRoot);
  return await materializeUpdateGeneration({
    namespaceRoot: params.namespaceRoot,
    sourceRoot: params.sourceRoot,
    generationId: params.generationId ?? createUpdateGenerationId(),
    expectedManifest: manifest,
    packageVersion: params.version,
    entrypointRelativePath: "entry.mjs",
  });
}

function selectionOf(generation: Awaited<ReturnType<typeof materializeRuntime>>) {
  const { packageVersion: _packageVersion, ...selection } = generation.generation;
  return selection;
}

async function runLauncher(launcherPath: string): Promise<string> {
  const result = await runCommandWithTimeout([process.execPath, launcherPath], {
    timeoutMs: 10_000,
  });
  expect(result.code).toBe(0);
  return result.stdout.trim();
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

async function withGenerationTestDir(
  prefix: string,
  run: (base: string) => Promise<void>,
): Promise<void> {
  await withTestDir({ prefix }, async (base) => {
    try {
      await run(base);
    } finally {
      await makeFixtureWritable(base);
    }
  });
}

function failNextOpenForPath(targetPath: string, message: string) {
  const realOpen = fs.open.bind(fs);
  let pending = true;
  return vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
    if (pending && path.resolve(String(filePath)) === path.resolve(targetPath)) {
      pending = false;
      throw Object.assign(new Error(message), { code: "EIO" });
    }
    return await realOpen(filePath, flags, mode);
  });
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

describe("immutable update generation activation", () => {
  it("uses locale-independent manifest ordering", async () => {
    await withGenerationTestDir("openclaw-generation-manifest-order-", async (base) => {
      const stageRoot = path.join(base, "stage");
      await writeRuntime(stageRoot, "1.0.0");
      await fs.writeFile(path.join(stageRoot, "ä"), "umlaut");
      const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
        throw new Error("ambient locale collation must not be used");
      });
      try {
        await expect(captureUpdateGenerationManifest(stageRoot)).resolves.toMatchObject({
          algorithm: "sha256",
          entryCount: 3,
        });
      } finally {
        localeCompare.mockRestore();
      }
    });
  });

  it("keeps an escaped native writer confined to disposable staging", async () => {
    await withGenerationTestDir("openclaw-generation-native-writer-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const stageRoot = path.join(base, "stage");
      await writeRuntime(stageRoot, "2.0.0");
      const manifest = await captureUpdateGenerationManifest(stageRoot);
      const targetPath = path.join(stageRoot, "entry.mjs");
      // This handle models the capability retained by the setsid/fork native
      // descendant in the exact-base red proof.
      const retainedWriter = await fs.open(targetPath, "r+");

      const generation = await materializeUpdateGeneration({
        namespaceRoot,
        sourceRoot: stageRoot,
        generationId: createUpdateGenerationId(),
        expectedManifest: manifest,
        packageVersion: "2.0.0",
        entrypointRelativePath: "entry.mjs",
      });
      await replaceUpdateGenerationSelector({
        namespaceRoot,
        expected: null,
        next: selectionOf(generation),
      });
      const launcherPath = await ensureUpdateGenerationLauncher(namespaceRoot);
      await retainedWriter.truncate(0);
      await retainedWriter.writeFile('console.log("poisoned");\n');
      await retainedWriter.close();

      await expect(fs.readFile(targetPath, "utf8")).resolves.toContain("poisoned");
      await expect(
        fs.readFile(path.join(generation.payloadRoot, "entry.mjs"), "utf8"),
      ).resolves.toContain("2.0.0");
      await expect(runLauncher(launcherPath)).resolves.toBe("2.0.0");
    });
  });

  it("rejects a staging file swapped to an external symlink during copy", async () => {
    await withGenerationTestDir("openclaw-generation-source-swap-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const stageRoot = path.join(base, "stage");
      const targetPath = path.join(stageRoot, "entry.mjs");
      const retainedPath = path.join(stageRoot, "entry.original.mjs");
      const outsidePath = path.join(base, "outside-secret.mjs");
      await writeRuntime(stageRoot, "1.0.0");
      await fs.writeFile(outsidePath, 'console.log("outside-secret");\n');
      const manifest = await captureUpdateGenerationManifest(stageRoot);
      const generationId = createUpdateGenerationId();
      const realOpen = fs.open.bind(fs);
      let targetOpenCount = 0;
      const open = vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
        if (path.resolve(String(filePath)) === targetPath && ++targetOpenCount === 2) {
          await fs.rename(targetPath, retainedPath);
          await fs.symlink(outsidePath, targetPath);
        }
        return await realOpen(filePath, flags, mode);
      });
      try {
        await expect(
          materializeUpdateGeneration({
            namespaceRoot,
            sourceRoot: stageRoot,
            generationId,
            expectedManifest: manifest,
            packageVersion: "1.0.0",
            entrypointRelativePath: "entry.mjs",
          }),
        ).rejects.toThrow();
      } finally {
        open.mockRestore();
      }
      await expect(
        fs.stat(path.join(namespaceRoot, "generations", generationId)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(outsidePath, "utf8")).resolves.toContain("outside-secret");
    });
  });

  it("selects and rolls back generations without moving their bytes", async () => {
    await withGenerationTestDir("openclaw-generation-selector-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const previousStage = path.join(base, "previous");
      const candidateStage = path.join(base, "candidate");
      await Promise.all([
        writeRuntime(previousStage, "1.0.0"),
        writeRuntime(candidateStage, "2.0.0"),
      ]);
      const previous = await materializeRuntime({
        namespaceRoot,
        sourceRoot: previousStage,
        version: "1.0.0",
      });
      const candidate = await materializeRuntime({
        namespaceRoot,
        sourceRoot: candidateStage,
        version: "2.0.0",
      });
      const previousSelection = selectionOf(previous);
      const candidateSelection = selectionOf(candidate);
      const launcherPath = await ensureUpdateGenerationLauncher(namespaceRoot);

      await replaceUpdateGenerationSelector({
        namespaceRoot,
        expected: null,
        next: previousSelection,
      });
      await expect(runLauncher(launcherPath)).resolves.toBe("1.0.0");
      await replaceUpdateGenerationSelector({
        namespaceRoot,
        expected: previousSelection,
        next: candidateSelection,
      });
      await expect(runLauncher(launcherPath)).resolves.toBe("2.0.0");
      await replaceUpdateGenerationSelector({
        namespaceRoot,
        expected: candidateSelection,
        next: previousSelection,
      });
      await expect(runLauncher(launcherPath)).resolves.toBe("1.0.0");

      await expect(fs.stat(previous.generationRoot)).resolves.toBeDefined();
      await expect(fs.stat(candidate.generationRoot)).resolves.toBeDefined();
      await expect(readUpdateGenerationSelector(namespaceRoot)).resolves.toEqual(previousSelection);
    });
  });

  it("uses a distinct selector identity for a same-version refresh", async () => {
    await withGenerationTestDir("openclaw-generation-refresh-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const firstStage = path.join(base, "first");
      const secondStage = path.join(base, "second");
      await Promise.all([writeRuntime(firstStage, "2.0.0"), writeRuntime(secondStage, "2.0.0")]);
      await fs.writeFile(path.join(secondStage, "refresh.txt"), "fresh bytes\n");
      const first = await materializeRuntime({
        namespaceRoot,
        sourceRoot: firstStage,
        version: "2.0.0",
      });
      const second = await materializeRuntime({
        namespaceRoot,
        sourceRoot: secondStage,
        version: "2.0.0",
      });
      await replaceUpdateGenerationSelector({
        namespaceRoot,
        expected: null,
        next: selectionOf(first),
      });
      await replaceUpdateGenerationSelector({
        namespaceRoot,
        expected: selectionOf(first),
        next: selectionOf(second),
      });

      expect(first.generation.generationId).not.toBe(second.generation.generationId);
      await expect(readUpdateGenerationSelector(namespaceRoot)).resolves.toEqual(
        selectionOf(second),
      );
    });
  });

  it("copies hardlinked package bytes into an independent generation", async () => {
    await withGenerationTestDir("openclaw-generation-hardlink-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const stageRoot = path.join(base, "stage");
      const cacheRoot = path.join(base, "cache");
      await Promise.all([
        fs.mkdir(stageRoot, { recursive: true }),
        fs.mkdir(cacheRoot, { recursive: true }),
      ]);
      const cacheFile = path.join(cacheRoot, "entry.mjs");
      await fs.writeFile(cacheFile, 'console.log("cache-v1");\n');
      await fs.link(cacheFile, path.join(stageRoot, "entry.mjs"));
      await fs.writeFile(
        path.join(stageRoot, "package.json"),
        '{"name":"openclaw","version":"1.0.0"}\n',
      );
      const generation = await materializeRuntime({
        namespaceRoot,
        sourceRoot: stageRoot,
        version: "1.0.0",
      });
      await fs.writeFile(cacheFile, 'console.log("cache-v2");\n');

      await expect(
        fs.readFile(path.join(generation.payloadRoot, "entry.mjs"), "utf8"),
      ).resolves.toContain("cache-v1");
    });
  });

  it("preserves internal relative symlinks used by package-manager trees", async () => {
    await withGenerationTestDir("openclaw-generation-relative-symlink-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const stageRoot = path.join(base, "stage");
      await writeRuntime(stageRoot, "1.0.0");
      await fs.mkdir(path.join(stageRoot, "node_modules"));
      await fs.symlink("../entry.mjs", path.join(stageRoot, "node_modules", "openclaw-entry"));

      const generation = await materializeRuntime({
        namespaceRoot,
        sourceRoot: stageRoot,
        version: "1.0.0",
      });

      await expect(
        fs.readlink(path.join(generation.payloadRoot, "node_modules", "openclaw-entry")),
      ).resolves.toBe("../entry.mjs");
    });
  });
});

describe("update generation fail-closed boundaries", () => {
  it("treats descendant names beginning with two dots as contained", async () => {
    await withGenerationTestDir("openclaw-generation-dotdot-name-", async (base) => {
      const sourceRoot = path.join(base, "stage");
      const nestedNamespace = path.join(sourceRoot, "..managed");
      await writeRuntime(sourceRoot, "1.0.0");

      expect(updateGenerationPathIsEqualOrNested(sourceRoot, nestedNamespace)).toBe(true);
      expect(updateGenerationPathIsEqualOrNested(sourceRoot, path.join(base, "..managed"))).toBe(
        false,
      );
      await expect(
        materializeRuntime({
          namespaceRoot: nestedNamespace,
          sourceRoot,
          version: "1.0.0",
        }),
      ).rejects.toThrow("namespace cannot be inside its source");
    });
  });

  it("rejects symlinks that escape disposable staging", async () => {
    await withGenerationTestDir("openclaw-generation-symlink-", async (base) => {
      const stageRoot = path.join(base, "stage");
      await writeRuntime(stageRoot, "1.0.0");
      await fs.symlink(path.join(base, "outside"), path.join(stageRoot, "escape"));

      await expect(captureUpdateGenerationManifest(stageRoot)).rejects.toThrow("absolute symlink");
    });
  });

  it.each(["namespace", "generations"] as const)(
    "rejects a symlinked %s destination before materialization",
    async (symlinkKind) => {
      await withGenerationTestDir("openclaw-generation-destination-symlink-", async (base) => {
        const namespaceRoot = path.join(base, "managed");
        const outsideRoot = path.join(base, "outside");
        const stageRoot = path.join(base, "stage");
        await Promise.all([fs.mkdir(outsideRoot), writeRuntime(stageRoot, "1.0.0")]);
        if (symlinkKind === "namespace") {
          await fs.symlink(
            outsideRoot,
            namespaceRoot,
            process.platform === "win32" ? "junction" : undefined,
          );
        } else {
          await fs.mkdir(namespaceRoot);
          await fs.symlink(
            outsideRoot,
            path.join(namespaceRoot, "generations"),
            process.platform === "win32" ? "junction" : undefined,
          );
        }

        await expect(
          materializeRuntime({
            namespaceRoot,
            sourceRoot: stageRoot,
            version: "1.0.0",
          }),
        ).rejects.toThrow(/Invalid update generation(?:s directory| namespace)/u);
        await expect(fs.readdir(outsideRoot)).resolves.toEqual([]);
      });
    },
  );

  it.each(["namespace", "generations"] as const)(
    "rejects a swapped-back %s root even when its original inode returns",
    async (rootKind) => {
      await withGenerationTestDir("openclaw-generation-root-swap-back-", async (base) => {
        const namespaceRoot = path.join(base, "managed");
        const generationsRoot = path.join(namespaceRoot, "generations");
        const stageRoot = path.join(base, "stage");
        const outsideRoot = path.join(base, "outside");
        await Promise.all([
          fs.mkdir(generationsRoot, { recursive: true }),
          writeRuntime(stageRoot, "1.0.0"),
          fs.mkdir(outsideRoot),
        ]);
        const targetRoot = rootKind === "namespace" ? namespaceRoot : generationsRoot;
        const heldRoot = `${targetRoot}.held`;
        const parentRoot = path.dirname(targetRoot);
        const generationId = createUpdateGenerationId();
        const expectedManifest = await captureUpdateGenerationManifest(stageRoot);
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
            await fs.rm(targetRoot, { force: true });
            await fs.rename(heldRoot, targetRoot);
            await fs.utimes(parentRoot, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
          }
          return await realRealpath(requestedPath);
        });
        try {
          await expect(
            materializeUpdateGeneration({
              namespaceRoot,
              sourceRoot: stageRoot,
              generationId,
              expectedManifest,
              packageVersion: "1.0.0",
              entrypointRelativePath: "entry.mjs",
            }),
          ).rejects.toThrow("changed during path resolution");
        } finally {
          realpath.mockRestore();
        }
        expect(swapped).toBe(true);
        await expect(fs.lstat(path.join(generationsRoot, generationId))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(listGenerationResidue(namespaceRoot)).resolves.toEqual([]);
      });
    },
  );

  it.each(["namespace", "generations"] as const)(
    "rejects an equal-content replacement of the %s root with a different inode",
    async (rootKind) => {
      await withGenerationTestDir("openclaw-generation-root-inode-swap-", async (base) => {
        const namespaceRoot = path.join(base, "managed");
        const generationsRoot = path.join(namespaceRoot, "generations");
        const stageRoot = path.join(base, "stage");
        await Promise.all([
          fs.mkdir(generationsRoot, { recursive: true }),
          writeRuntime(stageRoot, "1.0.0"),
        ]);
        const targetRoot = rootKind === "namespace" ? namespaceRoot : generationsRoot;
        const heldRoot = `${targetRoot}.held`;
        const replacementRoot = `${targetRoot}.replacement`;
        await fs.cp(targetRoot, replacementRoot, { recursive: true, preserveTimestamps: true });
        const generationId = createUpdateGenerationId();
        const expectedManifest = await captureUpdateGenerationManifest(stageRoot);
        const realRealpath = fs.realpath.bind(fs);
        let swapped = false;
        const realpath = vi.spyOn(fs, "realpath").mockImplementation(async (requestedPath) => {
          if (!swapped && path.resolve(String(requestedPath)) === path.resolve(targetRoot)) {
            swapped = true;
            await fs.rename(targetRoot, heldRoot);
            await fs.rename(replacementRoot, targetRoot);
          }
          return await realRealpath(requestedPath);
        });
        try {
          await expect(
            materializeUpdateGeneration({
              namespaceRoot,
              sourceRoot: stageRoot,
              generationId,
              expectedManifest,
              packageVersion: "1.0.0",
              entrypointRelativePath: "entry.mjs",
            }),
          ).rejects.toThrow("changed during path resolution");
        } finally {
          realpath.mockRestore();
        }
        expect(swapped).toBe(true);
        await expect(fs.lstat(path.join(generationsRoot, generationId))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(listGenerationResidue(namespaceRoot)).resolves.toEqual([]);
      });
    },
  );

  it("retains the old selector when replacement fails", async () => {
    await withGenerationTestDir("openclaw-generation-swap-failure-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const previousStage = path.join(base, "previous");
      const candidateStage = path.join(base, "candidate");
      await Promise.all([
        writeRuntime(previousStage, "1.0.0"),
        writeRuntime(candidateStage, "2.0.0"),
      ]);
      const previous = await materializeRuntime({
        namespaceRoot,
        sourceRoot: previousStage,
        version: "1.0.0",
      });
      const candidate = await materializeRuntime({
        namespaceRoot,
        sourceRoot: candidateStage,
        version: "2.0.0",
      });
      const previousSelection = selectionOf(previous);
      await replaceUpdateGenerationSelector({
        namespaceRoot,
        expected: null,
        next: previousSelection,
      });
      const rename = vi
        .spyOn(fs, "rename")
        .mockRejectedValueOnce(
          Object.assign(new Error("injected selector replacement failure"), { code: "EACCES" }),
        );

      await expect(
        replaceUpdateGenerationSelector({
          namespaceRoot,
          expected: previousSelection,
          next: selectionOf(candidate),
        }),
      ).rejects.toThrow("injected selector replacement failure");
      rename.mockRestore();
      await expect(readUpdateGenerationSelector(namespaceRoot)).resolves.toEqual(previousSelection);
      await expect(
        fs.readFile(resolveUpdateGenerationSelectorPath(namespaceRoot), "utf8"),
      ).resolves.toBe(`${JSON.stringify(previousSelection)}\n`);
    });
  });

  it("repairs selector directory durability before recording a committed swap", async () => {
    await withGenerationTestDir("openclaw-generation-selector-sync-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const previousStage = path.join(base, "previous");
      const candidateStage = path.join(base, "candidate");
      await Promise.all([
        writeRuntime(previousStage, "1.0.0"),
        writeRuntime(candidateStage, "2.0.0"),
      ]);
      const previous = await materializeRuntime({
        namespaceRoot,
        sourceRoot: previousStage,
        version: "1.0.0",
      });
      const candidate = await materializeRuntime({
        namespaceRoot,
        sourceRoot: candidateStage,
        version: "2.0.0",
      });
      const previousSelection = selectionOf(previous);
      const candidateSelection = selectionOf(candidate);
      await replaceUpdateGenerationSelector({
        namespaceRoot,
        expected: null,
        next: previousSelection,
      });

      const realRename = fs.rename.bind(fs);
      let restoreOpen: () => void = () => undefined;
      const rename = vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
        await realRename(from, to);
        const open = failNextOpenForPath(namespaceRoot, "injected selector sync failure");
        restoreOpen = () => open.mockRestore();
      });
      try {
        await expect(
          replaceUpdateGenerationSelector({
            namespaceRoot,
            expected: previousSelection,
            next: candidateSelection,
          }),
        ).rejects.toThrow("injected selector sync failure");
      } finally {
        restoreOpen();
        rename.mockRestore();
      }
      await expect(readUpdateGenerationSelector(namespaceRoot)).resolves.toEqual(
        candidateSelection,
      );

      const retryOpen = failNextOpenForPath(namespaceRoot, "injected selector retry sync failure");
      await expect(
        stabilizeUpdateGenerationSelector({ namespaceRoot, expected: candidateSelection }),
      ).rejects.toThrow("injected selector retry sync failure");
      retryOpen.mockRestore();
      await expect(
        stabilizeUpdateGenerationSelector({ namespaceRoot, expected: candidateSelection }),
      ).resolves.toBeUndefined();
      await expect(fs.stat(previous.generationRoot)).resolves.toBeDefined();
      await expect(fs.stat(candidate.generationRoot)).resolves.toBeDefined();
    });
  });

  it("refuses stale expected selectors and tampered generations", async () => {
    await withGenerationTestDir("openclaw-generation-tamper-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const stageRoot = path.join(base, "stage");
      await writeRuntime(stageRoot, "1.0.0");
      const generation = await materializeRuntime({
        namespaceRoot,
        sourceRoot: stageRoot,
        version: "1.0.0",
      });
      const selection = selectionOf(generation);
      await replaceUpdateGenerationSelector({ namespaceRoot, expected: null, next: selection });
      const impossible: UpdateGenerationSelection = {
        ...selection,
        generationId: "f".repeat(32),
      };
      await expect(
        replaceUpdateGenerationSelector({
          namespaceRoot,
          expected: impossible,
          next: selection,
        }),
      ).rejects.toThrow("selector changed before replacement");
      await expect(
        replaceUpdateGenerationSelector({
          namespaceRoot,
          expected: selection,
          next: { ...selection, entrypointRelativePath: "missing.mjs" },
        }),
      ).rejects.toThrow("entrypoint is unavailable");
      await expect(readUpdateGenerationSelector(namespaceRoot)).resolves.toEqual(selection);
      await fs.chmod(path.join(generation.payloadRoot, "entry.mjs"), 0o700);
      await fs.writeFile(
        path.join(generation.payloadRoot, "entry.mjs"),
        'console.log("tampered");\n',
      );

      await expect(
        resolveSelectedUpdateGeneration({ namespaceRoot, verifyManifest: true }),
      ).rejects.toThrow("manifest mismatch");
    });
  });

  it("rejects a selected generation reached through a symlinked generations root", async () => {
    await withGenerationTestDir("openclaw-generation-launcher-symlink-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const stageRoot = path.join(base, "stage");
      await writeRuntime(stageRoot, "1.0.0");
      const generation = await materializeRuntime({
        namespaceRoot,
        sourceRoot: stageRoot,
        version: "1.0.0",
      });
      await replaceUpdateGenerationSelector({
        namespaceRoot,
        expected: null,
        next: selectionOf(generation),
      });
      const launcher = await ensureUpdateGenerationLauncher(namespaceRoot);
      const generationsRoot = path.join(namespaceRoot, "generations");
      const redirectedRoot = path.join(base, "redirected-generations");
      await fs.rename(generationsRoot, redirectedRoot);
      await fs.symlink(
        redirectedRoot,
        generationsRoot,
        process.platform === "win32" ? "junction" : undefined,
      );

      const result = await runCommandWithTimeout([process.execPath, launcher], {
        timeoutMs: 10_000,
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("not an owned directory");
    });
  });

  it("rejects a generation root symlink before following its payload", async () => {
    await withGenerationTestDir("openclaw-generation-root-symlink-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const stageRoot = path.join(base, "stage");
      await writeRuntime(stageRoot, "1.0.0");
      const generation = await materializeRuntime({
        namespaceRoot,
        sourceRoot: stageRoot,
        version: "1.0.0",
      });
      const selected = selectionOf(generation);
      await replaceUpdateGenerationSelector({ namespaceRoot, expected: null, next: selected });
      const redirectedRoot = path.join(base, "redirected-generation");
      await fs.rename(generation.generationRoot, redirectedRoot);
      await fs.symlink(
        redirectedRoot,
        generation.generationRoot,
        process.platform === "win32" ? "junction" : undefined,
      );

      await expect(
        resolveSelectedUpdateGeneration({ namespaceRoot, verifyManifest: true }),
      ).rejects.toThrow("generation root is unavailable");
      await expect(
        replaceUpdateGenerationSelector({ namespaceRoot, expected: selected, next: selected }),
      ).rejects.toThrow("generation root is unavailable");
      await expect(readUpdateGenerationSelector(namespaceRoot)).resolves.toEqual(selected);
    });
  });

  it("does not accept a symlink installed during launcher creation", async () => {
    await withGenerationTestDir("openclaw-generation-launcher-race-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const attackerLauncher = path.join(base, "attacker-launcher.mjs");
      await fs.writeFile(attackerLauncher, UPDATE_GENERATION_LAUNCHER_SOURCE);
      const rename = vi.spyOn(fs, "rename").mockImplementationOnce(async () => {
        await fs.symlink(
          attackerLauncher,
          path.join(namespaceRoot, UPDATE_GENERATION_LAUNCHER_FILE_NAME),
        );
        throw Object.assign(new Error("injected launcher race"), { code: "EEXIST" });
      });

      await expect(ensureUpdateGenerationLauncher(namespaceRoot)).rejects.toThrow(
        "injected launcher race",
      );
      rename.mockRestore();
    });
  });

  it("reports a directory-sync failure after committing a launcher", async () => {
    await withGenerationTestDir("openclaw-generation-launcher-sync-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const launcherPath = path.join(namespaceRoot, UPDATE_GENERATION_LAUNCHER_FILE_NAME);
      const realRename = fs.rename.bind(fs);
      let restoreOpen: () => void = () => undefined;
      const rename = vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
        await realRename(from, to);
        const open = failNextOpenForPath(namespaceRoot, "injected directory sync failure");
        restoreOpen = () => open.mockRestore();
      });
      try {
        await expect(ensureUpdateGenerationLauncher(namespaceRoot)).rejects.toThrow(
          "injected directory sync failure",
        );
        await expect(fs.readFile(launcherPath, "utf8")).resolves.toBe(
          UPDATE_GENERATION_LAUNCHER_SOURCE,
        );
      } finally {
        restoreOpen();
        rename.mockRestore();
      }
      const retryOpen = failNextOpenForPath(namespaceRoot, "injected retry directory sync failure");
      await expect(ensureUpdateGenerationLauncher(namespaceRoot)).rejects.toThrow(
        "injected retry directory sync failure",
      );
      retryOpen.mockRestore();
      await expect(ensureUpdateGenerationLauncher(namespaceRoot)).resolves.toBe(launcherPath);
    });
  });

  it("never cleans the active or rollback generation", async () => {
    await withGenerationTestDir("openclaw-generation-cleanup-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const previousStage = path.join(base, "previous");
      const candidateStage = path.join(base, "candidate");
      const obsoleteStage = path.join(base, "obsolete");
      await Promise.all([
        writeRuntime(previousStage, "1.0.0"),
        writeRuntime(candidateStage, "2.0.0"),
        writeRuntime(obsoleteStage, "3.0.0"),
      ]);
      const [previous, candidate, obsolete] = await Promise.all([
        materializeRuntime({ namespaceRoot, sourceRoot: previousStage, version: "1.0.0" }),
        materializeRuntime({ namespaceRoot, sourceRoot: candidateStage, version: "2.0.0" }),
        materializeRuntime({ namespaceRoot, sourceRoot: obsoleteStage, version: "3.0.0" }),
      ]);
      await replaceUpdateGenerationSelector({
        namespaceRoot,
        expected: null,
        next: selectionOf(candidate),
      });
      const protectedGenerationIds = [
        previous.generation.generationId,
        candidate.generation.generationId,
      ];

      await expect(
        removeObsoleteUpdateGeneration({
          namespaceRoot,
          generationId: candidate.generation.generationId,
          protectedGenerationIds: [],
        }),
      ).rejects.toThrow("active update generation");
      await expect(
        removeObsoleteUpdateGeneration({
          namespaceRoot,
          generationId: previous.generation.generationId,
          protectedGenerationIds,
        }),
      ).rejects.toThrow("protected update generation");
      await expect(
        removeObsoleteUpdateGeneration({
          namespaceRoot,
          generationId: obsolete.generation.generationId,
          protectedGenerationIds,
        }),
      ).resolves.toBe(true);

      await expect(fs.stat(previous.generationRoot)).resolves.toBeDefined();
      await expect(fs.stat(candidate.generationRoot)).resolves.toBeDefined();
      await expect(fs.stat(obsolete.generationRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("replaces an interrupted deterministic incoming tree on retry", async () => {
    await withGenerationTestDir("openclaw-generation-incoming-recovery-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const stageRoot = path.join(base, "stage");
      const generationId = createUpdateGenerationId();
      await writeRuntime(stageRoot, "1.0.0");
      const interruptedRoot = path.join(namespaceRoot, "generations", `.incoming-${generationId}`);
      await fs.mkdir(path.join(interruptedRoot, "payload"), { recursive: true });
      await fs.writeFile(path.join(interruptedRoot, "payload", "partial"), "partial");

      const generation = await materializeRuntime({
        namespaceRoot,
        sourceRoot: stageRoot,
        generationId,
        version: "1.0.0",
      });

      await expect(fs.stat(generation.generationRoot)).resolves.toBeDefined();
      await expect(fs.stat(interruptedRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("retries generation directory sync after a committed materialization", async () => {
    await withGenerationTestDir("openclaw-generation-materialize-sync-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const stageRoot = path.join(base, "stage");
      const generationId = createUpdateGenerationId();
      const generationRoot = path.join(namespaceRoot, "generations", generationId);
      const generationsRoot = path.dirname(generationRoot);
      await writeRuntime(stageRoot, "1.0.0");
      const manifest = await captureUpdateGenerationManifest(stageRoot);
      const realRename = fs.rename.bind(fs);
      let restoreOpen: () => void = () => undefined;
      const rename = vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
        await realRename(from, to);
        const open = failNextOpenForPath(generationsRoot, "injected materialization sync failure");
        restoreOpen = () => open.mockRestore();
      });
      const materialize = () =>
        materializeUpdateGeneration({
          namespaceRoot,
          sourceRoot: stageRoot,
          generationId,
          expectedManifest: manifest,
          packageVersion: "1.0.0",
          entrypointRelativePath: "entry.mjs",
        });
      try {
        await expect(materialize()).rejects.toThrow("injected materialization sync failure");
      } finally {
        restoreOpen();
        rename.mockRestore();
      }
      await expect(fs.stat(generationRoot)).resolves.toBeDefined();

      const retryOpen = failNextOpenForPath(
        generationsRoot,
        "injected materialization retry sync failure",
      );
      await expect(materialize()).rejects.toThrow("injected materialization retry sync failure");
      retryOpen.mockRestore();
      await expect(materialize()).resolves.toMatchObject({ generationRoot });
    });
  });

  it("finishes an interrupted deterministic retired-tree cleanup", async () => {
    await withGenerationTestDir("openclaw-generation-retired-recovery-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const stageRoot = path.join(base, "stage");
      await writeRuntime(stageRoot, "1.0.0");
      const generation = await materializeRuntime({
        namespaceRoot,
        sourceRoot: stageRoot,
        version: "1.0.0",
      });
      const retiredRoot = path.join(
        namespaceRoot,
        "generations",
        `.retired-${generation.generation.generationId}`,
      );
      await fs.rename(generation.generationRoot, retiredRoot);

      await expect(
        removeObsoleteUpdateGeneration({
          namespaceRoot,
          generationId: generation.generation.generationId,
          protectedGenerationIds: [],
        }),
      ).resolves.toBe(true);
      await expect(fs.stat(retiredRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("retries cleanup directory sync after removing a retired generation", async () => {
    await withGenerationTestDir("openclaw-generation-cleanup-sync-", async (base) => {
      const namespaceRoot = path.join(base, "managed");
      const stageRoot = path.join(base, "stage");
      await writeRuntime(stageRoot, "1.0.0");
      const generation = await materializeRuntime({
        namespaceRoot,
        sourceRoot: stageRoot,
        version: "1.0.0",
      });
      const retiredRoot = path.join(
        namespaceRoot,
        "generations",
        `.retired-${generation.generation.generationId}`,
      );
      const generationsRoot = path.dirname(retiredRoot);
      await fs.rename(generation.generationRoot, retiredRoot);
      const remove = () =>
        removeObsoleteUpdateGeneration({
          namespaceRoot,
          generationId: generation.generation.generationId,
          protectedGenerationIds: [],
        });

      const firstSync = failNextOpenForPath(generationsRoot, "injected cleanup sync failure");
      await expect(remove()).rejects.toThrow("injected cleanup sync failure");
      firstSync.mockRestore();
      await expect(fs.stat(retiredRoot)).rejects.toMatchObject({ code: "ENOENT" });

      const retrySync = failNextOpenForPath(generationsRoot, "injected cleanup retry sync failure");
      await expect(remove()).rejects.toThrow("injected cleanup retry sync failure");
      retrySync.mockRestore();
      await expect(remove()).resolves.toBe(false);
    });
  });
});
