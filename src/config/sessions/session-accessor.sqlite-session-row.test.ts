import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { loadSessionEntry, upsertSessionEntryCore } from "./session-accessor.js";
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
  it("persists pending remote projects but excludes runtime-only resolved skills from SQLite JSON", async () => {
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
    expect(persisted.pendingProjectGitUrl).toBe("https://github.com/openclaw/openclaw.git");
    expect(loadSessionEntry({ agentId: "main", env, sessionKey })?.pendingProjectGitUrl).toBe(
      entry.pendingProjectGitUrl,
    );
    expect(projectPublicSessionEntry(entry)).not.toHaveProperty("pendingProjectGitUrl");
    expect(projectPublicSessionEntryPatch(entry)).not.toHaveProperty("pendingProjectGitUrl");
    expect(persisted.skillsSnapshot).toEqual({
      prompt: "compact skill prompt",
      skills: [{ name: "demo" }],
      skillFilter: ["demo"],
      version: 7,
    });
    expect(entry.skillsSnapshot?.resolvedSkills).toBe(resolvedSkills);
  });
});
