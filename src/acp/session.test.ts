import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  createSession,
  getSession,
  getAllSessions,
  deleteSession,
  setActiveRun,
  getSessionByRunId,
  clearActiveRun,
  cancelActiveRun,
  clearAllSessions,
  initSessionStore,
} from "./session.js";

describe("acp session manager", () => {
  beforeEach(() => {
    clearAllSessions();
  });

  describe("createSession", () => {
    it("creates a session with unique ID", () => {
      const session = createSession("/test/path");
      expect(session.sessionId).toBeDefined();
      expect(session.sessionKey).toBe(`acp:${session.sessionId}`);
      expect(session.cwd).toBe("/test/path");
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.activeRunId).toBeNull();
      expect(session.abortController).toBeNull();
    });

    it("creates unique session IDs", () => {
      const s1 = createSession("/path1");
      const s2 = createSession("/path2");
      expect(s1.sessionId).not.toBe(s2.sessionId);
    });
  });

  describe("getSession", () => {
    it("returns session by ID", () => {
      const created = createSession("/get/test");
      const retrieved = getSession(created.sessionId);
      expect(retrieved).toBe(created);
    });

    it("returns undefined for unknown ID", () => {
      expect(getSession("nonexistent-id")).toBeUndefined();
    });
  });

  describe("getAllSessions", () => {
    it("returns all sessions", () => {
      createSession("/path1");
      createSession("/path2");
      createSession("/path3");
      
      const all = getAllSessions();
      expect(all.length).toBe(3);
    });

    it("returns empty array when no sessions", () => {
      expect(getAllSessions()).toEqual([]);
    });
  });

  describe("deleteSession", () => {
    it("deletes existing session", () => {
      const session = createSession("/delete/test");
      expect(deleteSession(session.sessionId)).toBe(true);
      expect(getSession(session.sessionId)).toBeUndefined();
    });

    it("returns false for unknown ID", () => {
      expect(deleteSession("nonexistent-id")).toBe(false);
    });

    it("aborts active run on delete", () => {
      const session = createSession("/delete/abort");
      const abortController = new AbortController();
      setActiveRun(session.sessionId, "run-1", abortController);
      
      let aborted = false;
      abortController.signal.addEventListener("abort", () => {
        aborted = true;
      });

      deleteSession(session.sessionId);
      expect(aborted).toBe(true);
    });
  });

  describe("active run management", () => {
    it("sets and gets active run", () => {
      const session = createSession("/run/test");
      const abortController = new AbortController();
      setActiveRun(session.sessionId, "run-123", abortController);

      const retrieved = getSession(session.sessionId);
      expect(retrieved?.activeRunId).toBe("run-123");
      expect(retrieved?.abortController).toBe(abortController);
    });

    it("finds session by runId", () => {
      const session = createSession("/run/lookup");
      setActiveRun(session.sessionId, "run-456", new AbortController());

      const found = getSessionByRunId("run-456");
      expect(found).toBe(session);
    });

    it("returns undefined for unknown runId", () => {
      expect(getSessionByRunId("unknown-run")).toBeUndefined();
    });

    it("clears active run", () => {
      const session = createSession("/run/clear");
      setActiveRun(session.sessionId, "run-789", new AbortController());
      clearActiveRun(session.sessionId);

      expect(session.activeRunId).toBeNull();
      expect(session.abortController).toBeNull();
      expect(getSessionByRunId("run-789")).toBeUndefined();
    });

    it("cancels active run and aborts", () => {
      const session = createSession("/run/cancel");
      const abortController = new AbortController();
      setActiveRun(session.sessionId, "run-cancel", abortController);

      let aborted = false;
      abortController.signal.addEventListener("abort", () => {
        aborted = true;
      });

      expect(cancelActiveRun(session.sessionId)).toBe(true);
      expect(aborted).toBe(true);
      expect(session.activeRunId).toBeNull();
    });

    it("cancelActiveRun returns false if no active run", () => {
      const session = createSession("/run/no-cancel");
      expect(cancelActiveRun(session.sessionId)).toBe(false);
    });
  });

  describe("persistence", () => {
    let tempDir: string;
    let storePath: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-test-"));
      storePath = path.join(tempDir, "sessions.json");
      clearAllSessions();
    });

    afterEach(() => {
      clearAllSessions();
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true });
      }
    });

    it("saves sessions to file", () => {
      initSessionStore(storePath);
      createSession("/persist/1");
      createSession("/persist/2");

      expect(fs.existsSync(storePath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(storePath, "utf8"));
      expect(data.length).toBe(2);
    });

    it("loads sessions from file", () => {
      // Create sessions with first store instance
      initSessionStore(storePath);
      const s1 = createSession("/load/1");
      const s2 = createSession("/load/2");
      const id1 = s1.sessionId;
      const id2 = s2.sessionId;

      // Verify file was written
      expect(fs.existsSync(storePath)).toBe(true);

      // Re-initialize from disk (simulates restart - this clears in-memory and reloads)
      initSessionStore(storePath);

      // Sessions should be restored
      expect(getSession(id1)).toBeDefined();
      expect(getSession(id2)).toBeDefined();
      expect(getSession(id1)?.cwd).toBe("/load/1");
      expect(getSession(id2)?.cwd).toBe("/load/2");
    });

    it("handles missing store file gracefully", () => {
      const missingPath = path.join(tempDir, "missing.json");
      expect(() => initSessionStore(missingPath)).not.toThrow();
      expect(getAllSessions()).toEqual([]);
    });

    it("handles corrupted store file gracefully", () => {
      fs.writeFileSync(storePath, "not valid json{{{");
      expect(() => initSessionStore(storePath)).not.toThrow();
      expect(getAllSessions()).toEqual([]);
    });
  });
});
