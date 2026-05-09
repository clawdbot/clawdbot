import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { migrateOrphanedSessionKeys } from "./state-migrations.js";

function writeStore(storePath: string, store: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store));
}

function readStore(storePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(storePath, "utf-8"));
}

function requireStoreEntry(
  store: Record<string, unknown>,
  key: string,
): { sessionId: string; updatedAt?: number } {
  const entry = store[key] as { sessionId?: unknown; updatedAt?: number } | undefined;
  if (!entry || typeof entry.sessionId !== "string") {
    throw new Error(`expected session store entry ${key}`);
  }
  return { sessionId: entry.sessionId, updatedAt: entry.updatedAt };
}

async function withStateFixture(
  run: (params: { tmpDir: string; stateDir: string }) => Promise<void>,
): Promise<void> {
  await withTempDir({ prefix: "orphan-keys-test-" }, async (tmpDir) => {
    const stateDir = path.join(tmpDir, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    await run({ tmpDir, stateDir });
  });
}

const OPS_WORK_CONFIG = {
  session: { mainKey: "work" },
  agents: { list: [{ id: "ops", default: true }] },
} as OpenClawConfig;

function opsSessionStorePath(stateDir: string): string {
  return path.join(stateDir, "agents", "ops", "sessions", "sessions.json");
}

function sharedMainOpsConfig(sharedStorePath: string): OpenClawConfig {
  return {
    session: { mainKey: "work", store: sharedStorePath },
    agents: { list: [{ id: "main" }, { id: "ops", default: true }] },
  } as OpenClawConfig;
}

async function migrateFixtureState(stateDir: string, cfg: OpenClawConfig = OPS_WORK_CONFIG) {
  return migrateOrphanedSessionKeys({
    cfg,
    env: { OPENCLAW_STATE_DIR: stateDir },
  });
}

describe("migrateOrphanedSessionKeys", () => {
  it("renames orphaned raw key to canonical form", async () => {
    await withStateFixture(async ({ stateDir }) => {
      const storePath = opsSessionStorePath(stateDir);
      writeStore(storePath, {
        "agent:main:main": { sessionId: "abc-123", updatedAt: 1000 },
      });

      const result = await migrateFixtureState(stateDir);

      expect(result.changes.length).toBeGreaterThan(0);
      const store = readStore(storePath);
      expect(requireStoreEntry(store, "agent:ops:work").sessionId).toBe("abc-123");
      expect(store["agent:main:main"]).toBeUndefined();
    });
  });

  it("keeps most recently updated entry when both orphan and canonical exist", async () => {
    await withStateFixture(async ({ stateDir }) => {
      const storePath = opsSessionStorePath(stateDir);
      writeStore(storePath, {
        "agent:main:main": { sessionId: "old-orphan", updatedAt: 500 },
        "agent:ops:work": { sessionId: "current", updatedAt: 2000 },
      });

      await migrateFixtureState(stateDir);

      const store = readStore(storePath);
      expect((store["agent:ops:work"] as { sessionId: string }).sessionId).toBe("current");
      expect(store["agent:main:main"]).toBeUndefined();
    });
  });

  it("skips stores that are already fully canonical", async () => {
    await withStateFixture(async ({ stateDir }) => {
      const storePath = opsSessionStorePath(stateDir);
      writeStore(storePath, {
        "agent:ops:work": { sessionId: "abc-123", updatedAt: 1000 },
      });

      const result = await migrateFixtureState(stateDir);

      expect(result.changes).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });

  it("handles missing store files gracefully", async () => {
    await withStateFixture(async ({ stateDir }) => {
      const result = await migrateFixtureState(stateDir);

      expect(result.changes).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });

  it("is idempotent — running twice produces same result", async () => {
    await withStateFixture(async ({ stateDir }) => {
      const storePath = opsSessionStorePath(stateDir);
      writeStore(storePath, {
        "agent:main:main": { sessionId: "abc-123", updatedAt: 1000 },
      });

      const env = { OPENCLAW_STATE_DIR: stateDir };
      await migrateOrphanedSessionKeys({ cfg: OPS_WORK_CONFIG, env });
      const result2 = await migrateOrphanedSessionKeys({ cfg: OPS_WORK_CONFIG, env });

      expect(result2.changes).toHaveLength(0);
      const store = readStore(storePath);
      expect((store["agent:ops:work"] as { sessionId: string }).sessionId).toBe("abc-123");
    });
  });

  it("preserves legitimate agent:main:* keys in shared stores with both main and non-main agents", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      // When session.store lacks {agentId}, all agents resolve to the same file.
      // The "main" agent's keys must not be remapped into the "ops" namespace.
      const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
      writeStore(sharedStorePath, {
        "agent:main:main": { sessionId: "main-session", updatedAt: 2000 },
        "agent:ops:work": { sessionId: "ops-session", updatedAt: 1000 },
      });

      await migrateFixtureState(stateDir, sharedMainOpsConfig(sharedStorePath));

      const store = readStore(sharedStorePath);
      // main agent's session is canonicalised to use configured mainKey ("work"),
      // but stays in the "main" agent namespace — NOT remapped into "ops".
      expect(requireStoreEntry(store, "agent:main:work").sessionId).toBe("main-session");
      expect(requireStoreEntry(store, "agent:ops:work").sessionId).toBe("ops-session");
      // The key must NOT have been merged into ops namespace
      expect(
        Object.keys(store).reduce((count, k) => count + (k.startsWith("agent:ops:") ? 1 : 0), 0),
      ).toBe(1);
    });
  });

  it("lets the main agent claim bare main aliases in shared stores", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
      writeStore(sharedStorePath, {
        main: { sessionId: "main-session", updatedAt: 2000 },
        "agent:ops:work": { sessionId: "ops-session", updatedAt: 1000 },
      });

      await migrateFixtureState(stateDir, sharedMainOpsConfig(sharedStorePath));

      const store = readStore(sharedStorePath);
      expect(requireStoreEntry(store, "agent:main:work").sessionId).toBe("main-session");
      expect(store.main).toBeUndefined();
      expect(requireStoreEntry(store, "agent:ops:work").sessionId).toBe("ops-session");
    });
  });

  it("no-ops when default agentId is main and mainKey is main", async () => {
    await withStateFixture(async ({ stateDir }) => {
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      writeStore(storePath, {
        "agent:main:main": { sessionId: "abc-123", updatedAt: 1000 },
      });

      const cfg = {} as OpenClawConfig;

      const result = await migrateOrphanedSessionKeys({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
      });

      expect(result.changes).toHaveLength(0);
      const store = readStore(storePath);
      expect(requireStoreEntry(store, "agent:main:main").sessionId).toBe("abc-123");
    });
  });
});
