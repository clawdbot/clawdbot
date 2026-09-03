import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  deleteSessionGroup,
  ensureSessionGroupRegistered,
  listSessionGroupDefaults,
  listSidebarSectionOrder,
  listSessionGroups,
  putSessionGroups,
  renameSessionGroup,
  SessionGroupNotEmptyError,
  updateSessionGroupDefaults,
} from "./session-groups.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";

describe("session groups catalog", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  const cfg = {} as OpenClawConfig;

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(tempRoot, "openclaw-session-groups-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: root };
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seedSessionStore(entries: Record<string, SessionEntry>): Promise<string> {
    const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
    for (const [sessionKey, entry] of Object.entries(entries)) {
      await replaceSessionEntry({ agentId: "main", storePath, sessionKey }, entry);
    }
    return storePath;
  }

  it("replaces the ordered catalog with deduped trimmed names", () => {
    expect(listSessionGroups(env)).toEqual([]);
    const groups = putSessionGroups({ cfg, names: ["Work", "  Personal  ", "Work", ""], env });
    expect(groups).toEqual([
      { name: "Work", position: 0 },
      { name: "Personal", position: 1 },
    ]);
    expect(listSessionGroups(env)).toEqual(groups);
    expect(putSessionGroups({ cfg, names: ["Personal"], env })).toEqual([
      { name: "Personal", position: 0 },
    ]);
  });

  it("rejects dropping a group that still has member sessions", async () => {
    const groups = putSessionGroups({ cfg, names: ["Keep", "Gone"], env });
    const sessionKey = "agent:main:dashboard:a";
    const storePath = await seedSessionStore({
      [sessionKey]: { sessionId: "a1", updatedAt: Date.now(), category: "Gone" },
    });
    const sessionTarget = { agentId: "main", storePath, sessionKey };

    expect(() => putSessionGroups({ cfg, names: ["Keep"], env })).toThrow(
      SessionGroupNotEmptyError,
    );
    expect(() => putSessionGroups({ cfg, names: ["Keep"], env })).toThrow('"Gone" (1)');
    expect(listSessionGroups(env)).toEqual(groups);
    expect(loadSessionEntry(sessionTarget)?.category).toBe("Gone");

    await deleteSessionGroup({ cfg, name: "Gone", env });
    expect(loadSessionEntry(sessionTarget)?.category).toBeUndefined();
    expect(putSessionGroups({ cfg, names: ["Keep"], env })).toEqual([
      { name: "Keep", position: 0 },
    ]);
  });

  it("propagates changed member authorization before reporting a non-empty drop", async () => {
    const groups = putSessionGroups({ cfg, names: ["Keep", "Gone"], env });
    const sessionKey = "agent:main:dashboard:changed-member";
    const storePath = await seedSessionStore({
      [sessionKey]: { sessionId: "changed-member", updatedAt: Date.now(), category: "Gone" },
    });
    const error = new SessionMutationAuthorizationChangedError({
      code: "INVALID_REQUEST",
      message: "session changed before sessions.groups.put; retry the request",
    });
    const assertTargetCurrent = vi.fn(() => {
      throw error;
    });

    expect(() => putSessionGroups({ cfg, names: ["Keep"], env, assertTargetCurrent })).toThrow(
      error,
    );
    expect(assertTargetCurrent).toHaveBeenCalledExactlyOnceWith({ agentId: "main", sessionKey });
    expect(listSessionGroups(env)).toEqual(groups);
    expect(loadSessionEntry({ agentId: "main", storePath, sessionKey })?.category).toBe("Gone");
  });

  it("roundtrips normalized sidebar order, including catalog section ids", () => {
    putSessionGroups({
      cfg,
      names: ["Alpha", " Beta ", "Alpha"],
      sectionOrder: [
        " work ",
        " catalog: codex ",
        "category:Beta",
        "category:Missing",
        "category: Alpha ",
        "groups",
        "groups",
        "catalog:",
        "catalog:codex",
        "pinned",
        "",
      ],
      env,
    });
    expect(listSessionGroups(env).map((group) => group.name)).toEqual(["Alpha", "Beta"]);
    const expectedSectionOrder = [
      "work",
      "catalog:codex",
      "category:Beta",
      "category:Alpha",
      "groups",
    ];
    expect(listSidebarSectionOrder(env)).toEqual(expectedSectionOrder);
    expect(readConfigMachineState("sidebar.sectionOrder", { env })).toEqual(expectedSectionOrder);

    putSessionGroups({ cfg, names: ["Beta", "Alpha"], env });
    expect(listSidebarSectionOrder(env)).toEqual(expectedSectionOrder);
  });

  it("keeps catalog reads and reorders schema-read-only until defaults are used", async () => {
    const databasePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("ALTER TABLE session_groups DROP COLUMN cwd;");
    legacy.exec("ALTER TABLE session_groups DROP COLUMN worktree;");
    legacy
      .prepare("INSERT INTO session_groups (name, position, created_at) VALUES (?, ?, ?)")
      .run("Client", 0, Date.now());
    legacy.close();

    const beforeFeatureUse = openOpenClawStateDatabase({ env })
      .db.prepare("PRAGMA table_info(session_groups)")
      .all() as Array<{ name: string }>;
    expect(beforeFeatureUse.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(["cwd", "worktree"]),
    );

    expect(listSessionGroups(env)).toEqual([{ name: "Client", position: 0 }]);
    expect(putSessionGroups({ cfg, names: ["Client"], env })).toEqual([
      { name: "Client", position: 0 },
    ]);
    const afterCatalogUse = openOpenClawStateDatabase({ env })
      .db.prepare("PRAGMA table_info(session_groups)")
      .all() as Array<{ name: string }>;
    expect(afterCatalogUse.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(["cwd", "worktree"]),
    );

    expect(listSessionGroupDefaults(env)).toEqual([{ name: "Client" }]);
    await renameSessionGroup({ cfg, name: "Client", to: "Customer", env });
    expect(listSessionGroupDefaults(env)).toEqual([{ name: "Customer" }]);
    const afterDefaultsReadAndRename = openOpenClawStateDatabase({ env })
      .db.prepare("PRAGMA table_info(session_groups)")
      .all() as Array<{ dflt_value: unknown; name: string; notnull: number; type: string }>;
    expect(afterDefaultsReadAndRename.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(["cwd", "worktree"]),
    );
    expect(
      updateSessionGroupDefaults("Customer", { cwd: "/repos/customer", worktree: true }, env),
    ).toContainEqual({ name: "Customer", cwd: "/repos/customer", worktree: true });
    const columns = openOpenClawStateDatabase({ env })
      .db.prepare("PRAGMA table_info(session_groups)")
      .all() as Array<{ dflt_value: unknown; name: string; notnull: number; type: string }>;
    expect(columns.filter((column) => column.name === "cwd" || column.name === "worktree")).toEqual(
      [
        expect.objectContaining({ dflt_value: null, name: "cwd", notnull: 0, type: "TEXT" }),
        expect.objectContaining({
          dflt_value: null,
          name: "worktree",
          notnull: 0,
          type: "INTEGER",
        }),
      ],
    );
  });

  it("preserves New Session defaults through reorder and rename", async () => {
    putSessionGroups({ cfg, names: ["Client", "Other"], env });
    expect(
      updateSessionGroupDefaults("Client", { cwd: "/repos/client", worktree: true }, env),
    ).toContainEqual({
      name: "Client",
      cwd: "/repos/client",
      worktree: true,
    });

    putSessionGroups({ cfg, names: ["Other", "Client"], env });
    await renameSessionGroup({ cfg, name: "Client", to: "Customer", env });
    expect(listSessionGroupDefaults(env)).toContainEqual({
      name: "Customer",
      cwd: "/repos/client",
      worktree: true,
    });
  });

  it("rejects renaming an unknown group after defaults schema activation", async () => {
    putSessionGroups({ cfg, names: ["Client"], env });
    updateSessionGroupDefaults("Client", { cwd: "/repos/client", worktree: true }, env);

    await expect(renameSessionGroup({ cfg, name: "Missing", to: "Other", env })).rejects.toThrow(
      "unknown session group: Missing",
    );
    expect(listSessionGroups(env)).toEqual([{ name: "Client", position: 0 }]);
    expect(listSessionGroupDefaults(env)).toEqual([
      { name: "Client", cwd: "/repos/client", worktree: true },
    ]);
  });

  it("clears New Session defaults without removing the group", () => {
    putSessionGroups({ cfg, names: ["Client"], env });
    updateSessionGroupDefaults("Client", { cwd: "/repos/client", worktree: true }, env);

    expect(updateSessionGroupDefaults("Client", { cwd: null, worktree: false }, env)).toEqual([
      { name: "Client", worktree: false },
    ]);
  });

  it("does not recreate a deleted group from a stale defaults update", async () => {
    putSessionGroups({ cfg, names: ["Client"], env });
    await deleteSessionGroup({ cfg, name: "Client", env });

    expect(
      updateSessionGroupDefaults("Client", { cwd: "/repos/client", worktree: true }, env),
    ).toBeNull();
    expect(listSessionGroups(env)).toEqual([]);
  });

  it("keeps a stale defaults update schema-free on a legacy database", () => {
    const databasePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("ALTER TABLE session_groups DROP COLUMN cwd;");
    legacy.exec("ALTER TABLE session_groups DROP COLUMN worktree;");
    legacy.close();

    expect(
      updateSessionGroupDefaults("Missing", { cwd: "/repos/missing", worktree: true }, env),
    ).toBeNull();
    const columns = openOpenClawStateDatabase({ env })
      .db.prepare("PRAGMA table_info(session_groups)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(["cwd", "worktree"]),
    );
  });

  it("absorbs ad-hoc categories at the end of the catalog", () => {
    putSessionGroups({ cfg, names: ["Work"], env });
    ensureSessionGroupRegistered("Travel", env);
    ensureSessionGroupRegistered("Travel", env);
    expect(listSessionGroups(env)).toEqual([
      { name: "Work", position: 0 },
      { name: "Travel", position: 1 },
    ]);
  });

  it("renames a group and repoints member categories without bumping updatedAt", async () => {
    putSessionGroups({
      cfg,
      names: ["Old", "Other"],
      sectionOrder: ["ungrouped", "category:Old", "work", "category:Other"],
      env,
    });
    // Store saves run maintenance pruning; stale timestamps would be dropped.
    const updatedAtA = Date.now() - 1_000;
    const updatedAtB = Date.now() - 2_000;
    const storePath = await seedSessionStore({
      "agent:main:dashboard:a": { sessionId: "a1", updatedAt: updatedAtA, category: "Old" },
      "agent:main:dashboard:b": { sessionId: "b1", updatedAt: updatedAtB, category: "Other" },
    });

    const result = await renameSessionGroup({ cfg, name: "Old", to: "New", env });
    expect(result.updatedSessions).toBe(1);
    expect(result.groups.map((group) => group.name)).toEqual(["New", "Other"]);
    expect(result.sectionOrder).toEqual(["ungrouped", "category:New", "work", "category:Other"]);

    const sessionA = loadSessionEntry({
      agentId: "main",
      storePath,
      sessionKey: "agent:main:dashboard:a",
    });
    const sessionB = loadSessionEntry({
      agentId: "main",
      storePath,
      sessionKey: "agent:main:dashboard:b",
    });
    expect(sessionA?.category).toBe("New");
    expect(sessionA?.updatedAt).toBe(updatedAtA);
    expect(sessionB?.category).toBe("Other");
  });

  it("deletes a group and clears member categories", async () => {
    putSessionGroups({
      cfg,
      names: ["Gone"],
      sectionOrder: ["category:Gone", "ungrouped", "work"],
      env,
    });
    const storePath = await seedSessionStore({
      "agent:main:dashboard:a": { sessionId: "a1", updatedAt: Date.now(), category: "Gone" },
    });

    const result = await deleteSessionGroup({ cfg, name: "Gone", env });
    expect(result.updatedSessions).toBe(1);
    expect(result.groups).toEqual([]);
    expect(result.sectionOrder).toEqual(["ungrouped", "work"]);

    expect(
      loadSessionEntry({
        agentId: "main",
        storePath,
        sessionKey: "agent:main:dashboard:a",
      })?.category,
    ).toBeUndefined();
  });

  it("merges a rename into an existing target group", async () => {
    putSessionGroups({
      cfg,
      names: ["A", "B"],
      sectionOrder: ["category:A", "ungrouped", "category:B"],
      env,
    });
    await seedSessionStore({
      "agent:main:dashboard:a": { sessionId: "a1", updatedAt: Date.now(), category: "A" },
    });
    const result = await renameSessionGroup({ cfg, name: "A", to: "B", env });
    expect(result.groups).toEqual([{ name: "B", position: 1 }]);
    expect(result.sectionOrder).toEqual(["ungrouped", "category:B"]);
    expect(result.updatedSessions).toBe(1);
  });

  it("keeps the source sidebar slot when the merge target has no stored slot", async () => {
    putSessionGroups({ cfg, names: ["A", "B"], sectionOrder: ["category:A", "work"], env });

    const result = await renameSessionGroup({ cfg, name: "A", to: "B", env });

    expect(result.groups).toEqual([{ name: "B", position: 1 }]);
    expect(result.sectionOrder).toEqual(["category:B", "work"]);
  });
});
