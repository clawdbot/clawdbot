import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  onSessionTranscriptUpdate,
  type SessionTranscriptUpdate,
} from "../sessions/transcript-events.js";
import { archiveFileOnDisk } from "./session-transcript-files.fs.js";

const subscriptions: Array<() => void> = [];

afterEach(() => {
  while (subscriptions.length > 0) {
    subscriptions.pop()?.();
  }
});

describe("archiveFileOnDisk transcript updates", () => {
  it("emits a session transcript update for the archived path on reset", () => {
    const updates: SessionTranscriptUpdate[] = [];
    subscriptions.push(onSessionTranscriptUpdate((update) => updates.push(update)));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-events-reset-"));
    try {
      const sessionFile = path.join(tmpDir, "live.jsonl");
      fs.writeFileSync(sessionFile, '{"type":"session-meta","agentId":"main"}\n');

      const archived = archiveFileOnDisk(sessionFile, "reset");

      expect(fs.existsSync(archived)).toBe(true);
      expect(fs.existsSync(sessionFile)).toBe(false);
      expect(archived).toContain(".jsonl.reset.");
      expect(updates).toHaveLength(1);
      expect(updates[0].sessionFile).toBe(archived);
      // Archive does not carry a messageId/message payload — this is a
      // pure-path mutation notification, matching how compaction-only
      // emits (sessionFile + sessionKey-only) behave.
      expect(updates[0].message).toBeUndefined();
      expect(updates[0].messageId).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("also emits for deleted and bak archive reasons", () => {
    const updates: SessionTranscriptUpdate[] = [];
    subscriptions.push(onSessionTranscriptUpdate((update) => updates.push(update)));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-archive-events-mixed-"));
    try {
      const deletedSource = path.join(tmpDir, "deleted.jsonl");
      fs.writeFileSync(deletedSource, "{}\n");
      const deletedArchived = archiveFileOnDisk(deletedSource, "deleted");

      const bakSource = path.join(tmpDir, "bak.jsonl");
      fs.writeFileSync(bakSource, "{}\n");
      const bakArchived = archiveFileOnDisk(bakSource, "bak");

      expect(deletedArchived).toContain(".jsonl.deleted.");
      expect(bakArchived).toContain(".jsonl.bak.");
      expect(updates.map((update) => update.sessionFile)).toEqual([deletedArchived, bakArchived]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
