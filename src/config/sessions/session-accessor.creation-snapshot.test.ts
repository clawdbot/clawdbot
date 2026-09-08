import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir, cleanupTempDirs } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createSessionEntryWithTranscript,
  assignSessionOwner,
  recordSessionParticipant,
  listSessionEntriesCore,
  loadSessionEntry,
  replaceSessionEntrySync,
  replaceTranscriptEventsSync,
} from "./session-accessor.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import { readTranscriptStorageRows } from "./session-accessor.sqlite-read.js";

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("session creation snapshot", () => {
  it.each([undefined, 3, 4, 99])(
    "preserves adopted history without selecting a new projection (header=%s)",
    async (version) => {
      const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "creation-history-") };
      const scope = { agentId: "main", env, sessionKey: "agent:main:target", sessionId: "target" };
      const entry = { sessionId: "target", updatedAt: 1 };
      replaceSessionEntrySync(scope, entry);
      const database = openOpenClawAgentDatabase(scope);
      let before: ReturnType<typeof readTranscriptStorageRows> = [];
      const result = await createSessionEntryWithTranscript(scope, async () => {
        await Promise.resolve();
        replaceTranscriptEventsSync(scope, [
          ...(version === undefined
            ? []
            : [{ type: "session", id: "target", version, cwd: "/workspace" }]),
          {
            type: "message",
            id: "user-1",
            parentId: null,
            timestamp: "2026-07-15T21:23:03.698Z",
            message: { role: "user", content: "Retained text.\r\n  Keep spacing." },
          },
        ]);
        before = readTranscriptStorageRows(database, "target");
        return { ok: true, entry: { ...entry, label: "adopted" } };
      });
      expect(result).toMatchObject({ ok: true, entry: { ...entry, label: "adopted" } });
      expect(readTranscriptStorageRows(database, "target")).toEqual(before);
    },
  );

  it("prepares and adopts a complete target without decoding sibling saved prompts", async () => {
    const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "creation-snapshot-") };
    const scope = { agentId: "main", env, sessionKey: "agent:main:target" };
    const target = {
      sessionId: "target",
      updatedAt: 1,
      skillsSnapshot: { prompt: "target-saved-prompt", skills: [] },
      systemPromptReport: {
        source: "run" as const,
        generatedAt: 1,
        systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      },
    };
    replaceSessionEntrySync(scope, target);
    for (let index = 0; index < 3; index++) {
      replaceSessionEntrySync(
        { ...scope, sessionKey: `agent:main:sibling-${index}` },
        {
          sessionId: `sibling-${index}`,
          updatedAt: 1,
          skillsSnapshot: { prompt: "unrelated-saved-prompt".repeat(1024), skills: [] },
        },
      );
    }
    assignSessionOwner(scope, {
      owner: { type: "human", id: "owner" },
      assignedBy: { type: "system", id: "fixture" },
      assignedAt: 1,
    });
    recordSessionParticipant(scope, { identity: { type: "agent", id: "peer" }, promptedAt: 1 });
    const parse = vi.spyOn(JSON, "parse");
    const created = await createSessionEntryWithTranscript(scope, ({ existingEntry }) => {
      const siblingPayloadReads = parse.mock.calls.filter(([json]) =>
        json.includes("unrelated-saved-prompt"),
      ).length;
      parse.mockRestore();
      expect(existingEntry).toMatchObject(target);
      expect(siblingPayloadReads).toBe(0);
      return { ok: true, entry: { ...existingEntry!, label: "adopted" } };
    });
    expect(created).toMatchObject({ ok: true, entry: { ...target, label: "adopted" } });
    expect(loadSessionEntry(scope)).toMatchObject({
      ...target,
      label: "adopted",
      owner: { actor: { type: "human", id: "owner" } },
      participants: [{ identity: { type: "agent", id: "peer" } }],
      participantCount: 1,
    });
  });
  it.each([false, true])(
    "preserves normalized and opaque target identities (cold=%s)",
    async (cold) => {
      const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "creation-identities-") };
      const scope = { agentId: "main", env };
      const key = "agent:main:matrix:group:!Room:example.org";
      const sibling = "agent:main:matrix:group:!room:example.org";
      const entry = {
        sessionId: "target",
        updatedAt: 1,
        label: "own",
        skillsSnapshot: { prompt: "preserved target", skills: [] },
      };
      replaceSessionEntrySync({ ...scope, sessionKey: key }, entry);
      replaceSessionEntrySync(
        { ...scope, sessionKey: sibling },
        { sessionId: "sibling", updatedAt: 1, label: "taken" },
      );
      if (cold) {
        closeOpenClawAgentDatabasesForTest();
      }
      const result = await createSessionEntryWithTranscript(
        { ...scope, sessionKey: "AGENT:MAIN:MATRIX:GROUP:!Room:example.org" },
        (context) => {
          expect(context.existingEntry).toMatchObject(entry);
          expect(context.targetEntry).toMatchObject(entry);
          expect(context.isLabelInUse("own")).toBe(false);
          expect(context.isLabelInUse("taken")).toBe(true);
          return { ok: false, error: "inspection complete" };
        },
      );
      expect(result).toMatchObject({ ok: false, phase: "entry" });
      expect(loadSessionEntry({ ...scope, sessionKey: sibling })?.sessionId).toBe("sibling");
    },
  );

  it.each(["malformed", "mismatched-window", "mismatched-time", "nul"])(
    "preserves warm listing behavior for a %s target",
    async (kind) => {
      const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "creation-warm-rows-") };
      const scope = { agentId: "main", env, sessionKey: "agent:main:target" };
      const entry = {
        sessionId: "target",
        updatedAt: 1,
        label: "target",
        skillsSnapshot: { prompt: "saved target", skills: [] },
      };
      replaceSessionEntrySync(scope, entry);
      replaceSessionEntrySync(
        { ...scope, sessionKey: "agent:main:sibling" },
        { sessionId: "sibling", updatedAt: 1, label: "taken" },
      );
      listSessionEntriesCore(scope);
      const db = openOpenClawAgentDatabase(scope).db;
      if (kind === "malformed" || kind === "nul") {
        db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
          kind === "malformed" ? "{" : JSON.stringify(entry) + "\0trailing",
          scope.sessionKey,
        );
      } else if (kind === "mismatched-window") {
        db.prepare("UPDATE session_nodes SET current_session_id = ? WHERE session_key = ?").run(
          "different",
          scope.sessionKey,
        );
      } else {
        db.prepare("UPDATE session_nodes SET updated_at = ? WHERE session_key = ?").run(
          2,
          scope.sessionKey,
        );
      }
      const expected = listSessionEntriesCore(scope).find(
        (row) => row.sessionKey === scope.sessionKey,
      )?.entry;
      await createSessionEntryWithTranscript(scope, (context) => {
        expect(context.existingEntry).toEqual(expected);
        expect(context.targetEntry).toEqual(expected);
        expect(context.isLabelInUse("taken")).toBe(true);
        return { ok: false, error: "inspection complete" };
      });
      closeOpenClawAgentDatabasesForTest();
      await expect(
        createSessionEntryWithTranscript(scope, () => ({ ok: false, error: "unreachable" })),
      ).rejects.toThrow("openclaw doctor --fix");
    },
  );

  it("keeps the target and sibling labels on one snapshot across an external commit and callback await", async () => {
    const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "creation-concurrent-snapshot-") };
    const scope = { agentId: "main", env, sessionKey: "agent:main:a-target" };
    const entry = {
      sessionId: "target",
      updatedAt: 1,
      skillsSnapshot: { prompt: "snapshot-target-marker", skills: [] },
    };
    const sibling = { sessionId: "sibling", updatedAt: 1, label: "old label" };
    replaceSessionEntrySync(scope, entry);
    replaceSessionEntrySync({ ...scope, sessionKey: "agent:main:z-sibling" }, sibling);
    listSessionEntriesCore(scope);
    const external = new DatabaseSync(openOpenClawAgentDatabase(scope).path);
    const parse = JSON.parse;
    let changed = false;
    vi.spyOn(JSON, "parse").mockImplementation((value, ...rest) => {
      const result = parse(value, ...rest);
      if (!changed && value.includes("snapshot-target-marker")) {
        changed = true;
        const update = external.prepare(
          "UPDATE session_nodes SET entry_json = ? WHERE session_key = ?",
        );
        external.exec("BEGIN");
        update.run(
          JSON.stringify({ ...entry, skillsSnapshot: { prompt: "new target", skills: [] } }),
          scope.sessionKey,
        );
        update.run(JSON.stringify({ ...sibling, label: "new label" }), "agent:main:z-sibling");
        external.exec("COMMIT");
      }
      return result;
    });
    try {
      await createSessionEntryWithTranscript(scope, async (context) => {
        await Promise.resolve();
        expect(changed).toBe(true);
        expect(context.targetEntry).toMatchObject(entry);
        expect(context.isLabelInUse("old label")).toBe(true);
        expect(context.isLabelInUse("new label")).toBe(false);
        return { ok: false, error: "inspection complete" };
      });
    } finally {
      external.close();
    }
    expect(loadSessionEntry(scope)?.skillsSnapshot?.prompt).toBe("new target");
  });
  it("keeps selective full payloads detached from the metadata cache", () => {
    const env = { OPENCLAW_STATE_DIR: makeTempDir(tempDirs, "creation-cache-") };
    const scope = { agentId: "main", env, sessionKey: "agent:main:target" };
    replaceSessionEntrySync(scope, {
      sessionId: "target",
      updatedAt: 1,
      label: "original",
      skillsSnapshot: { prompt: "saved target", skills: [] },
    });
    const database = openOpenClawAgentDatabase(scope);
    const options = { cache: true, projection: "list" as const };
    readSessionEntryCache(database, options);
    const mixed = readSessionEntryCache(database, {
      ...options,
      fullEntryKeys: [scope.sessionKey],
    });
    const target = mixed.entries.get(scope.sessionKey);
    expect(target?.skillsSnapshot?.prompt).toBe("saved target");
    if (!target) {
      throw new Error("Missing target");
    }
    target.label = "caller mutation";
    const metadata = readSessionEntryCache(database, options).entries.get(scope.sessionKey);
    expect(metadata?.label).toBe("original");
    expect(metadata).not.toHaveProperty("skillsSnapshot");
  });
});
