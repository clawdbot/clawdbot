// Transcript archive event tests ensure file archive/delete operations emit
// path-only internal transcript update notifications.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveSessionTranscriptsDetailed } from "./session-transcript-files.fs.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("archiveSessionTranscriptsDetailed failure surface", () => {
  it("invokes onArchiveError when fs.renameSync fails and returns only successful entries", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-failure-"));
    try {
      const sessionId = "11111111-1111-4111-8111-111111111111";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      fs.writeFileSync(sessionFile, '{"type":"session-meta","agentId":"main"}\n');

      const renameError = Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
        throw renameError;
      });

      const errors: Array<{ err: unknown; sourcePath: string }> = [];
      const archived = archiveSessionTranscriptsDetailed({
        sessionId,
        storePath: path.join(tmpDir, "store.json"),
        sessionFile,
        agentId: "main",
        reason: "reset",
        onArchiveError: (err, sourcePath) => {
          errors.push({ err, sourcePath });
        },
      });

      renameSpy.mockRestore();

      expect(archived).toEqual([]);
      expect(errors.length).toBeGreaterThan(0);
      expect(expectDefined(errors[0], "errors[0] test invariant").err).toBe(renameError);
      expect(fs.existsSync(sessionFile)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("archives normally when no onArchiveError is provided", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-success-"));
    try {
      const sessionId = "22222222-2222-4222-8222-222222222222";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      fs.writeFileSync(sessionFile, '{"type":"session-meta","agentId":"main"}\n');

      const archived = archiveSessionTranscriptsDetailed({
        sessionId,
        storePath: path.join(tmpDir, "store.json"),
        sessionFile,
        agentId: "main",
        reason: "reset",
      });

      expect(archived.length).toBe(1);
      expect(expectDefined(archived[0], "archived[0] test invariant").archivedPath).toContain(
        ".jsonl.reset.",
      );
      expect(
        fs.existsSync(expectDefined(archived[0], "archived[0] test invariant").archivedPath),
      ).toBe(true);
      expect(fs.existsSync(sessionFile)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("surfaces real chmod archive failures through onArchiveError", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      return;
    }

    const tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-real-eacces-")),
    );
    try {
      const sessionId = "33333333-3333-4333-8333-333333333333";
      const sessionFile = path.join(tmpDir, `${sessionId}.jsonl`);
      fs.writeFileSync(sessionFile, '{"type":"session-meta","agentId":"main"}\n');
      fs.chmodSync(tmpDir, 0o555);

      const errors: Array<{ code?: string; sourcePath: string }> = [];
      let archived: ReturnType<typeof archiveSessionTranscriptsDetailed> = [];
      try {
        archived = archiveSessionTranscriptsDetailed({
          sessionId,
          storePath: path.join(tmpDir, "store.json"),
          sessionFile,
          agentId: "main",
          reason: "reset",
          onArchiveError: (err, sourcePath) => {
            const code = (err as NodeJS.ErrnoException | undefined)?.code;
            errors.push({ code, sourcePath });
          },
        });
      } finally {
        fs.chmodSync(tmpDir, 0o755);
      }

      expect(archived).toEqual([]);
      expect(errors.length).toBeGreaterThan(0);
      expect(expectDefined(errors[0], "errors[0] test invariant").sourcePath).toBe(sessionFile);
      expect(expectDefined(errors[0], "errors[0] test invariant").code).toMatch(/^(EACCES|EPERM)$/);
      expect(fs.existsSync(sessionFile)).toBe(true);
    } finally {
      try {
        fs.chmodSync(tmpDir, 0o755);
      } catch {
        // Already restored.
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
