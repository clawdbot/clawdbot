import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listMemorySessionTombstones } from "./memory-entry-origins.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  createMemoryForgetFixture,
  closeMemoryForgetFixture,
  seedMemoryForgetSession,
} from "./memory-forget.test-helpers.js";

describe("memory forget participant selectors", () => {
  let stateDir: string;
  let workspaceDir: string;
  let cfg: OpenClawConfig;

  beforeEach(async () => {
    stateDir = tempDirs.make("openclaw-memory-forget-");
    ({ workspaceDir, cfg } = await createMemoryForgetFixture(stateDir));
  });

  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      closeMemoryForgetFixture();
      cleanup();
    }),
  );

  it("reports raw participant collisions across namespaces without changing state in dry-run", async () => {
    for (const sessionId of ["profile-match", "agent-match", "unrelated"]) {
      await upsertSessionEntry({
        agentId: "main",
        sessionKey: `agent:main:${sessionId}`,
        entry: { sessionId, updatedAt: Date.now() },
      });
    }
    const database = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const insert = database.prepare(`INSERT INTO session_participants
      (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at, last_prompted_at)
      VALUES (?, ?, ?, 1, 1, 1)`);
    insert.run("agent:main:profile-match", '{"type":"profile"}', "same-id");
    insert.run("agent:main:agent-match", '{"type":"agent"}', "same-id");
    const remoteIdentities = [
      { type: "remote", pluginId: "test", domain: "workspace-a", idKind: "user", id: "same-id" },
      { type: "remote", pluginId: "test", domain: "workspace-b", idKind: "user", id: "same-id" },
      { type: "remote", pluginId: "test", domain: "workspace-a", idKind: "bot", id: "same-id" },
    ];
    for (const { id, ...namespace } of remoteIdentities) {
      insert.run("agent:main:profile-match", JSON.stringify(namespace), id);
    }
    insert.run("agent:main:unrelated", '{"type":"profile"}', "other-id");
    const before = database
      .prepare("SELECT * FROM session_participants ORDER BY session_key")
      .all();
    const memory = "# Memory\nKeep this fixture.\n";
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memory);
    const report = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      participants: ["same-id"],
      dryRun: true,
    });
    expect(report.sessionIds).toEqual(["agent-match", "profile-match"]);
    expect(report.participantMatches).toEqual([
      {
        actorId: "same-id",
        identities: expect.arrayContaining([
          { type: "profile", id: "same-id" },
          { type: "agent", id: "same-id" },
          ...remoteIdentities,
        ]),
      },
    ]);
    expect(report.participantMatches[0]?.identities).toHaveLength(5);
    expect(
      database.prepare("SELECT * FROM session_participants ORDER BY session_key").all(),
    ).toEqual(before);
    expect(listMemorySessionTombstones({ agentId: "main" })).toEqual([]);
    expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).toBe(memory);
  });

  it("does not infer hook or participant facts for an archived-only session", async () => {
    await seedMemoryForgetSession("archived", "gmail");
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    db.prepare(
      `INSERT INTO session_participants
         (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at, last_prompted_at)
       VALUES (?, '{"type":"profile"}', 'participant', 1, 1, 1)`,
    ).run("agent:main:archived");
    expect(
      (
        await forgetMemoryEntries({
          cfg,
          agentId: "main",
          participants: ["participant"],
          dryRun: true,
        })
      ).sessionIds,
    ).toEqual(["archived"]);
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId: "archived",
      sessionKey: "agent:main:archived",
      message: { role: "user", content: "Archive this session." },
    });
    await deleteSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:archived",
      expectedSessionId: "archived",
      archiveTranscript: true,
    });

    for (const selectors of [{ hookSources: ["gmail"] }, { participants: ["participant"] }]) {
      const report = await forgetMemoryEntries({ cfg, agentId: "main", ...selectors });
      expect(report.sessionIds).toEqual([]);
      expect(report.sessionResolutions).toEqual([]);
    }
    expect(listMemorySessionTombstones({ agentId: "main" })).toEqual([]);
  });
});
