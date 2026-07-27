// Trajectory cleanup tests cover retention pruning of trajectory artifacts.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
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

  it("removes legacy runtime sidecars for SQLite marker sessions", async () => {
    await withTempDir({ prefix: "openclaw-trajectory-cleanup-" }, async (dir) => {
      const sessionId = "session-1";
      const storePath = path.join(dir, "sessions.json");
      const sessionFile = formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId,
        storePath,
      });
      const runtimeFile = resolveTrajectoryFilePath({ env: {}, sessionFile, sessionId });
      await fs.mkdir(path.dirname(runtimeFile), { recursive: true });
      await fs.writeFile(runtimeFile, runtimeEvent(sessionId), "utf8");

      const removed = await removeSessionTrajectoryArtifacts({
        sessionId,
        sessionFile,
        storePath,
        restrictToStoreDir: true,
      });

      expect(removed).toEqual([{ kind: "runtime", path: runtimeFile }]);
      await expectPathMissing(runtimeFile);
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
      const realReadSync = fsSync.readSync.bind(fsSync);
      let shortReadCalls = 0;
      const readSpy = vi.spyOn(fsSync, "readSync").mockImplementation(((
        fd: number,
        buffer: NodeJS.ArrayBufferView,
        offset: number,
        length: number,
        position: fsSync.ReadPosition | null,
      ) => {
        shortReadCalls += 1;
        return realReadSync(fd, buffer, offset, Math.min(length, 16), position);
      }) as typeof fsSync.readSync);
      try {
        await removeSessionTrajectoryArtifacts({
          sessionId,
          sessionFile,
          storePath,
          restrictToStoreDir: true,
        });
      } finally {
        readSpy.mockRestore();
      }

      await expectPathMissing(safeExternalRuntime);
      expect(shortReadCalls).toBeGreaterThan(1);
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

  it("ignores oversized trajectory pointers while still removing the sidecar", async () => {
    await withTempDir({ prefix: "openclaw-trajectory-cleanup-" }, async (dir) => {
      const sessionId = "session-oversized-pointer";
      const sessionsDir = path.join(dir, "sessions");
      const storePath = path.join(sessionsDir, "sessions.json");
      const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
      const externalRuntime = path.join(dir, "external", `${sessionId}.jsonl`);
      const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.mkdir(path.dirname(externalRuntime), { recursive: true });
      await fs.writeFile(externalRuntime, runtimeEvent(sessionId), "utf8");
      await fs.writeFile(
        pointerPath,
        `${pointerFile(sessionId, externalRuntime)}${" ".repeat(64 * 1024)}`,
        "utf8",
      );

      const removed = await removeSessionTrajectoryArtifacts({
        sessionId,
        sessionFile,
        storePath,
        restrictToStoreDir: true,
      });

      expect(removed).toEqual([{ kind: "pointer", path: pointerPath }]);
      expect((await fs.stat(externalRuntime)).isFile()).toBe(true);
      await expectPathMissing(pointerPath);
    });
  });
});
