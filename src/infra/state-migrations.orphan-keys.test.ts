// Tests migration cleanup for orphaned state keys.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore } from "../config/sessions/store.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  migrateOrphanedSessionKeys,
  sessionStoreTextMayNeedCanonicalization,
} from "./state-migrations.js";

function writeStore(storePath: string, store: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store));
}

function readStore(storePath: string): Record<string, unknown> {
  return loadSessionStore(storePath, { skipCache: true }) as Record<string, unknown>;
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
  it("recognizes canonical stores without parsing them for migration", () => {
    const raw = JSON.stringify({
      "agent:main:discord:channel:123": { sessionId: "channel", updatedAt: 1 },
      "agent:main:subagent:child": { sessionId: "child", updatedAt: 2 },
      global: { sessionId: "global", updatedAt: 3 },
    });

    expect(
      sessionStoreTextMayNeedCanonicalization({
        raw,
        storeAgentIds: ["main"],
        mainKey: "main",
      }),
    ).toBe(false);
  });

  it("keeps migration candidates on the full parser path", () => {
    expect(
      sessionStoreTextMayNeedCanonicalization({
        raw: JSON.stringify({
          "agent:main:main": { sessionId: "orphan", updatedAt: 1 },
        }),
        storeAgentIds: ["ops"],
        mainKey: "work",
      }),
    ).toBe(true);
    expect(
      sessionStoreTextMayNeedCanonicalization({
        raw: JSON.stringify({
          main: { sessionId: "legacy-main", updatedAt: 1 },
        }),
        storeAgentIds: ["main"],
        mainKey: "work",
      }),
    ).toBe(true);
    expect(
      sessionStoreTextMayNeedCanonicalization({
        raw: "{unquoted: {sessionId: 'legacy', updatedAt: 1}}",
        storeAgentIds: ["main"],
        mainKey: "main",
      }),
    ).toBe(true);
    expect(
      sessionStoreTextMayNeedCanonicalization({
        raw: JSON.stringify({
          "agent:ops:main": { sessionId: "old-main-alias", updatedAt: 1 },
        }),
        storeAgentIds: ["ops"],
        mainKey: "work",
      }),
    ).toBe(true);
    expect(
      sessionStoreTextMayNeedCanonicalization({
        raw: JSON.stringify({
          "agent:main:main": { sessionId: "global-main-alias", updatedAt: 1 },
        }),
        storeAgentIds: ["main"],
        mainKey: "main",
        scope: "global",
      }),
    ).toBe(true);
    expect(
      sessionStoreTextMayNeedCanonicalization({
        raw: JSON.stringify({
          "agent:ops:work ": { sessionId: "padded-key", updatedAt: 1 },
        }),
        storeAgentIds: ["ops"],
        mainKey: "work",
      }),
    ).toBe(true);
    expect(
      sessionStoreTextMayNeedCanonicalization({
        raw: '{"agent:\\u006f\\u0070\\u0073:\\u006d\\u0061\\u0069\\u006e":{"sessionId":"escaped","updatedAt":1}}',
        storeAgentIds: ["ops"],
        mainKey: "work",
      }),
    ).toBe(true);
  });

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
      expect(fs.existsSync(storePath)).toBe(false);
    });
  });

  it("renames same-agent main aliases when mainKey changes", async () => {
    await withStateFixture(async ({ stateDir }) => {
      const storePath = opsSessionStorePath(stateDir);
      writeStore(storePath, {
        "agent:ops:main": { sessionId: "abc-123", updatedAt: 1000 },
      });

      const result = await migrateFixtureState(stateDir);

      expect(result.changes.length).toBeGreaterThan(0);
      const store = readStore(storePath);
      expect(requireStoreEntry(store, "agent:ops:work").sessionId).toBe("abc-123");
      expect(store["agent:ops:main"]).toBeUndefined();
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

  it("imports stores that are already fully canonical", async () => {
    await withStateFixture(async ({ stateDir }) => {
      const storePath = opsSessionStorePath(stateDir);
      writeStore(storePath, {
        "agent:ops:work": { sessionId: "abc-123", updatedAt: 1000 },
      });

      const result = await migrateFixtureState(stateDir);

      expect(result.changes).toContain(
        `Imported 1 session metadata row(s) from ${storePath} → agent SQLite state`,
      );
      expect(result.changes.some((change) => change.includes("Canonicalized"))).toBe(false);
      expect(result.warnings).toHaveLength(0);
      expect(readStore(storePath)["agent:ops:work"]).toBeDefined();
      expect(fs.existsSync(storePath)).toBe(false);
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

  it("imports default main/main stores without key changes", async () => {
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

      expect(result.changes).toContain(
        `Imported 1 session metadata row(s) from ${storePath} → agent SQLite state`,
      );
      expect(result.changes.some((change) => change.includes("Canonicalized"))).toBe(false);
      const store = readStore(storePath);
      expect(requireStoreEntry(store, "agent:main:main").sessionId).toBe("abc-123");
      expect(fs.existsSync(storePath)).toBe(false);
    });
  });
});
