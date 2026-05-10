import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  removeRemovedSessionTrajectoryArtifacts,
  removeSessionTrajectoryArtifacts,
} from "./cleanup.js";
import { resolveTrajectoryFilePath, resolveTrajectoryPointerFilePath } from "./paths.js";

function runtimeEvent(sessionId: string): string {
  return `${JSON.stringify({
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: sessionId,
    source: "runtime",
    type: "session.started",
    ts: "2026-04-22T08:00:00.000Z",
    seq: 1,
    sourceSeq: 1,
    sessionId,
  })}\n`;
}

function pointerFile(sessionId: string, runtimeFile: string): string {
  return `${JSON.stringify({
    traceSchema: "openclaw-trajectory-pointer",
    schemaVersion: 1,
    sessionId,
    runtimeFile,
  })}\n`;
}

async function expectPathMissing(targetPath: string): Promise<void> {
  let statError: unknown;
  try {
    await fs.stat(targetPath);
  } catch (error) {
    statError = error;
  }
  expect((statError as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
}

describe("trajectory cleanup", () => {
  it("removes adjacent trajectory sidecars for a deleted session", async () => {
    await withTempDir({ prefix: "openclaw-trajectory-cleanup-" }, async (dir) => {
      const sessionId = "session-1";
      const storePath = path.join(dir, "sessions.json");
      const sessionFile = path.join(dir, `${sessionId}.jsonl`);
      const runtimeFile = resolveTrajectoryFilePath({ env: {}, sessionFile, sessionId });
      const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
      await fs.writeFile(runtimeFile, runtimeEvent(sessionId), "utf8");
      await fs.writeFile(pointerPath, pointerFile(sessionId, runtimeFile), "utf8");

      const removed = await removeSessionTrajectoryArtifacts({
        sessionId,
        sessionFile,
        storePath,
        restrictToStoreDir: true,
      });

      expect(removed.map((entry) => entry.kind).toSorted()).toEqual(["pointer", "runtime"]);
      await expectPathMissing(runtimeFile);
      await expectPathMissing(pointerPath);
    });
  });

  it("skips removed sessions still referenced by surviving store rows", async () => {
    await withTempDir({ prefix: "openclaw-trajectory-cleanup-" }, async (dir) => {
      const sessionId = "shared-session";
      const storePath = path.join(dir, "sessions.json");
      const sessionFile = path.join(dir, `${sessionId}.jsonl`);
      const runtimeFile = resolveTrajectoryFilePath({ env: {}, sessionFile, sessionId });
      const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
      await fs.writeFile(runtimeFile, runtimeEvent(sessionId), "utf8");
      await fs.writeFile(pointerPath, pointerFile(sessionId, runtimeFile), "utf8");

      const removed = await removeRemovedSessionTrajectoryArtifacts({
        removedSessionFiles: [[sessionId, sessionFile]],
        referencedSessionIds: new Set([sessionId]),
        storePath,
        restrictToStoreDir: true,
      });

      expect(removed).toStrictEqual([]);
      expect((await fs.stat(runtimeFile)).isFile()).toBe(true);
      expect((await fs.stat(pointerPath)).isFile()).toBe(true);
    });
  });

  it("only removes external pointer targets that prove they belong to the session", async () => {
    await withTempDir({ prefix: "openclaw-trajectory-cleanup-" }, async (dir) => {
      const sessionId = "session-2";
      const sessionsDir = path.join(dir, "sessions");
      const storePath = path.join(sessionsDir, "sessions.json");
      const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
      const externalDir = path.join(dir, "external");
      await fs.mkdir(sessionsDir);
      await fs.mkdir(externalDir);
      const safeExternalRuntime = path.join(externalDir, `${sessionId}.jsonl`);
      const unsafeExternalRuntime = path.join(externalDir, "unsafe.jsonl");
      await fs.writeFile(safeExternalRuntime, runtimeEvent(sessionId), "utf8");
      await fs.writeFile(unsafeExternalRuntime, runtimeEvent(sessionId), "utf8");

      const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
      await fs.writeFile(pointerPath, pointerFile(sessionId, safeExternalRuntime), "utf8");
      await removeSessionTrajectoryArtifacts({
        sessionId,
        sessionFile,
        storePath,
        restrictToStoreDir: true,
      });

      await expectPathMissing(safeExternalRuntime);
      await expectPathMissing(pointerPath);

      await fs.writeFile(pointerPath, pointerFile(sessionId, unsafeExternalRuntime), "utf8");
      await removeSessionTrajectoryArtifacts({
        sessionId,
        sessionFile,
        storePath,
        restrictToStoreDir: true,
      });

      expect((await fs.stat(unsafeExternalRuntime)).isFile()).toBe(true);
    });
  });
});
