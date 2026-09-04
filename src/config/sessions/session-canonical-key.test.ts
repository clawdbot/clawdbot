import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { loadSessionEntryReadOnly, upsertSessionEntryCore } from "./session-accessor.js";
import { scanDoctorSessionEntriesStrict } from "./session-accessor.sqlite-canonical-inventory.js";
import type { SessionEntry } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function createScope() {
  const stateDir = tempDirs.make("openclaw-cold-session-keys-");
  return {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    storePath: path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite"),
    sessionKey: "agent:main:cold-key",
  };
}

describe("cold canonical session validation", () => {
  it("omits saved prompts before decoding keys but retains them for Doctor", async () => {
    const scope = createScope();
    const prompt = "synthetic saved prompt ".repeat(8192);
    await upsertSessionEntryCore(scope, { sessionId: "cold-key", updatedAt: 1 });
    await upsertSessionEntryCore(
      { ...scope, sessionKey: "agent:main:unrelated" },
      { sessionId: "unrelated", updatedAt: 2, skillsSnapshot: { prompt, skills: [] } },
    );
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe("cold-key");
      expect(parse.mock.calls.filter(([value]) => value.includes(prompt))).toHaveLength(0);
    } finally {
      parse.mockRestore();
    }

    const entries: SessionEntry[] = [];
    expect(scanDoctorSessionEntriesStrict(scope, ({ entry }) => entries.push(entry))).toBe(2);
    expect(entries.find((entry) => entry.sessionId === "unrelated")?.skillsSnapshot?.prompt).toBe(
      prompt,
    );
  });

  it("still rejects divergent lineage on the first read", async () => {
    const scope = createScope();
    await upsertSessionEntryCore(scope, {
      sessionId: "cold-key",
      updatedAt: 1,
      parentSessionKey: "agent:main:parent",
      skillsSnapshot: { prompt: "synthetic saved prompt", skills: [] },
    });
    const database = openOpenClawAgentDatabase({ ...scope, path: scope.storePath });
    database.db
      .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
      .run("agent:main:different", scope.sessionKey);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    expect(() => loadSessionEntryReadOnly(scope)).toThrow("openclaw doctor --fix");
  });
});
