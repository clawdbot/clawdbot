import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
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
  it.each(["async", "sync"] as const)(
    "protects required provenance during %s replacement",
    async (mode) => {
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: fs.realpathSync(tempDirs.make("session-stamp-")),
      };
      const scope = { agentId: "main", env, sessionKey: "agent:main:stamp" };
      const stamp = {
        createdVia: "operator" as const,
        createdActor: { type: "human" as const, id: "profile-creator" },
        createdAt: 10,
        sandbox: "required" as const,
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
        replaceSessionEntrySync(scope, replacement);
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
        createdActor: { type: "human" as const, id: "profile-creator" },
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

  it("keeps unstamped replacement semantics unchanged", async () => {
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
      () => ({ sessionId: "replacement", updatedAt: 20, createdVia: "plugin" }),
      { replaceEntry: true },
    );
    const persisted = loadSessionEntry(scope);
    expect(persisted).toMatchObject({ sessionId: "replacement", createdVia: "plugin" });
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
