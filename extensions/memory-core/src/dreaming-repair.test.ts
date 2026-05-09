import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditDreamingArtifacts, repairDreamingArtifacts } from "./dreaming-repair.js";

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "dreaming-repair-test-"));
  tempDirs.push(workspaceDir);
  await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
  return workspaceDir;
}

function requireArchiveDir(archiveDir: string | undefined): string {
  if (!archiveDir) {
    throw new Error("Expected dreaming repair to create an archive directory");
  }
  return archiveDir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

describe("dreaming artifact repair", () => {
  it("detects self-ingested dreaming corpus lines", async () => {
    const workspaceDir = await createWorkspace();
    await fs
      .writeFile(
        path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-11.txt"),
        [
          "[main/dreaming-main.jsonl#L4] regular session text",
          "[main/dreaming-narrative-light.jsonl#L1] Write a dream diary entry from these memory fragments:",
        ].join("\n"),
        "utf-8",
      )
      .catch(async () => {
        await fs.mkdir(path.join(workspaceDir, "memory", ".dreams", "session-corpus"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-11.txt"),
          [
            "[main/dreaming-main.jsonl#L4] regular session text",
            "[main/dreaming-narrative-light.jsonl#L1] Write a dream diary entry from these memory fragments:",
          ].join("\n"),
          "utf-8",
        );
      });

    const audit = await auditDreamingArtifacts({ workspaceDir });

    expect(audit.sessionCorpusFileCount).toBe(1);
    expect(audit.suspiciousSessionCorpusFileCount).toBe(1);
    expect(audit.suspiciousSessionCorpusLineCount).toBe(1);
    expect(audit.issues).toEqual([
      expect.objectContaining({
        code: "dreaming-session-corpus-self-ingested",
        fixable: true,
      }),
    ]);
  });

  it("does not flag ordinary transcript text that merely mentions dreaming-narrative", async () => {
    const workspaceDir = await createWorkspace();
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams", "session-corpus"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspaceDir, "memory", ".dreams", "session-corpus", "2026-04-11.txt"),
      [
        "[main/chat.jsonl#L4] regular session text",
        "[main/chat.jsonl#L5] We should inspect the dreaming-narrative session behavior tomorrow.",
      ].join("\n"),
      "utf-8",
    );

    const audit = await auditDreamingArtifacts({ workspaceDir });

    expect(audit.suspiciousSessionCorpusFileCount).toBe(0);
    expect(audit.suspiciousSessionCorpusLineCount).toBe(0);
    expect(audit.issues).toEqual([]);
  });

  it("rejects relative workspace paths during audit and repair", async () => {
    await expect(auditDreamingArtifacts({ workspaceDir: "relative/workspace" })).rejects.toThrow(
      "workspaceDir must be an absolute path",
    );
    await expect(repairDreamingArtifacts({ workspaceDir: "relative/workspace" })).rejects.toThrow(
      "workspaceDir must be an absolute path",
    );
  });

  it("archives derived dreaming artifacts without touching the diary by default", async () => {
    const workspaceDir = await createWorkspace();
    const sessionCorpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
    await fs.mkdir(sessionCorpusDir, { recursive: true });
    await fs.writeFile(path.join(sessionCorpusDir, "2026-04-11.txt"), "corpus\n", "utf-8");
    await fs.writeFile(
      path.join(workspaceDir, "memory", ".dreams", "session-ingestion.json"),
      JSON.stringify({ version: 3, files: {}, seenMessages: {} }, null, 2),
      "utf-8",
    );
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(dreamsPath, "# Dream Diary\n", "utf-8");

    const repair = await repairDreamingArtifacts({
      workspaceDir,
      now: new Date("2026-04-11T21:30:00.000Z"),
    });

    expect(repair.changed).toBe(true);
    expect(repair.archivedSessionCorpus).toBe(true);
    expect(repair.archivedSessionIngestion).toBe(true);
    expect(repair.archivedDreamsDiary).toBe(false);
    const archiveDir = requireArchiveDir(repair.archiveDir);
    expect(archiveDir).toBe(
      path.join(workspaceDir, ".openclaw-repair", "dreaming", "2026-04-11T21-30-00-000Z"),
    );
    await expect(fs.access(sessionCorpusDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.access(path.join(workspaceDir, "memory", ".dreams", "session-ingestion.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(dreamsPath, "utf-8")).resolves.toContain("# Dream Diary");
    const archivedEntries = await fs.readdir(archiveDir);
    expect(archivedEntries).toContainEqual(expect.stringMatching(/^session-corpus\./));
    expect(archivedEntries).toContainEqual(expect.stringMatching(/^session-ingestion\.json\./));
  });
});
