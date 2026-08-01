import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replaceArtifactMappings: vi.fn(),
}));

vi.mock("../qmd-session-artifacts.js", () => ({
  refreshQmdSessionArtifactDocIds: vi.fn(),
  replaceQmdSessionArtifactMappings: mocks.replaceArtifactMappings,
}));

import { QmdSessionExporter } from "./qmd-session-exporter.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  closeOpenClawAgentDatabasesForTest();
  mocks.replaceArtifactMappings.mockReset();
});

describe("QmdSessionExporter archives", () => {
  it("exports compressed reset/delete history as readable Markdown", async () => {
    const codec = zlib as typeof zlib & {
      zstdCompressSync?: (data: Buffer) => Buffer;
    };
    if (!codec.zstdCompressSync) {
      return;
    }
    await withTempDir("qmd-session-archive-", async (tempDir) => {
      process.env.OPENCLAW_STATE_DIR = tempDir;
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      const sessionsDir = path.join(tempDir, "agents", "main", "sessions");
      const archiveName = "compressed.jsonl.deleted.2026-07-11T00-00-00.000Z.zst";
      const content = `${JSON.stringify({
        type: "message",
        message: { role: "user", content: "Compressed QMD archive" },
      })}\n`;
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionsDir, archiveName),
        codec.zstdCompressSync(Buffer.from(content)),
      );
      const exportDir = path.join(tempDir, "exports");
      const exporter = new QmdSessionExporter(
        { collectionName: "sessions-main", dir: exportDir },
        "main",
        tempDir,
        path.join(tempDir, "index.sqlite"),
        () => "unused",
      );

      await exporter.exportSessions({
        assertOwned: vi.fn(),
        signal: new AbortController().signal,
      });

      await expect(
        fs.readFile(path.join(exportDir, `${archiveName}.md`), "utf8"),
      ).resolves.toContain("User: Compressed QMD archive");
    });
  });
});
