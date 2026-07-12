import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  hasTerminalMainSessionTranscriptNewerThanRegistry,
  hasTerminalMainSessionTranscriptNewerThanRegistrySync,
} from "./lifecycle.js";
import { appendTranscriptEvent, loadSessionEntry, upsertSessionEntry } from "./session-accessor.js";
import type { SessionEntry } from "./types.js";

describe("terminal main session transcript freshness", () => {
  let stateDir: string;
  let storePath: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-lifecycle-"));
    storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  async function createEntry(params: {
    endedAt?: number;
    sessionFile?: string;
    sessionKey?: string;
    status?: SessionEntry["status"];
    updatedAt: number;
  }): Promise<{ entry: SessionEntry; sessionKey: string }> {
    const sessionKey = params.sessionKey ?? "agent:main:main";
    const sessionId = `session-${params.status ?? "ended"}-${sessionKey.replaceAll(":", "-")}`;
    const sessionEntry = {
      sessionFile:
        params.sessionFile ??
        `sqlite:main:${sessionId}:${resolveOpenClawAgentSqlitePath({
          agentId: "main",
          env: { OPENCLAW_STATE_DIR: stateDir },
        })}`,
      sessionId,
      updatedAt: params.updatedAt,
      ...(params.endedAt !== undefined ? { endedAt: params.endedAt } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
    };
    await upsertSessionEntry({ agentId: "main", sessionKey, storePath }, sessionEntry);
    await appendTranscriptEvent(
      { agentId: "main", sessionId, sessionKey, storePath },
      {
        type: "custom",
        timestamp: "1970-01-01T00:00:00.001Z",
      },
    );
    const storedEntry = loadSessionEntry({ agentId: "main", sessionKey, storePath });
    if (!storedEntry) {
      throw new Error("expected session entry");
    }
    return {
      entry: {
        ...storedEntry,
        sessionFile: sessionEntry.sessionFile,
        updatedAt: params.updatedAt,
        ...(params.endedAt !== undefined ? { endedAt: params.endedAt } : {}),
        ...(params.status !== undefined ? { status: params.status } : {}),
      },
      sessionKey,
    };
  }

  function check(entry: SessionEntry, sessionKey: string): boolean {
    return hasTerminalMainSessionTranscriptNewerThanRegistrySync({
      agentId: "main",
      entry,
      sessionKey,
      storePath,
    });
  }

  it("uses the physical SQLite mutation watermark instead of event timestamps", async () => {
    const registryTimestampMs = Date.now() - 10_000;
    const { entry, sessionKey } = await createEntry({
      status: "killed",
      updatedAt: registryTimestampMs,
    });

    expect(entry.updatedAt).toBe(registryTimestampMs);
    expect(check(entry, sessionKey)).toBe(true);
    await expect(
      hasTerminalMainSessionTranscriptNewerThanRegistry({
        agentId: "main",
        entry,
        sessionKey,
        storePath,
      }),
    ).resolves.toBe(true);
  });

  it.each(["done", "failed"] as const)("keeps %s terminal sessions reusable", async (status) => {
    const { entry, sessionKey } = await createEntry({
      status,
      updatedAt: Date.now() - 10_000,
    });

    expect(check(entry, sessionKey)).toBe(false);
  });

  it("rotates endedAt-only main sessions after a later transcript mutation", async () => {
    const { entry, sessionKey } = await createEntry({
      endedAt: Date.now() - 20_000,
      updatedAt: Date.now() - 10_000,
    });

    expect(entry.status).toBeUndefined();
    expect(check(entry, sessionKey)).toBe(true);
  });

  it("uses SQLite freshness for entries that still contain legacy transcript paths", async () => {
    const { entry, sessionKey } = await createEntry({
      sessionFile: path.join(stateDir, "legacy-session.jsonl"),
      status: "killed",
      updatedAt: Date.now() - 10_000,
    });

    expect(check(entry, sessionKey)).toBe(true);
  });

  it("does not rotate after a same-millisecond registry write observes the mutation", async () => {
    const now = 1_700_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    const { entry, sessionKey } = await createEntry({
      status: "killed",
      updatedAt: now,
    });
    expect(check(entry, sessionKey)).toBe(true);

    await upsertSessionEntry({ agentId: "main", sessionKey, storePath }, entry);
    const refreshed = loadSessionEntry({ agentId: "main", sessionKey, storePath });
    dateNow.mockRestore();

    if (!refreshed) {
      throw new Error("expected refreshed session entry");
    }
    expect(check(refreshed, sessionKey)).toBe(false);
  });

  it("does not rotate non-main sessions or rows newer than the transcript", async () => {
    const nonMain = await createEntry({
      sessionKey: "agent:main:other",
      status: "killed",
      updatedAt: Date.now() - 10_000,
    });
    const newerRegistry = await createEntry({
      status: "timeout",
      updatedAt: Date.now() + 10_000,
    });
    await upsertSessionEntry(
      { agentId: "main", sessionKey: newerRegistry.sessionKey, storePath },
      newerRegistry.entry,
    );
    const refreshedRegistry = loadSessionEntry({
      agentId: "main",
      sessionKey: newerRegistry.sessionKey,
      storePath,
    });
    if (!refreshedRegistry) {
      throw new Error("expected refreshed registry entry");
    }

    expect(check(nonMain.entry, nonMain.sessionKey)).toBe(false);
    expect(check(refreshedRegistry, newerRegistry.sessionKey)).toBe(false);
  });
});
