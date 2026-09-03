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
        const open = vi
          .spyOn(fs, "open")
          .mockRejectedValueOnce(
            Object.assign(new Error("injected directory sync failure"), { code: "EIO" }),
          );
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
});
