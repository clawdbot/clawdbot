import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveStorePath } from "../../../config/sessions/paths.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import { closeOpenClawAgentDatabaseByPath } from "../../../state/openclaw-agent-db.js";
import { maybeMigrateLegacyDefaultMainSessionKeys } from "./legacy-main-session-keys.js";

const roots: string[] = [];
const openDatabases: string[] = [];

afterEach(() => {
  for (const databasePath of openDatabases.splice(0)) {
    closeOpenClawAgentDatabaseByPath(databasePath);
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("legacy non-main default session key migration", () => {
  it("rewrites a historical main key inside the default agent store", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-main-key-migration-"));
    roots.push(root);
    const env = { HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const cfg = {
      agents: {
        list: [{ id: "ops", default: true }, { id: "main" }],
      },
    };
    const storePath = resolveStorePath(undefined, { agentId: "ops", env });
    openDatabases.push(resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "ops" }).path);
    await replaceSessionEntry(
      { agentId: "ops", storePath, sessionKey: "agent:main:main" },
      { sessionId: "legacy", updatedAt: 10 },
    );
    expect(fs.existsSync(openDatabases.at(-1)!)).toBe(true);
    expect(loadSessionEntry({ agentId: "ops", storePath, sessionKey: "agent:main:main" })).toEqual(
      expect.objectContaining({ sessionId: "legacy" }),
    );

    const first = await maybeMigrateLegacyDefaultMainSessionKeys(cfg, env);
    expect(first).toEqual({
      changes: ["Migrated legacy main-session key to agent:ops:main."],
      warnings: [],
    });
    expect(loadSessionEntry({ agentId: "ops", storePath, sessionKey: "agent:ops:main" })).toEqual(
      expect.objectContaining({ sessionId: "legacy" }),
    );
    expect(
      loadSessionEntry({ agentId: "ops", storePath, sessionKey: "agent:main:main" }),
    ).toBeUndefined();
    expect(await maybeMigrateLegacyDefaultMainSessionKeys(cfg, env)).toEqual({
      changes: [],
      warnings: [],
    });
  });

  it("rewrites a historical main key in an agent-namespaced fixed JSON store", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-main-key-fixed-"));
    roots.push(root);
    const env = { HOME: root };
    const storePath = path.join(root, "sessions.json");
    const cfg = {
      agents: { list: [{ id: "ops", default: true }] },
      session: { store: storePath },
    };
    openDatabases.push(resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "ops" }).path);
    await replaceSessionEntry(
      { agentId: "ops", storePath, sessionKey: "agent:main:main" },
      { sessionId: "legacy-fixed", updatedAt: 10 },
    );
    expect(loadSessionEntry({ agentId: "ops", storePath, sessionKey: "agent:main:main" })).toEqual(
      expect.objectContaining({ sessionId: "legacy-fixed" }),
    );

    expect(await maybeMigrateLegacyDefaultMainSessionKeys(cfg, env)).toEqual({
      changes: ["Migrated legacy main-session key to agent:ops:main."],
      warnings: [],
    });
    expect(loadSessionEntry({ agentId: "ops", storePath, sessionKey: "agent:ops:main" })).toEqual(
      expect.objectContaining({ sessionId: "legacy-fixed" }),
    );
  });

  it("does not infer ownership in a fixed shared store", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-main-key-shared-"));
    roots.push(root);
    const storePath = path.join(root, "sessions.sqlite");
    openDatabases.push(storePath);
    await replaceSessionEntry(
      { agentId: "ops", storePath, sessionKey: "agent:main:main" },
      { sessionId: "ambiguous", updatedAt: 10 },
    );
    const result = await maybeMigrateLegacyDefaultMainSessionKeys(
      {
        agents: { list: [{ id: "ops", default: true }] },
        session: { store: storePath },
      },
      { HOME: root },
    );
    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it("does not warn for an unused fixed shared store", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-main-key-empty-shared-"));
    roots.push(root);
    await expect(
      maybeMigrateLegacyDefaultMainSessionKeys(
        {
          agents: { list: [{ id: "ops", default: true }] },
          session: { store: path.join(root, "sessions.sqlite") },
        },
        { HOME: root },
      ),
    ).resolves.toEqual({ changes: [], warnings: [] });
  });

  it("requires one explicit default before assigning legacy ownership", async () => {
    await expect(
      maybeMigrateLegacyDefaultMainSessionKeys({
        agents: { list: [{ id: "ops" }, { id: "work" }] },
      }),
    ).resolves.toEqual({
      changes: [],
      warnings: [
        "Skipped legacy main-session key migration because the roster has no unique explicit default.",
      ],
    });
  });
});
