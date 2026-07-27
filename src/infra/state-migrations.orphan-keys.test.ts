// Tests migration cleanup for orphaned state keys.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { migrateOrphanedSessionKeys } from "./state-migrations.js";
import { resolveSessionStoreOwnership } from "./state-migrations.session-store.js";

const listPluginDoctorSessionStoreAgentIdsMock = vi.hoisted(() => vi.fn((): string[] => []));

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  return {
    ...actual,
    listPluginDoctorSessionStoreAgentIds: listPluginDoctorSessionStoreAgentIdsMock,
  };
});

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

async function migrateFixtureState(
  stateDir: string,
  cfg: OpenClawConfig = OPS_WORK_CONFIG,
  additionalAgentIds?: readonly string[],
) {
  return migrateOrphanedSessionKeys({
    cfg,
    env: { OPENCLAW_STATE_DIR: stateDir },
    additionalAgentIds,
  });
}

describe("migrateOrphanedSessionKeys", () => {
  beforeEach(() => {
    listPluginDoctorSessionStoreAgentIdsMock.mockReset();
    listPluginDoctorSessionStoreAgentIdsMock.mockReturnValue([]);
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
    });
  });

  it("promotes legacy voice sessions before canonical runtime access", async () => {
    await withStateFixture(async ({ stateDir }) => {
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      writeStore(storePath, {
        "voice:15550001111": { sessionId: "legacy-voice", updatedAt: 2_000 },
        "agent:main:voice:15550001111": { sessionId: "stale-canonical", updatedAt: 1_000 },
      });

      await migrateFixtureState(stateDir, {} as OpenClawConfig);

      const store = readStore(storePath);
      expect(requireStoreEntry(store, "agent:main:voice:15550001111").sessionId).toBe(
        "legacy-voice",
      );
      expect(store["voice:15550001111"]).toBeUndefined();
    });
  });

  it("treats a blank session store as the default per-agent store", async () => {
    await withStateFixture(async ({ stateDir }) => {
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      writeStore(storePath, {
        "voice:15550001111": { sessionId: "legacy-voice", updatedAt: 2000 },
      });

      const result = await migrateFixtureState(stateDir, {
        session: { store: "" },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig);

      const store = readStore(storePath);
      expect(requireStoreEntry(store, "agent:main:voice:15550001111").sessionId).toBe(
        "legacy-voice",
      );
      expect(store["voice:15550001111"]).toBeUndefined();
      expect(result.warnings).toHaveLength(0);
    });
  });

  it("migrates plugin-owned agents in templated session stores", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const storeTemplate = path.join(tmpDir, "stores", "{agentId}", "sessions.json");
      const voiceStorePath = path.join(tmpDir, "stores", "voice", "sessions.json");
      writeStore(voiceStorePath, {
        "voice:15550001111": { sessionId: "legacy-voice", updatedAt: 2000 },
        "agent:voice:metadata": { updatedAt: 1500, groupActivation: "always" },
      });
      const cfg = {
        session: { store: storeTemplate },
        agents: { list: [{ id: "main", default: true }] },
        plugins: {
          entries: {
            "voice-call": { config: { agentId: "voice" } },
          },
        },
      } as OpenClawConfig;

      const result = await migrateOrphanedSessionKeys({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
        additionalAgentIds: ["voice"],
      });

      const store = readStore(voiceStorePath);
      expect(requireStoreEntry(store, "agent:voice:voice:15550001111").sessionId).toBe(
        "legacy-voice",
      );
      expect(store["agent:voice:metadata"]).toEqual({
        updatedAt: 1500,
        groupActivation: "always",
        delivery: { kind: "none" },
      });
      expect(store["voice:15550001111"]).toBeUndefined();
      expect(result.changes).toHaveLength(1);
      expect(result.warnings).toHaveLength(0);
    });
  });

  it("distinguishes large adjacent inodes before planning store aliases", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const configuredStorePath = path.join(tmpDir, "configured-sessions.json");
      const targetStorePath = path.join(stateDir, "agents", "voice", "sessions", "sessions.json");
      writeStore(configuredStorePath, {});
      writeStore(targetStorePath, {});
      const cfg = {
        session: { store: configuredStorePath },
        agents: { list: [{ id: "ops", default: true }] },
      } as OpenClawConfig;
      const realStatSync = fs.statSync.bind(fs);
      const largeInodes = new Map([
        [configuredStorePath, 72057594037932382n],
        [targetStorePath, 72057594037932383n],
      ]);
      const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((
        candidate: Parameters<typeof fs.statSync>[0],
        options?: { bigint?: boolean },
      ) => {
        const resolvedPath = path.resolve(candidate.toString());
        const inode = largeInodes.get(resolvedPath);
        const useBigInt = options?.bigint === true;
        const stat = useBigInt
          ? realStatSync(candidate, { bigint: true })
          : realStatSync(candidate);
        if (inode === undefined) {
          return stat;
        }
        return new Proxy(stat, {
          get(target, property, receiver) {
            if (property === "dev") {
              return useBigInt ? 2n : 2;
            }
            if (property === "ino") {
              return useBigInt ? inode : Number(inode);
            }
            return Reflect.get(target, property, receiver);
          },
        });
      }) as typeof fs.statSync);

      let ownership: ReturnType<typeof resolveSessionStoreOwnership>;
      try {
        ownership = resolveSessionStoreOwnership({
          cfg,
          env: { OPENCLAW_STATE_DIR: stateDir },
          stateDir,
          targetAgentId: "voice",
          pluginSessionStoreAgentIds: ["voice"],
        });
        expect(statSpy).toHaveBeenCalledWith(configuredStorePath, { bigint: true });
        expect(statSpy).toHaveBeenCalledWith(targetStorePath, { bigint: true });
      } finally {
        statSpy.mockRestore();
      }

      expect(ownership).toEqual({
        preserveAmbiguousKeys: false,
        preserveForeignMainAliases: false,
        targetStoreAliases: {
          hasDistinctAliases: false,
          hasFinalSymlink: false,
          hasUnresolvedIdentity: false,
        },
      });
    });
  });

  it("discovers plugin-owned agents through doctor contracts", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      listPluginDoctorSessionStoreAgentIdsMock.mockReturnValue(["voice"]);
      const storeTemplate = path.join(tmpDir, "stores", "{agentId}", "sessions.json");
      const voiceStorePath = path.join(tmpDir, "stores", "voice", "sessions.json");
      writeStore(voiceStorePath, {
        "voice:15550001111": { sessionId: "legacy-voice", updatedAt: 2000 },
      });
      const cfg = {
        session: { store: storeTemplate },
        agents: { list: [{ id: "main", default: true }] },
        plugins: {
          entries: {
            "voice-call": { config: { agentId: "voice" } },
          },
        },
      } as OpenClawConfig;

      const result = await migrateFixtureState(stateDir, cfg);

      expect(listPluginDoctorSessionStoreAgentIdsMock).toHaveBeenCalledWith({
        config: cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
        pluginIds: ["voice-call"],
      });
      const store = readStore(voiceStorePath);
      expect(requireStoreEntry(store, "agent:voice:voice:15550001111").sessionId).toBe(
        "legacy-voice",
      );
      expect(store["voice:15550001111"]).toBeUndefined();
      expect(result.changes).toHaveLength(1);
      expect(result.warnings).toHaveLength(0);
    });
  });

  it.each([
    { scope: undefined, canonicalMainKey: "agent:voice:main" },
    { scope: "global" as const, canonicalMainKey: "global" },
  ])(
    "preserves opaque foreign main aliases in plugin-owned $scope stores",
    async ({ scope, canonicalMainKey }) => {
      await withStateFixture(async ({ tmpDir, stateDir }) => {
        const storeTemplate = path.join(tmpDir, "stores", "{agentId}", "sessions.json");
        const voiceStorePath = path.join(tmpDir, "stores", "voice", "sessions.json");
        writeStore(voiceStorePath, {
          "agent:main:main": { sessionId: "explicit-foreign", updatedAt: 3000 },
          [canonicalMainKey]: { sessionId: "voice-main", updatedAt: 1000 },
          "voice:15550001111": { sessionId: "legacy-voice", updatedAt: 2000 },
        });
        const cfg = {
          session: { store: storeTemplate, scope },
          agents: { list: [{ id: "main", default: true }] },
          plugins: {
            entries: {
              "voice-call": { config: { agentId: "voice" } },
            },
          },
        } as OpenClawConfig;

        const result = await migrateFixtureState(stateDir, cfg, ["voice"]);

        const store = readStore(voiceStorePath);
        expect(requireStoreEntry(store, "agent:main:main").sessionId).toBe("explicit-foreign");
        expect(requireStoreEntry(store, canonicalMainKey).sessionId).toBe("voice-main");
        expect(requireStoreEntry(store, "agent:voice:voice:15550001111").sessionId).toBe(
          "legacy-voice",
        );
        expect(store["voice:15550001111"]).toBeUndefined();
        expect(result.changes).toHaveLength(1);
        expect(result.warnings).toHaveLength(1);
      });
    },
  );

  it("preserves foreign main aliases before global canonicalization in shared plugin stores", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
      writeStore(sharedStorePath, {
        "agent:main:main": { sessionId: "ambiguous-main", updatedAt: 2000 },
        global: { sessionId: "real-global", updatedAt: 1000 },
      });
      const cfg = {
        session: { store: sharedStorePath, scope: "global" },
        agents: { list: [{ id: "main", default: true }] },
        plugins: {
          entries: {
            "voice-call": { config: { agentId: "voice" } },
          },
        },
      } as OpenClawConfig;

      const result = await migrateFixtureState(stateDir, cfg, ["voice"]);

      const store = readStore(sharedStorePath);
      expect(requireStoreEntry(store, "agent:main:main").sessionId).toBe("ambiguous-main");
      expect(requireStoreEntry(store, "global").sessionId).toBe("real-global");
      expect(result.changes).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
    });
  });

  it("warns on custom main aliases in fixed plugin stores", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
      writeStore(sharedStorePath, {
        "agent:main:work": { sessionId: "ambiguous-main", updatedAt: 2000 },
      });
      const cfg = {
        session: { mainKey: "work", store: sharedStorePath },
        agents: { list: [{ id: "main", default: true }] },
        plugins: {
          entries: {
            "voice-call": { config: { agentId: "voice" } },
          },
        },
      } as OpenClawConfig;

      const result = await migrateFixtureState(stateDir, cfg, ["voice"]);

      const store = readStore(sharedStorePath);
      expect(requireStoreEntry(store, "agent:main:work").sessionId).toBe("ambiguous-main");
      expect(result.changes).toHaveLength(0);
      expect(result.warnings).toEqual([
        `Preserved 1 ambiguous session key(s) in potentially shared store ${sharedStorePath}`,
      ]);
    });
  });

  it("coalesces configured and standard paths that alias one store", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const standardStorePath = path.join(stateDir, "agents", "voice", "sessions", "sessions.json");
      writeStore(standardStorePath, {
        "agent:voice::matrix:channel:!room:example.org": {
          sessionId: "malformed-owner",
          updatedAt: 2000,
        },
        "voice:15550001111": { sessionId: "legacy-voice", updatedAt: 1000 },
        "agent:voice:MixedCase": { sessionId: "scoped", updatedAt: 1000 },
      });
      const configuredStorePath = path.join(tmpDir, "configured-sessions.json");
      fs.linkSync(standardStorePath, configuredStorePath);
      const cfg = {
        session: { store: configuredStorePath },
        agents: { list: [{ id: "ops", default: true }] },
        plugins: {
          entries: {
            "voice-call": { config: { agentId: "voice" } },
          },
        },
      } as OpenClawConfig;

      const result = await migrateFixtureState(stateDir, cfg, ["voice"]);
      const rerun = await migrateFixtureState(stateDir, cfg, ["voice"]);

      expect(result.changes).toHaveLength(0);
      expect(result.warnings).toEqual([
        `Deferred migration of 2 ambiguous session key(s) in aliased store ${configuredStorePath}; remove filesystem aliases or configure one canonical session.store path, then rerun openclaw doctor --fix`,
      ]);
      expect(rerun).toEqual(result);
      expect(
        requireStoreEntry(
          readStore(standardStorePath),
          "agent:voice::matrix:channel:!room:example.org",
        ).sessionId,
      ).toBe("malformed-owner");
      expect(
        requireStoreEntry(readStore(standardStorePath), "agent:voice:MixedCase").sessionId,
      ).toBe("scoped");
      expect(
        readStore(standardStorePath)["agent:ops:agent:voice::matrix:channel:!room:example.org"],
      ).toBeUndefined();
      expect(fs.statSync(configuredStorePath).ino).toBe(fs.statSync(standardStorePath).ino);
    });
  });

  it("warns from a readable alias when the configured path identity is inaccessible", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const configuredStorePath = path.join(tmpDir, "configured-sessions.json");
      writeStore(configuredStorePath, {});
      const standardStorePath = path.join(stateDir, "agents", "voice", "sessions", "sessions.json");
      writeStore(standardStorePath, {
        "voice:15550001111": { sessionId: "legacy-voice", updatedAt: 1000 },
      });
      const cfg = {
        session: { store: configuredStorePath },
        agents: { list: [{ id: "ops", default: true }] },
      } as OpenClawConfig;
      const realStatSync = fs.statSync.bind(fs);
      const statSpy = vi.spyOn(fs, "statSync").mockImplementation((candidate) => {
        if (path.resolve(candidate.toString()) === configuredStorePath) {
          throw Object.assign(new Error("inaccessible store"), { code: "EACCES" });
        }
        return realStatSync(candidate);
      });

      let result: Awaited<ReturnType<typeof migrateOrphanedSessionKeys>>;
      try {
        result = await migrateOrphanedSessionKeys({
          cfg,
          env: { OPENCLAW_STATE_DIR: stateDir },
          additionalAgentIds: ["voice"],
        });
      } finally {
        statSpy.mockRestore();
      }

      expect(result.changes).toHaveLength(0);
      expect(result.warnings).toEqual([
        `Deferred session key migration for ${standardStorePath}; filesystem identity could not be established for every configured store path. Restore path access or configure one canonical session.store path, then rerun openclaw doctor --fix`,
      ]);
      expect(requireStoreEntry(readStore(standardStorePath), "voice:15550001111").sessionId).toBe(
        "legacy-voice",
      );
    });
  });

  it("defers migration through a final-component store symlink", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const standardStorePath = path.join(stateDir, "agents", "voice", "sessions", "sessions.json");
      writeStore(standardStorePath, {
        "agent:voice::matrix:channel:!room:example.org": {
          sessionId: "malformed-owner",
          updatedAt: 2000,
        },
        "voice:15550001111": { sessionId: "legacy-voice", updatedAt: 1000 },
      });
      const configuredStorePath = path.join(tmpDir, "configured-sessions.json");
      fs.symlinkSync(standardStorePath, configuredStorePath);
      const cfg = {
        session: { store: configuredStorePath },
        agents: { list: [{ id: "ops", default: true }] },
        plugins: {
          entries: {
            "voice-call": { config: { agentId: "voice" } },
          },
        },
      } as OpenClawConfig;

      const result = await migrateFixtureState(stateDir, cfg, ["voice"]);

      expect(result.changes).toHaveLength(0);
      expect(result.warnings).toEqual([
        `Deferred migration of 2 ambiguous session key(s) in aliased store ${configuredStorePath}; remove filesystem aliases or configure one canonical session.store path, then rerun openclaw doctor --fix`,
      ]);
      expect(fs.lstatSync(configuredStorePath).isSymbolicLink()).toBe(true);
      expect(
        requireStoreEntry(
          readStore(standardStorePath),
          "agent:voice::matrix:channel:!room:example.org",
        ).sessionId,
      ).toBe("malformed-owner");
    });
  });

  it("defers a singleton final-component store symlink", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const outsideStorePath = path.join(tmpDir, "outside-sessions.json");
      writeStore(outsideStorePath, {
        "voice:15550001111": { sessionId: "outside-voice", updatedAt: 1000 },
      });
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.symlinkSync(outsideStorePath, storePath);

      const result = await migrateFixtureState(stateDir, {} as OpenClawConfig);

      expect(result.changes).toHaveLength(0);
      expect(result.warnings).toEqual([
        `Deferred session key migration in final-component symlink store ${storePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
      ]);
      expect(fs.lstatSync(storePath).isSymbolicLink()).toBe(true);
      expect(requireStoreEntry(readStore(outsideStorePath), "voice:15550001111").sessionId).toBe(
        "outside-voice",
      );
    });
  });

  it("defers an unambiguous rewrite through a singleton final symlink", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const outsideStorePath = path.join(tmpDir, "outside-sessions.json");
      writeStore(outsideStorePath, {
        "agent:main:main": { sessionId: "outside-global", updatedAt: 1000 },
      });
      const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.symlinkSync(outsideStorePath, storePath);
      const cfg = { session: { scope: "global" } } as OpenClawConfig;

      const result = await migrateFixtureState(stateDir, cfg);

      expect(result.changes).toHaveLength(0);
      expect(result.warnings).toEqual([
        `Deferred session key migration in final-component symlink store ${storePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
      ]);
      expect(fs.lstatSync(storePath).isSymbolicLink()).toBe(true);
      expect(requireStoreEntry(readStore(outsideStorePath), "agent:main:main").sessionId).toBe(
        "outside-global",
      );
    });
  });

  it("defers global main aliases across hard-linked store paths", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const standardStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
      writeStore(standardStorePath, {
        "agent:main:main": { sessionId: "legacy-global", updatedAt: 1000 },
      });
      const configuredStorePath = path.join(tmpDir, "configured-sessions.json");
      fs.linkSync(standardStorePath, configuredStorePath);
      const cfg = {
        session: { scope: "global", store: configuredStorePath },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;

      const result = await migrateFixtureState(stateDir, cfg);

      for (const storePath of [configuredStorePath, standardStorePath]) {
        expect(requireStoreEntry(readStore(storePath), "agent:main:main").sessionId).toBe(
          "legacy-global",
        );
        expect(readStore(storePath).global).toBeUndefined();
      }
      expect(result.changes).toHaveLength(0);
      expect(result.warnings).toEqual([
        `Deferred session key migration in aliased store ${configuredStorePath}; atomic replacement cannot update distinct filesystem aliases as one operation. Remove filesystem aliases or configure one canonical session.store path, then rerun openclaw doctor --fix`,
      ]);
    });
  });

  it("normalizes main aliases in a fixed single-owner store", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const storePath = path.join(tmpDir, "sessions.json");
      writeStore(storePath, {
        "agent:main:main": { sessionId: "legacy-main", updatedAt: 1000 },
      });
      const cfg = {
        session: { mainKey: "work", store: storePath },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;

      const result = await migrateFixtureState(stateDir, cfg);

      const store = readStore(storePath);
      expect(requireStoreEntry(store, "agent:main:work").sessionId).toBe("legacy-main");
      expect(store["agent:main:main"]).toBeUndefined();
      expect(result.changes).toHaveLength(1);
      expect(result.warnings).toHaveLength(0);
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

  it("lowercases mixed-case session keys, keeping the freshest duplicate", async () => {
    await withStateFixture(async ({ stateDir }) => {
      const storePath = opsSessionStorePath(stateDir);
      writeStore(storePath, {
        "agent:ops:MySession": { sessionId: "mixed", updatedAt: 1000 },
        "agent:ops:mysession": { sessionId: "lower", updatedAt: 2000 },
        "agent:ops:OtherCase": { sessionId: "other", updatedAt: 1500 },
      });

      await migrateFixtureState(stateDir);

      const store = readStore(storePath);
      expect(requireStoreEntry(store, "agent:ops:mysession").sessionId).toBe("lower");
      expect(store["agent:ops:MySession"]).toBeUndefined();
      expect(requireStoreEntry(store, "agent:ops:othercase").sessionId).toBe("other");
      expect(store["agent:ops:OtherCase"]).toBeUndefined();
    });
  });

  it("canonicalizes mixed-case agent segments in ACP keys, preserving the opaque id", async () => {
    await withStateFixture(async ({ stateDir }) => {
      const storePath = opsSessionStorePath(stateDir);
      const acpId = "33333333-3333-4333-8333-333333333333";
      writeStore(storePath, {
        [`agent:OPS:acp:${acpId}`]: { sessionId: "sess-acp", updatedAt: 1000 },
      });

      await migrateFixtureState(stateDir);

      const store = readStore(storePath);
      expect(requireStoreEntry(store, `agent:ops:acp:${acpId}`).sessionId).toBe("sess-acp");
      expect(store[`agent:OPS:acp:${acpId}`]).toBeUndefined();
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

  it("preserves legacy default-main aliases in shared stores", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      // When session.store lacks {agentId}, all agents resolve to the same file.
      // The "main" agent's keys must not be remapped into the "ops" namespace.
      const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
      writeStore(sharedStorePath, {
        "agent:main:main": { sessionId: "main-session", updatedAt: 2000 },
        "agent:ops:work": { sessionId: "ops-session", updatedAt: 1000 },
      });

      const result = await migrateFixtureState(stateDir, sharedMainOpsConfig(sharedStorePath));

      const store = readStore(sharedStorePath);
      expect(requireStoreEntry(store, "agent:main:main").sessionId).toBe("main-session");
      expect(store["agent:main:work"]).toBeUndefined();
      expect(requireStoreEntry(store, "agent:ops:work").sessionId).toBe("ops-session");
      expect(result.warnings).toHaveLength(1);
    });
  });

  it("canonicalizes global main aliases in shared stores", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
      writeStore(sharedStorePath, {
        global: { sessionId: "stale-global", updatedAt: 1000 },
        main: { sessionId: "bare-main", updatedAt: 2000 },
        "agent:main:main": { sessionId: "legacy-main", updatedAt: 3000 },
        "agent:main:work": { sessionId: "fresh-main", updatedAt: 4000 },
      });
      const cfg = {
        session: { scope: "global", mainKey: "work", store: sharedStorePath },
        agents: { list: [{ id: "main" }, { id: "ops", default: true }] },
      } as OpenClawConfig;

      const result = await migrateFixtureState(stateDir, cfg);

      const store = readStore(sharedStorePath);
      expect(requireStoreEntry(store, "global").sessionId).toBe("fresh-main");
      expect(store.main).toBeUndefined();
      expect(store["agent:main:main"]).toBeUndefined();
      expect(store["agent:main:work"]).toBeUndefined();
      expect(result.changes).toHaveLength(1);
      expect(result.warnings).toHaveLength(0);
    });
  });

  it("does not assign legacy default-main aliases among non-main shared owners", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
      writeStore(sharedStorePath, {
        "agent:main:main": { sessionId: "ambiguous-session", updatedAt: 2000 },
      });
      const cfg = {
        session: { mainKey: "work", store: sharedStorePath },
        agents: { list: [{ id: "ops", default: true }, { id: "research" }] },
      } as OpenClawConfig;

      const result = await migrateFixtureState(stateDir, cfg);

      const store = readStore(sharedStorePath);
      expect(requireStoreEntry(store, "agent:main:main").sessionId).toBe("ambiguous-session");
      expect(store["agent:ops:work"]).toBeUndefined();
      expect(store["agent:research:work"]).toBeUndefined();
      expect(result.changes).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
    });
  });

  it("canonicalizes non-main shared rows within their declared owners", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
      writeStore(sharedStorePath, {
        "agent:ops:main": { sessionId: "ops-session", updatedAt: 1000 },
        "agent:research:main": { sessionId: "research-session", updatedAt: 2000 },
      });
      const cfg = {
        session: { mainKey: "work", store: sharedStorePath },
        agents: { list: [{ id: "ops", default: true }, { id: "research" }] },
      } as OpenClawConfig;

      const result = await migrateFixtureState(stateDir, cfg);

      const store = readStore(sharedStorePath);
      expect(requireStoreEntry(store, "agent:ops:work").sessionId).toBe("ops-session");
      expect(requireStoreEntry(store, "agent:research:work").sessionId).toBe("research-session");
      expect(store["agent:ops:main"]).toBeUndefined();
      expect(store["agent:research:main"]).toBeUndefined();
      expect(result.changes).toHaveLength(1);
      expect(result.warnings).toHaveLength(0);
    });
  });

  it("canonicalizes main aliases for unlisted shared-store owners", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
      writeStore(sharedStorePath, {
        "agent:archive:main": { sessionId: "archive-session", updatedAt: 1000 },
      });
      const cfg = {
        session: { mainKey: "work", store: sharedStorePath },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;

      const result = await migrateFixtureState(stateDir, cfg);

      const store = readStore(sharedStorePath);
      expect(requireStoreEntry(store, "agent:archive:work").sessionId).toBe("archive-session");
      expect(store["agent:archive:main"]).toBeUndefined();
      expect(result.changes).toHaveLength(1);
      expect(result.warnings).toHaveLength(0);
    });
  });

  it("preserves bare main aliases when a store has multiple possible owners", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
      writeStore(sharedStorePath, {
        main: { sessionId: "main-session", updatedAt: 2000 },
        "agent:ops:work": { sessionId: "ops-session", updatedAt: 1000 },
      });

      const result = await migrateFixtureState(stateDir, sharedMainOpsConfig(sharedStorePath));

      const store = readStore(sharedStorePath);
      expect(requireStoreEntry(store, "main").sessionId).toBe("main-session");
      expect(store["agent:main:work"]).toBeUndefined();
      expect(requireStoreEntry(store, "agent:ops:work").sessionId).toBe("ops-session");
      expect(result.warnings).toHaveLength(1);
    });
  });

  it("does not guess the owner of raw keys in shared multi-agent stores", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
      writeStore(sharedStorePath, {
        "voice:15550001111": { sessionId: "legacy-voice", updatedAt: 2000 },
        "agent:ops:work": { sessionId: "ops-session", updatedAt: 1000 },
      });

      const result = await migrateFixtureState(stateDir, sharedMainOpsConfig(sharedStorePath));

      const store = readStore(sharedStorePath);
      expect(requireStoreEntry(store, "voice:15550001111").sessionId).toBe("legacy-voice");
      expect(store["agent:main:voice:15550001111"]).toBeUndefined();
      expect(store["agent:ops:voice:15550001111"]).toBeUndefined();
      expect(result.warnings).toContain(
        `Preserved 1 ambiguous session key(s) in potentially shared store ${sharedStorePath}`,
      );
    });
  });

  it("preserves distinct ambiguous keys that differ only by surrounding whitespace", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
      writeStore(sharedStorePath, {
        "voice:shared": { sessionId: "first-session", updatedAt: 1000 },
        " voice:shared ": { sessionId: "second-session", updatedAt: 2000 },
      });

      const result = await migrateFixtureState(stateDir, sharedMainOpsConfig(sharedStorePath));

      const store = readStore(sharedStorePath);
      expect(requireStoreEntry(store, "voice:shared").sessionId).toBe("first-session");
      expect(requireStoreEntry(store, " voice:shared ").sessionId).toBe("second-session");
      expect(result.changes).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
    });
  });

  it("preserves prototype-shaped keys when another shared-store row migrates", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
      const source = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(source, "__proto__", {
        configurable: true,
        enumerable: true,
        value: { sessionId: "prototype-session", updatedAt: 1000 },
        writable: true,
      });
      source["agent:ops:main"] = { sessionId: "ops-session", updatedAt: 2000 };
      writeStore(sharedStorePath, source);

      const result = await migrateFixtureState(stateDir, sharedMainOpsConfig(sharedStorePath));

      const store = readStore(sharedStorePath);
      expect(Object.hasOwn(store, "__proto__")).toBe(true);
      expect(requireStoreEntry(store, "__proto__").sessionId).toBe("prototype-session");
      expect(requireStoreEntry(store, "agent:ops:work").sessionId).toBe("ops-session");
      expect(result.changes).toHaveLength(1);
      expect(result.warnings).toHaveLength(1);
    });
  });

  it("preserves mixed-case main aliases in a shared store", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
      writeStore(sharedStorePath, {
        MAIN: { sessionId: "main-session", updatedAt: 2000 },
      });
      const cfg = {
        session: { store: sharedStorePath },
        agents: { list: [{ id: "main", default: true }, { id: "ops" }] },
      } as OpenClawConfig;

      const first = await migrateFixtureState(stateDir, cfg);
      const second = await migrateFixtureState(stateDir, cfg);

      const store = readStore(sharedStorePath);
      expect(requireStoreEntry(store, "MAIN").sessionId).toBe("main-session");
      expect(store["agent:main:main"]).toBeUndefined();
      expect(first.changes).toHaveLength(0);
      expect(first.warnings).toHaveLength(1);
      expect(second).toEqual(first);
    });
  });

  it("canonicalizes raw keys in fixed custom stores with one configured agent", async () => {
    await withStateFixture(async ({ tmpDir, stateDir }) => {
      const fixedStorePath = path.join(tmpDir, "custom-sessions.json");
      const discoveredOpsStorePath = opsSessionStorePath(stateDir);
      writeStore(fixedStorePath, {
        "voice:15550001111": { sessionId: "legacy-voice", updatedAt: 2000 },
      });
      writeStore(discoveredOpsStorePath, {
        "voice:15550002222": { sessionId: "ops-voice", updatedAt: 2000 },
      });
      const cfg = {
        session: { store: fixedStorePath },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;

      const first = await migrateFixtureState(stateDir, cfg);
      const second = await migrateFixtureState(stateDir, cfg);

      const store = readStore(fixedStorePath);
      expect(requireStoreEntry(store, "agent:main:voice:15550001111").sessionId).toBe(
        "legacy-voice",
      );
      expect(store["voice:15550001111"]).toBeUndefined();
      const opsStore = readStore(discoveredOpsStorePath);
      expect(requireStoreEntry(opsStore, "agent:ops:voice:15550002222").sessionId).toBe(
        "ops-voice",
      );
      expect(opsStore["voice:15550002222"]).toBeUndefined();
      expect(first.changes).toHaveLength(2);
      expect(first.warnings).toHaveLength(0);
      expect(second).toEqual({ changes: [], warnings: [] });
    });
  });

  it("canonicalizes mixed-case scoped main aliases on the first run", async () => {
    await withStateFixture(async ({ stateDir }) => {
      const storePath = opsSessionStorePath(stateDir);
      writeStore(storePath, {
        "Agent:OPS:MAIN": { sessionId: "ops-session", updatedAt: 2000 },
      });

      const first = await migrateFixtureState(stateDir);
      const second = await migrateFixtureState(stateDir);

      const store = readStore(storePath);
      expect(requireStoreEntry(store, "agent:ops:work").sessionId).toBe("ops-session");
      expect(store["Agent:OPS:MAIN"]).toBeUndefined();
      expect(first.changes).toHaveLength(1);
      expect(second).toEqual({ changes: [], warnings: [] });
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
