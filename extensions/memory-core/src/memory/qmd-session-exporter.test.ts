import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildSessionEntry: vi.fn(),
  corpusEntries: vi.fn(),
  replaceArtifactMappings: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-qmd", () => ({
  buildSessionEntry: mocks.buildSessionEntry,
  isSessionArchiveArtifactName: () => false,
  listSessionTranscriptCorpusEntriesForAgent: mocks.corpusEntries,
  resolveSessionIdentityForTranscriptFile: () => null,
}));

vi.mock("../qmd-session-artifacts.js", () => ({
  refreshQmdSessionArtifactDocIds: vi.fn(),
  replaceQmdSessionArtifactMappings: mocks.replaceArtifactMappings,
}));

import { QmdSessionExporter } from "./qmd-session-exporter.js";

const createLease = () => ({
  assertOwned: vi.fn(),
  signal: new AbortController().signal,
});

describe("QmdSessionExporter", () => {
  beforeEach(() => {
    mocks.buildSessionEntry.mockReset();
    mocks.corpusEntries.mockReset();
    mocks.replaceArtifactMappings.mockReset();
  });

  it("skips unchanged transcript parsing by canonical corpus revision", async () => {
    await withTempDir("qmd-session-exporter-", async (tempDir) => {
      const exportDir = path.join(tempDir, "exports");
      const corpusEntry = {
        agentId: "main",
        artifactKind: "active-session" as const,
        contentRevision: "sqlite:1:100:1:1",
        sessionFile: "sqlite:main:session-1",
        sessionId: "session-1",
        transcriptSource: "sqlite" as const,
        updatedAtMs: 1,
      };
      mocks.corpusEntries.mockImplementation(async () => [corpusEntry]);
      mocks.buildSessionEntry.mockResolvedValue({
        absPath: corpusEntry.sessionFile,
        content: "User: first",
        hash: "first",
        lineMap: [1],
        messageTimestampsMs: [1],
        mtimeMs: 1,
        path: "sessions/main/session-1.jsonl",
        size: 100,
      });
      const exporter = new QmdSessionExporter(
        { collectionName: "sessions-main", dir: exportDir },
        "main",
        tempDir,
        path.join(tempDir, "index.sqlite"),
        () => "unused",
      );
      const lease = createLease();

      await exporter.exportSessions(lease);
      await exporter.exportSessions(lease);

      expect(mocks.buildSessionEntry).toHaveBeenCalledTimes(1);
      await expect(fs.readFile(path.join(exportDir, "session-1.md"), "utf8")).resolves.toContain(
        "User: first",
      );

      corpusEntry.contentRevision = "sqlite:2:200:2:2";
      mocks.buildSessionEntry.mockResolvedValue({
        absPath: corpusEntry.sessionFile,
        content: "User: second",
        hash: "second",
        lineMap: [1],
        messageTimestampsMs: [2],
        mtimeMs: 2,
        path: "sessions/main/session-1.jsonl",
        size: 200,
      });
      await exporter.exportSessions(lease);

      expect(mocks.buildSessionEntry).toHaveBeenCalledTimes(2);
      await expect(fs.readFile(path.join(exportDir, "session-1.md"), "utf8")).resolves.toContain(
        "User: second",
      );
    });
  });

  it("atomically repairs a missing or replaced export without hashing the transcript", async () => {
    await withTempDir("qmd-session-exporter-", async (tempDir) => {
      const exportDir = path.join(tempDir, "exports");
      const corpusEntry = {
        agentId: "main",
        artifactKind: "active-session" as const,
        contentRevision: "sqlite:1:100:1:1",
        sessionFile: "sqlite:main:session-1",
        sessionId: "session-1",
        transcriptSource: "sqlite" as const,
        updatedAtMs: 1,
      };
      mocks.corpusEntries.mockResolvedValue([corpusEntry]);
      mocks.buildSessionEntry.mockResolvedValue({
        absPath: corpusEntry.sessionFile,
        content: "User: canonical",
        hash: "canonical",
        lineMap: [1],
        messageTimestampsMs: [1],
        mtimeMs: 1,
        path: "sessions/main/session-1.jsonl",
        size: 100,
      });
      const exporter = new QmdSessionExporter(
        { collectionName: "sessions-main", dir: exportDir },
        "main",
        tempDir,
        path.join(tempDir, "index.sqlite"),
        () => "unused",
      );
      const target = path.join(exportDir, "session-1.md");
      const lease = createLease();

      await exporter.exportSessions(lease);
      await fs.writeFile(target, "corrupt", "utf8");
      await exporter.exportSessions(lease);
      await fs.rm(target);
      await exporter.exportSessions(lease);

      expect(mocks.buildSessionEntry).toHaveBeenCalledTimes(3);
      await expect(fs.readFile(target, "utf8")).resolves.toContain("User: canonical");
    });
  });
});
