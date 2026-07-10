import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  deleteSessionGroup,
  ensureSessionGroupRegistered,
  listSessionGroups,
  putSessionGroups,
  renameSessionGroup,
} from "./session-groups.js";

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
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seedSessionStore(entries: Record<string, unknown>): Promise<string> {
    const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(entries));
    return storePath;
  }

  it("replaces the ordered catalog with deduped trimmed names", () => {
    expect(listSessionGroups(env)).toEqual([]);
    const groups = putSessionGroups(["Work", "  Personal  ", "Work", ""], env);
    expect(groups).toEqual([
      { name: "Work", position: 0 },
      { name: "Personal", position: 1 },
    ]);
    expect(listSessionGroups(env)).toEqual(groups);
    expect(putSessionGroups(["Personal"], env)).toEqual([{ name: "Personal", position: 0 }]);
  });

  it("absorbs ad-hoc categories at the end of the catalog", () => {
    putSessionGroups(["Work"], env);
    ensureSessionGroupRegistered("Travel", env);
    ensureSessionGroupRegistered("Travel", env);
    expect(listSessionGroups(env)).toEqual([
      { name: "Work", position: 0 },
      { name: "Travel", position: 1 },
    ]);
  });

  it("renames a group and repoints member categories without bumping updatedAt", async () => {
    putSessionGroups(["Old", "Other"], env);
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

    const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      { category?: string; updatedAt: number }
    >;
    expect(store["agent:main:dashboard:a"].category).toBe("New");
    expect(store["agent:main:dashboard:a"].updatedAt).toBe(updatedAtA);
    expect(store["agent:main:dashboard:b"].category).toBe("Other");
  });

  it("deletes a group and clears member categories", async () => {
    putSessionGroups(["Gone"], env);
    const storePath = await seedSessionStore({
      "agent:main:dashboard:a": { sessionId: "a1", updatedAt: Date.now(), category: "Gone" },
    });

    const result = await deleteSessionGroup({ cfg, name: "Gone", env });
    expect(result.updatedSessions).toBe(1);
    expect(result.groups).toEqual([]);

    const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      { category?: string }
    >;
    expect(store["agent:main:dashboard:a"].category).toBeUndefined();
  });

  it("merges a rename into an existing target group", async () => {
    putSessionGroups(["A", "B"], env);
    await seedSessionStore({
      "agent:main:dashboard:a": { sessionId: "a1", updatedAt: Date.now(), category: "A" },
    });
    const result = await renameSessionGroup({ cfg, name: "A", to: "B", env });
    expect(result.groups).toEqual([{ name: "B", position: 1 }]);
    expect(result.updatedSessions).toBe(1);
  });
});
