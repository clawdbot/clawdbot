import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";

const note = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

import { noteSessionLockHealth } from "./doctor-session-locks.js";

describe("noteSessionLockHealth", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    note.mockClear();
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-doctor-locks-",
    });
  });

  afterEach(async () => {
    await state.cleanup();
  });

  it("reports existing lock files with pid status and age", async () => {
    const sessionsDir = state.sessionsDir();
    await fs.mkdir(sessionsDir, { recursive: true });
    const lockPath = path.join(sessionsDir, "active.jsonl.lock");
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: new Date(Date.now() - 1500).toISOString() }),
      "utf8",
    );

    await noteSessionLockHealth({ shouldRepair: false, staleMs: 60_000 });

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] as [string, string];
    expect(title).toBe("Session locks");
    expect(message).toContain("Found 1 session lock file");
    expect(message).toContain(`pid=${process.pid} (alive)`);
    expect(message).toContain("stale=no");
    await expect(fs.access(lockPath)).resolves.toBeUndefined();
  });

  it("removes stale locks in repair mode", async () => {
    const sessionsDir = state.sessionsDir();
    await fs.mkdir(sessionsDir, { recursive: true });

    const staleLock = path.join(sessionsDir, "stale.jsonl.lock");
    const freshLock = path.join(sessionsDir, "fresh.jsonl.lock");

    await fs.writeFile(
      staleLock,
      JSON.stringify({ pid: -1, createdAt: new Date(Date.now() - 120_000).toISOString() }),
      "utf8",
    );
    await fs.writeFile(
      freshLock,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      "utf8",
    );

    await noteSessionLockHealth({ shouldRepair: true, staleMs: 30_000 });

    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] as [string, string];
    expect(message).toContain("[removed]");
    expect(message).toContain("Removed 1 stale session lock file");

    await expect(fs.access(staleLock)).rejects.toThrow();
    await expect(fs.access(freshLock)).resolves.toBeUndefined();
  });
});
