// Memory Core tests cover managed Dream Diary artifacts.
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dedupeDreamDiaryEntries,
  readRecentDreamDiaryEntries,
  removeBackfillDiaryEntries,
  updateDreamsFile,
  writeBackfillDiaryEntries,
} from "./dreaming-dreams-file.js";
import {
  SHORT_TERM_LOCK_MAX_ENTRIES,
  SHORT_TERM_LOCK_NAMESPACE,
  memoryCoreWorkspaceStateKey,
  openMemoryCoreStateStore,
} from "./dreaming-state.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
const EXPECTS_POSIX_PRIVATE_FILE_MODE = process.platform !== "win32";

function setNarrativeTestEnv(stateDir: string): void {
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("dream diary file behavior", () => {
  it("does not restore deleted diary content from an update already in progress", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-forget-update-");
    setNarrativeTestEnv(path.join(workspaceDir, ".state"));
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    const claim = "A private cobalt archive phrase.";
    await fs.writeFile(dreamsPath, `# Diary\n\n## Session ID: forgotten\n${claim}\n`);
    const prepared = createDeferred<void>();
    const publish = createDeferred<void>();
    const update = updateDreamsFile({
      workspaceDir,
      updater: async (existing) => {
        expect(existing).toContain(claim);
        prepared.resolve();
        await publish.promise;
        return { content: `${existing}\n## Other\nA new unrelated entry.\n`, result: undefined };
      },
    });
    let forgotten: ReturnType<typeof forgetMemoryEntries> | undefined;
    try {
      await prepared.promise;
      const writerOwnsLock = await openMemoryCoreStateStore({
        namespace: SHORT_TERM_LOCK_NAMESPACE,
        maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
      }).lookup(memoryCoreWorkspaceStateKey(workspaceDir));
      forgotten = forgetMemoryEntries({
        cfg: { agents: { entries: { main: { workspace: workspaceDir } } } },
        agentId: "main",
        sessionIds: ["forgotten"],
      });
      if (!writerOwnsLock) {
        await forgotten;
      }
      publish.resolve();
      await Promise.all([update, forgotten]);
      const content = await fs.readFile(dreamsPath, "utf8");
      expect(content).not.toContain(claim);
      expect(content).toContain("A new unrelated entry.");
    } finally {
      publish.resolve();
      await Promise.allSettled([update, ...(forgotten ? [forgotten] : [])]);
    }
  });

  it("writes, reads, deduplicates, and removes backfill entries", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-narrative-backfill-");
    const written = await writeBackfillDiaryEntries({
      workspaceDir,
      entries: [
        {
          isoDay: "2026-04-05",
          bodyLines: ["The archive remembered a durable fact."],
          sourcePath: "memory/2026-04-05.md",
        },
      ],
      timezone: "UTC",
    });
    expect(written.written).toBe(1);

    const existing = await fs.readFile(written.dreamsPath, "utf8");
    const startMarker = "<!-- openclaw:dreaming:diary:start -->";
    const endMarker = "<!-- openclaw:dreaming:diary:end -->";
    const block = existing.slice(
      existing.indexOf(startMarker) + startMarker.length,
      existing.indexOf(endMarker),
    );
    await fs.writeFile(written.dreamsPath, existing.replace(endMarker, `${block}\n${endMarker}`));

    await expect(dedupeDreamDiaryEntries({ workspaceDir })).resolves.toMatchObject({ removed: 1 });
    await expect(readRecentDreamDiaryEntries({ workspaceDir })).resolves.toHaveLength(1);
    await expect(removeBackfillDiaryEntries({ workspaceDir })).resolves.toMatchObject({
      removed: 1,
    });
  });

  it("refuses to overwrite a symlinked DREAMS.md", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-narrative-symlink-");
    const targetPath = path.join(workspaceDir, "outside.txt");
    await fs.writeFile(targetPath, "outside\n", "utf8");
    await fs.symlink(targetPath, path.join(workspaceDir, "DREAMS.md"));

    await expect(
      writeBackfillDiaryEntries({
        workspaceDir,
        entries: [
          {
            isoDay: "2026-04-05",
            bodyLines: ["The archive remembered a durable fact."],
          },
        ],
        timezone: "UTC",
      }),
    ).rejects.toThrow("Refusing to write symlinked DREAMS.md");
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("outside\n");
  });

  it("keeps truncated recent diary entries UTF-16 safe", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-narrative-utf16-");
    const prefix = "a".repeat(359);
    await writeBackfillDiaryEntries({
      workspaceDir,
      entries: [
        {
          isoDay: "2026-04-05",
          bodyLines: [`${prefix}😀tail`],
        },
      ],
      timezone: "UTC",
    });

    await expect(readRecentDreamDiaryEntries({ workspaceDir, limit: 1 })).resolves.toEqual([
      `${prefix}...`,
    ]);
  });

  it("skips symlinked and non-file DREAMS.md when reading recent context", async () => {
    const symlinkWorkspace = await createTempWorkspace("dreaming-narrative-read-symlink-");
    const targetPath = path.join(symlinkWorkspace, "target-dreams.md");
    await fs.writeFile(
      targetPath,
      [
        "# Dream Diary",
        "",
        "<!-- openclaw:dreaming:diary:start -->",
        "---",
        "",
        "*April 5, 2026*",
        "",
        "Symlink target diary text must not enter the prompt.",
        "",
        "<!-- openclaw:dreaming:diary:end -->",
        "",
      ].join("\n"),
      "utf8",
    );
    await fs.symlink(targetPath, path.join(symlinkWorkspace, "DREAMS.md"));

    await expect(
      readRecentDreamDiaryEntries({ workspaceDir: symlinkWorkspace, limit: 3 }),
    ).resolves.toEqual([]);

    const directoryWorkspace = await createTempWorkspace("dreaming-narrative-read-directory-");
    await fs.mkdir(path.join(directoryWorkspace, "DREAMS.md"));
    await expect(
      readRecentDreamDiaryEntries({ workspaceDir: directoryWorkspace, limit: 3 }),
    ).resolves.toEqual([]);
  });

  it("keeps existing content intact when the atomic replace fails", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-narrative-atomic-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(dreamsPath, "# Existing\n", "utf8");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(
      Object.assign(new Error("replace failed"), { code: "ENOSPC" }),
    );

    await expect(
      writeBackfillDiaryEntries({
        workspaceDir,
        entries: [
          {
            isoDay: "2026-04-05",
            bodyLines: ["The archive remembered a durable fact."],
          },
        ],
        timezone: "UTC",
      }),
    ).rejects.toThrow("replace failed");
    await expect(fs.readFile(dreamsPath, "utf8")).resolves.toBe("# Existing\n");
  });

  it("preserves restrictive DREAMS.md permissions across atomic replace", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-narrative-mode-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(dreamsPath, "# Existing\n", { encoding: "utf8", mode: 0o600 });
    await fs.chmod(dreamsPath, 0o600);

    await writeBackfillDiaryEntries({
      workspaceDir,
      entries: [
        {
          isoDay: "2026-04-05",
          bodyLines: ["The archive remembered a durable fact."],
        },
      ],
      timezone: "UTC",
    });

    if (EXPECTS_POSIX_PRIVATE_FILE_MODE) {
      expect((await fs.stat(dreamsPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("deduplicates exact matches while keeping distinct timestamps", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-narrative-dedupe-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      [
        "# Dream Diary",
        "",
        "<!-- openclaw:dreaming:diary:start -->",
        "---",
        "",
        "*April 11, 2026, 8:00 AM*",
        "",
        "The server room smelled like rain.",
        "",
        "---",
        "",
        "*April 11, 2026, 8:00 AM*",
        "",
        "<!-- transient comment -->",
        "",
        "The server room smelled like rain.",
        "",
        "---",
        "",
        "*April 11, 2026, 8:30 AM*",
        "",
        "The server room smelled like rain.",
        "",
        "<!-- openclaw:dreaming:diary:end -->",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(dedupeDreamDiaryEntries({ workspaceDir })).resolves.toMatchObject({
      removed: 1,
      kept: 2,
    });
    const content = await fs.readFile(dreamsPath, "utf8");
    expect(content.match(/The server room smelled like rain\./g)?.length).toBe(2);
    expect(content).toContain("*April 11, 2026, 8:00 AM*");
    expect(content).toContain("*April 11, 2026, 8:30 AM*");
  });

  it("serializes concurrent writes and deduplication", async () => {
    const workspaceDir = await createTempWorkspace("dreaming-narrative-concurrent-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      [
        "# Dream Diary",
        "",
        "<!-- openclaw:dreaming:diary:start -->",
        "---",
        "",
        "*April 11, 2026, 8:00 AM*",
        "",
        "The server room smelled like rain.",
        "",
        "---",
        "",
        "*April 11, 2026, 8:00 AM*",
        "",
        "The server room smelled like rain.",
        "",
        "<!-- openclaw:dreaming:diary:end -->",
        "",
      ].join("\n"),
      "utf8",
    );

    await Promise.all([
      dedupeDreamDiaryEntries({ workspaceDir }),
      writeBackfillDiaryEntries({
        workspaceDir,
        entries: [
          {
            isoDay: "2026-04-11",
            bodyLines: ["A fresh signal arrived after the cleanup started."],
          },
        ],
        timezone: "UTC",
      }),
    ]);

    const content = await fs.readFile(dreamsPath, "utf8");
    expect(content.match(/The server room smelled like rain\./g)?.length).toBe(1);
    expect(content).toContain("A fresh signal arrived after the cleanup started.");
  });
});
