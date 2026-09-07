import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  loadSessionEntry,
  onSessionIdentityMutation,
  patchSessionEntryCore,
  recordSessionParticipant,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { readSessionEntryStore } from "./session-accessor.sqlite-entry-inventory.js";
import {
  patchSessionEntryTarget,
  replaceSessionEntrySync,
} from "./session-accessor.sqlite-entry.js";
import { readSessionGenerationIdsForKeys } from "./session-accessor.sqlite-lifecycle-state.js";
import { projectSqliteSessionParticipantsBatch } from "./session-accessor.sqlite-participant-projection.js";
import { readSessionEntriesByStatus } from "./session-accessor.sqlite-status.js";
import {
  projectPublicSessionEntry,
  projectPublicSessionEntryPatch,
} from "./session-entry-projection.js";
import type { InternalSessionEntry } from "./types.js";

const tempDirs = createTempDirTracker();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("SQLite session row persistence", () => {
  it.each(["entry", "target"] as const)(
    "bounds saved-prompt decoding while publishing %s identity changes",
    async (kind) => {
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("session-identity-decode-")),
      };
      const sessionKey = "agent:main:identity-decode";
      const scope = { agentId: "main", env, sessionKey };
      const skillsSnapshot = {
        prompt: "identity-decode-payload:" + "x".repeat(16_384),
        skills: [],
      };
      await upsertSessionEntryCore(scope, { sessionId: "initial", updatedAt: 1, skillsSnapshot });
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const identities: string[] = [];
      const unsubscribe = onSessionIdentityMutation((mutation) => {
        if (
          mutation.kind !== "delete" &&
          mutation.current.sessionKeys.includes(sessionKey) &&
          mutation.current.sessionId
        ) {
          identities.push(mutation.current.sessionId);
        }
      });
      const parse = vi.spyOn(JSON, "parse");
      const iterations = 10;
      try {
        for (let index = 0; index < iterations; index++) {
          const sessionId = `generation-${Math.floor(index / 2)}`;
          const update = () => ({ sessionId, updatedAt: index + 2 });
          const result =
            kind === "entry"
              ? await patchSessionEntryCore(scope, update, { skipMaintenance: true })
              : await patchSessionEntryTarget(
                  {
                    agentId: "main",
                    storePath: database.path,
                    target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
                  },
                  update,
                  { skipMaintenance: true },
                );
          expect(result).toMatchObject({ sessionId, skillsSnapshot });
        }
        const decodes = parse.mock.calls.filter(([text]) =>
          text.includes("identity-decode-payload:"),
        ).length;
        expect(decodes).toBeLessThanOrEqual(iterations * 3);
      } finally {
        parse.mockRestore();
        unsubscribe();
      }
      expect(identities).toEqual(Array.from({ length: 5 }, (_, index) => `generation-${index}`));
      expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "generation-4", skillsSnapshot });
    },
  );

  it.each(["entries", "generations", "statuses", "participants"] as const)(
    "reads selected %s beyond the native SQLite parameter limit",
    async (reader) => {
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("session-large-selection-")),
      };
      const knownKeys = ["agent:main:dashboard:z", "agent:main:dashboard:a"];
      for (const sessionKey of knownKeys) {
        const scope = { agentId: "main", env, sessionKey };
        await upsertSessionEntryCore(scope, {
          sessionId: sessionKey,
          updatedAt: 1,
          status: "done",
        });
        recordSessionParticipant(scope, { identity: { type: "agent", id: "participant" } });
      }
      const database = openOpenClawAgentDatabase({ agentId: "main", env });
      const compileOption = database.db
        .prepare("PRAGMA compile_options")
        .all()
        .find((row) => String(row.compile_options).startsWith("MAX_VARIABLE_NUMBER="));
      const variableLimit = Number(String(compileOption?.compile_options).split("=")[1]);
      expect(variableLimit).toBeGreaterThan(0);
      const read = (sessionKeys: string[]) => {
        const readers = {
          entries: () => Object.keys(readSessionEntryStore(database, { sessionKeys })),
          generations: () => readSessionGenerationIdsForKeys(database, sessionKeys),
          statuses: () =>
            readSessionEntriesByStatus(database, ["done"], sessionKeys).map(
              (row) => row.sessionKey,
            ),
          participants: () =>
            [
              ...projectSqliteSessionParticipantsBatch(
                database.db,
                new Map(sessionKeys.map((key) => [key, { sessionId: key, updatedAt: 1 }])),
              ),
            ].flatMap(([key, entry]) => (entry.participantCount === 1 ? [key] : [])),
        };
        return readers[reader]().toSorted();
      };
      const expected = knownKeys.toSorted();
      expect(read([])).toEqual([]);
      expect(read([...knownKeys, knownKeys[0]!])).toEqual(expected);
      expect(
        read([
          ...knownKeys,
          ...Array.from({ length: variableLimit + 1 }, (_, index) => `agent:main:absent-${index}`),
        ]),
      ).toEqual(expected);
    },
  );

  it.each(["committed", "declined", "cancelled", "revoked"] as const)(
    "records only committed owner facts before cancellation observers (%s)",
    async (mode) => {
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("session-commit-fact-")),
      };
      const scope = { agentId: "main", env, sessionKey: "agent:main:commit-fact" };
      const skillsSnapshot = {
        prompt: "Prepared session skills.",
        skills: [{ name: "existing", requiredEnv: ["EXISTING_ENV"] }],
      };
      await upsertSessionEntryCore(scope, {
        sessionId: "predecessor",
        updatedAt: 10,
        skillsSnapshot,
      });
      const controller = new AbortController();
      const cancelled = new Error("cancelled after identity publication");
      const revoked = new Error("writer revoked before commit");
      let commitAllowed = true;
      const facts: InternalSessionEntry[] = [];
      const observed: Array<{ acceptedId?: string; persistedId?: string }> = [];
      const unsubscribe = onSessionIdentityMutation((mutation) => {
        if (mutation.previous.sessionId !== "predecessor") {
          return;
        }
        observed.push({
          acceptedId: facts.at(-1)?.sessionId,
          persistedId: loadSessionEntry(scope)?.sessionId,
        });
        controller.abort(cancelled);
      });
      const clone = vi.spyOn(globalThis, "structuredClone");
      try {
        const options = {
          shouldCommit: () => commitAllowed,
          onCommitted: (entry: InternalSessionEntry) => {
            facts.push(entry);
          },
          assertCommitAllowed: () => {
            if (mode === "revoked") {
              throw revoked;
            }
          },
        };
        const pending = patchSessionEntryCore(
          scope,
          () => {
            if (mode === "cancelled") {
              queueMicrotask(() => {
                commitAllowed = false;
              });
            }
            return mode === "declined" ? null : { sessionId: "successor" };
          },
          options,
        );
        if (mode === "revoked") {
          await expect(pending).rejects.toBe(revoked);
        } else {
          const result = await pending;
          if (mode === "cancelled") {
            expect(result).toBeNull();
          }
        }
        if (mode === "committed") {
          expect(facts).toHaveLength(1);
          expect(observed).toEqual([{ acceptedId: "successor", persistedId: "successor" }]);
          expect(controller.signal.reason).toBe(cancelled);
          // Only caller inputs and retained outputs need copies; decoded identity rows are owned.
          expect(
            clone.mock.calls.filter(
              ([entry]) =>
                isRecord(entry) &&
                (entry.sessionId === "predecessor" || entry.sessionId === "successor"),
            ).length,
          ).toBeLessThanOrEqual(4);
          const retainedSkills = facts[0]?.skillsSnapshot?.skills;
          expect(retainedSkills).toEqual(skillsSnapshot.skills);
          retainedSkills?.push({ name: "observer-only" });
          expect((await pending)?.skillsSnapshot).toEqual(skillsSnapshot);
          expect(loadSessionEntry(scope)?.skillsSnapshot).toEqual(skillsSnapshot);
        } else {
          expect(facts).toEqual([]);
          expect(observed).toEqual([]);
          expect(loadSessionEntry(scope)?.sessionId).toBe("predecessor");
        }
      } finally {
        clone.mockRestore();
        unsubscribe();
      }
    },
  );

  it.each([
    { mode: "async", sandbox: "required", source: "profile" },
    { mode: "sync", sandbox: "required", source: "unknown" },
    { mode: "async", sandbox: undefined, source: "profile" },
    { mode: "sync", sandbox: undefined, source: "channel" },
  ] as const)(
    "protects $source provenance during $mode replacement (sandbox=$sandbox)",
    async ({ mode, sandbox, source }) => {
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("session-stamp-")),
      };
      const scope = { agentId: "main", env, sessionKey: "agent:main:stamp" };
      const stamp = {
        createdVia: "operator" as const,
        createdActor: { type: "human" as const, source, id: "profile-creator" },
        createdAt: 10,
        ...(sandbox ? { sandbox } : {}),
      };
      await upsertSessionEntryCore(scope, { sessionId: "original", updatedAt: 10, ...stamp });
      const replacement: InternalSessionEntry = {
        sessionId: "replacement",
        updatedAt: 20,
        createdVia: "plugin",
        createdActor: { type: "agent", id: "replacement-agent" },
        createdAt: 20,
      };
      if (mode === "async") {
        expect(
          await patchSessionEntryCore(scope, () => replacement, { replaceEntry: true }),
        ).toMatchObject(stamp);
      } else {
        const clone = vi.spyOn(globalThis, "structuredClone");
        try {
          replaceSessionEntrySync(scope, replacement);
          expect(
            clone.mock.calls.filter(
              ([entry]) =>
                isRecord(entry) &&
                (entry.sessionId === "original" || entry.sessionId === "replacement"),
            ),
          ).toHaveLength(0);
        } finally {
          clone.mockRestore();
        }
      }
      expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "replacement", ...stamp });
      const row = openOpenClawAgentDatabase({ agentId: "main", env })
        .db.prepare(
          "SELECT created_actor_type, created_actor_id, created_via, created_at, entry_json FROM session_nodes WHERE session_key = ?",
        )
        .get(scope.sessionKey) as {
        created_actor_type: string;
        created_actor_id: string;
        created_via: string;
        created_at: number;
        entry_json: string;
      };
      expect(row).toMatchObject({
        created_actor_type: "human",
        created_actor_id: "profile-creator",
        created_via: "operator",
        created_at: 10,
      });
      expect(JSON.parse(row.entry_json)).toMatchObject(stamp);
    },
  );

  it.each([false, true])(
    "keeps new required provenance with fallback (preserveActivity=%s)",
    async (preserveActivity) => {
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("session-stamp-fallback-")),
      };
      const scope = { agentId: "main", env, sessionKey: "agent:main:fallback" };
      const stamp = {
        createdVia: "operator" as const,
        createdActor: { type: "human" as const, source: "profile" as const, id: "profile-creator" },
        createdAt: 20,
        sandbox: "required" as const,
      };
      const result = await patchSessionEntryCore(scope, () => stamp, {
        fallbackEntry: { sessionId: "fallback", updatedAt: 10 },
        preserveActivity,
      });
      expect(result).toMatchObject({ sessionId: "fallback", ...stamp });
      expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "fallback", ...stamp });
    },
  );

  it("does not mint creator authority when replacing an unstamped node", async () => {
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("session-unstamped-")),
    };
    const scope = { agentId: "main", env, sessionKey: "agent:main:unstamped" };
    await upsertSessionEntryCore(scope, {
      sessionId: "original",
      updatedAt: 10,
      createdVia: "operator",
      label: "removed",
    });
    await patchSessionEntryCore(
      scope,
      () => ({
        sessionId: "replacement",
        updatedAt: 20,
        createdVia: "operator",
        createdActor: { type: "human", source: "profile", id: "new-profile" },
      }),
      { replaceEntry: true },
    );
    const persisted = loadSessionEntry(scope);
    expect(persisted).toMatchObject({ sessionId: "replacement", createdVia: "operator" });
    expect(persisted?.createdActor).toBeUndefined();
    expect(persisted).not.toHaveProperty("sandbox");
    expect(persisted).not.toHaveProperty("label");
  });

  it("persists private workspace intent but excludes runtime-only resolved skills from SQLite JSON", async () => {
    const stateDir = fs.realpathSync(tempDirs.make("openclaw-sqlite-session-skills-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionKey = "agent:main:runtime-skills";
    const resolvedSkills = [
      createCanonicalFixtureSkill({
        name: "demo",
        description: "runtime-only skill",
        filePath: "/skills/demo/SKILL.md",
        baseDir: "/skills/demo",
        source: "# Demo\n\n" + "runtime skill content ".repeat(100),
      }),
    ];
    const entry: InternalSessionEntry = {
      sessionId: "runtime-skills-session",
      updatedAt: 42,
      pendingProjectGitUrl: "https://github.com/openclaw/openclaw.git",
      pendingWorktree: {
        name: "session-startup",
        titleSource: "Start work",
      },
      skillsSnapshot: {
        prompt: "compact skill prompt",
        skills: [{ name: "demo" }],
        skillFilter: ["demo"],
        resolvedSkills,
        version: 7,
      },
    };

    await upsertSessionEntryCore({ agentId: "main", env, sessionKey }, entry);

    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const row = database.db
      .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
      .get(sessionKey) as { entry_json: string };
    const persisted = JSON.parse(row.entry_json) as InternalSessionEntry;
    for (const key of ["pendingProjectGitUrl", "pendingWorktree"] as const) {
      expect(persisted[key]).toEqual(entry[key]);
      expect(loadSessionEntry({ agentId: "main", env, sessionKey })?.[key]).toEqual(entry[key]);
      expect(projectPublicSessionEntry(entry)).not.toHaveProperty(key);
      expect(projectPublicSessionEntryPatch(entry)).not.toHaveProperty(key);
    }
    expect(persisted.skillsSnapshot).toEqual({
      prompt: "compact skill prompt",
      skills: [{ name: "demo" }],
      skillFilter: ["demo"],
      version: 7,
    });
    expect(entry.skillsSnapshot?.resolvedSkills).toBe(resolvedSkills);
  });
});
