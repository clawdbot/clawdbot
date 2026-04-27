import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  buildGatewaySessionRow,
  capArrayByJsonBytes,
  classifySessionKey,
  deriveSessionTitle,
  getSessionDefaults,
  listAgentsForGateway,
  listSessionsFromStore,
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  parseGroupKey,
  pruneLegacyStoreKeys,
  resolveDeletedAgentIdFromSessionKey,
  resolveGatewayModelSupportsImages,
  resolveGatewaySessionStoreTarget,
  resolveSessionModelIdentityRef,
  resolveSessionModelRef,
  resolveSessionStoreKey,
} from "./session-utils.js";

function resolveSyncRealpath(filePath: string): string {
  return fs.realpathSync.native(filePath);
}

function createSymlinkOrSkip(targetPath: string, linkPath: string): boolean {
  try {
    fs.symlinkSync(targetPath, linkPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
      return false;
    }
    throw error;
  }
}

function createSingleAgentAvatarConfig(workspace: string): OpenClawConfig {
  return {
    session: { mainKey: "main" },
    agents: {
      list: [{ id: "main", default: true, workspace, identity: { avatar: "avatar-link.png" } }],
    },
  } as OpenClawConfig;
}

function createModelDefaultsConfig(params: {
  primary: string;
  models?: Record<string, Record<string, never>>;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: params.primary },
        models: params.models,
      },
    },
  } as OpenClawConfig;
}

describe("gateway session utils", () => {
  afterEach(() => {
    resetConfigRuntimeState();
    resetPluginRuntimeStateForTest();
  });

  test("capArrayByJsonBytes trims from the front", () => {
    const res = capArrayByJsonBytes(["a", "b", "c"], 10);
    expect(res.items).toEqual(["b", "c"]);
  });

  test("parseGroupKey handles group keys", () => {
    expect(parseGroupKey("discord:group:dev")).toEqual({
      channel: "discord",
      kind: "group",
      id: "dev",
    });
    expect(parseGroupKey("agent:ops:discord:group:dev")).toEqual({
      channel: "discord",
      kind: "group",
      id: "dev",
    });
    expect(parseGroupKey("foo:bar")).toBeNull();
  });

  test("session defaults include provider-owned thinking options", () => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "test",
      source: "test",
      provider: {
        id: "openai-codex",
        label: "OpenAI Codex",
        auth: [],
        resolveThinkingProfile: ({ modelId }) => ({
          levels: [
            { id: "off" },
            { id: "minimal" },
            { id: "low" },
            { id: "medium" },
            { id: "adaptive" },
            { id: "high" },
            ...(modelId === "gpt-5.5" ? [{ id: "xhigh" as const }] : []),
            { id: "max", label: "maximum" },
          ],
          defaultLevel: "adaptive",
        }),
      },
    });
    setActivePluginRegistry(registry);

    const defaults = getSessionDefaults(
      createModelDefaultsConfig({ primary: "openai-codex/gpt-5.5" }),
    );

    expect(defaults).toMatchObject({
      modelProvider: "openai-codex",
      model: "gpt-5.5",
      thinkingDefault: "adaptive",
    });
    expect(defaults.thinkingLevels).toEqual(
      expect.arrayContaining([
        { id: "adaptive", label: "adaptive" },
        { id: "xhigh", label: "xhigh" },
        { id: "max", label: "maximum" },
      ]),
    );
    expect(defaults.thinkingOptions).toEqual(
      expect.arrayContaining(["adaptive", "xhigh", "maximum"]),
    );
  });

  test("session defaults use configured thinking default", () => {
    const defaults = getSessionDefaults({
      agents: {
        defaults: {
          model: { primary: "openai-codex/gpt-5.5" },
          thinkingDefault: "high",
        },
      },
    } as OpenClawConfig);

    expect(defaults).toMatchObject({
      modelProvider: "openai-codex",
      model: "gpt-5.5",
      thinkingDefault: "high",
    });
  });

  test("session rows use per-agent thinking default from config", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai-codex/gpt-5.5" },
          thinkingDefault: "low",
          models: {
            "openai-codex/gpt-5.5": {
              params: { thinking: "max" },
            },
          },
        },
        list: [
          {
            id: "alpha",
            default: true,
            thinkingDefault: "high",
          },
        ],
      },
    } as OpenClawConfig;

    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: {},
      key: "agent:alpha:main",
    });

    expect(row).toMatchObject({
      modelProvider: "openai-codex",
      model: "gpt-5.5",
      thinkingDefault: "high",
    });
  });

  test("session rows prefer per-model thinking over global default", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai-codex/gpt-5.5" },
          thinkingDefault: "low",
          models: {
            "openai-codex/gpt-5.5": {
              params: { thinking: "max" },
            },
          },
        },
      },
    } as OpenClawConfig;

    const row = buildGatewaySessionRow({
      cfg,
      storePath: "",
      store: {},
      key: "main",
    });

    expect(row).toMatchObject({
      modelProvider: "openai-codex",
      model: "gpt-5.5",
      thinkingDefault: "max",
    });
  });

  test("classifySessionKey respects chat type + prefixes", () => {
    expect(classifySessionKey("global")).toBe("global");
    expect(classifySessionKey("unknown")).toBe("unknown");
    expect(classifySessionKey("discord:group:dev")).toBe("group");
    expect(classifySessionKey("main")).toBe("direct");
    const entry = { chatType: "group" } as SessionEntry;
    expect(classifySessionKey("main", entry)).toBe("group");
  });

  test("resolveSessionStoreKey maps main aliases to default agent main", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "work" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:ops:main" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:ops:MAIN" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:main:main" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:main:work" })).toBe("agent:ops:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "MAIN" })).toBe("agent:ops:work");
  });

  test("resolveSessionStoreKey preserves non-alias agent:main keys for deleted-agent checks", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:main:discord:direct:u1" })).toBe(
      "agent:main:discord:direct:u1",
    );
  });

  test("resolveDeletedAgentIdFromSessionKey rejects non-alias main keys when main is absent", () => {
    const cfg = {
      session: { mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const legacyMainAlias = resolveSessionStoreKey({ cfg, sessionKey: "agent:main:main" });

    expect(legacyMainAlias).toBe("agent:ops:work");
    expect(resolveDeletedAgentIdFromSessionKey(cfg, legacyMainAlias)).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "global")).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "unknown")).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "main")).toBeNull();
    expect(resolveDeletedAgentIdFromSessionKey(cfg, "agent:main:discord:direct:u1")).toBe("main");
  });

  test("resolveSessionStoreKey canonicalizes bare keys to default agent", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "discord:group:123" })).toBe(
      "agent:ops:discord:group:123",
    );
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:alpha:main" })).toBe(
      "agent:alpha:main",
    );
  });

  test("resolveSessionStoreKey falls back to first list entry when no agent is marked default", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops" }, { id: "review" }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("agent:ops:main");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "discord:group:123" })).toBe(
      "agent:ops:discord:group:123",
    );
  });

  test("resolveSessionStoreKey falls back to main when agents.list is missing", () => {
    const cfg = {
      session: { mainKey: "work" },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("agent:main:work");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "thread-1" })).toBe("agent:main:thread-1");
  });

  test("resolveSessionStoreKey normalizes session key casing", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "CoP" })).toBe(
      resolveSessionStoreKey({ cfg, sessionKey: "cop" }),
    );
    expect(resolveSessionStoreKey({ cfg, sessionKey: "MySession" })).toBe("agent:ops:mysession");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:ops:CoP" })).toBe("agent:ops:cop");
    expect(resolveSessionStoreKey({ cfg, sessionKey: "agent:alpha:MySession" })).toBe(
      "agent:alpha:mysession",
    );
  });

  test("resolveSessionStoreKey honors global scope", () => {
    const cfg = {
      session: { scope: "global", mainKey: "work" },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    expect(resolveSessionStoreKey({ cfg, sessionKey: "main" })).toBe("global");
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "main" });
    expect(target.canonicalKey).toBe("global");
    expect(target.agentId).toBe("ops");
  });

  test("resolveGatewaySessionStoreTarget uses canonical key for main alias", () => {
    const storeTemplate = path.join(
      os.tmpdir(),
      "openclaw-session-utils",
      "{agentId}",
      "sessions.json",
    );
    const cfg = {
      session: { mainKey: "main", store: storeTemplate },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "main" });
    expect(target.canonicalKey).toBe("agent:ops:main");
    expect(target.storeKeys).toEqual(expect.arrayContaining(["agent:ops:main", "main"]));
    expect(target.storePath).toBe(path.resolve(storeTemplate.replace("{agentId}", "ops")));
  });

  test("resolveGatewaySessionStoreTarget includes legacy mixed-case store key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-case-"));
    const storePath = path.join(dir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({ "agent:ops:MySession": { sessionId: "s1", updatedAt: 1 } }),
      "utf8",
    );
    const cfg = {
      session: { mainKey: "main", store: storePath },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:ops:mysession" });
    expect(target.canonicalKey).toBe("agent:ops:mysession");
    expect(target.storeKeys).toEqual(
      expect.arrayContaining(["agent:ops:mysession", "agent:ops:MySession"]),
    );
    const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    const found = target.storeKeys.some((k) => Boolean(store[k]));
    expect(found).toBe(true);
  });

  test("resolveGatewaySessionStoreTarget includes all case-variant duplicate keys", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-dupes-"));
    const storePath = path.join(dir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:ops:mysession": { sessionId: "s-lower", updatedAt: 2 },
        "agent:ops:MySession": { sessionId: "s-mixed", updatedAt: 1 },
      }),
      "utf8",
    );
    const cfg = {
      session: { mainKey: "main", store: storePath },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:ops:mysession" });
    expect(target.storeKeys).toEqual(
      expect.arrayContaining(["agent:ops:mysession", "agent:ops:MySession"]),
    );
  });

  test("resolveGatewaySessionStoreTarget finds legacy main alias key when mainKey is customized", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-alias-"));
    const storePath = path.join(dir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({ "agent:ops:MAIN": { sessionId: "s1", updatedAt: 1 } }),
      "utf8",
    );
    const cfg = {
      session: { mainKey: "work", store: storePath },
      agents: { list: [{ id: "ops", default: true }] },
    } as OpenClawConfig;
    const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:ops:main" });
    expect(target.canonicalKey).toBe("agent:ops:work");
    expect(target.storeKeys).toEqual(expect.arrayContaining(["agent:ops:MAIN"]));
  });

  test("resolveGatewaySessionStoreTarget preserves discovered store paths for non-round-tripping agent dirs", async () => {
    await withStateDirEnv("session-utils-discovered-store-", async ({ stateDir }) => {
      const retiredSessionsDir = path.join(stateDir, "agents", "Retired Agent", "sessions");
      fs.mkdirSync(retiredSessionsDir, { recursive: true });
      const retiredStorePath = path.join(retiredSessionsDir, "sessions.json");
      fs.writeFileSync(
        retiredStorePath,
        JSON.stringify({
          "agent:retired-agent:main": { sessionId: "sess-retired", updatedAt: 1 },
        }),
        "utf8",
      );

      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;

      const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:retired-agent:main" });

      expect(target.storePath).toBe(resolveSyncRealpath(retiredStorePath));
    });
  });

  test("loadSessionEntry reads discovered stores from non-round-tripping agent dirs", async () => {
    resetConfigRuntimeState();
    try {
      await withStateDirEnv("session-utils-load-entry-", async ({ stateDir }) => {
        const retiredSessionsDir = path.join(stateDir, "agents", "Retired Agent", "sessions");
        fs.mkdirSync(retiredSessionsDir, { recursive: true });
        const retiredStorePath = path.join(retiredSessionsDir, "sessions.json");
        fs.writeFileSync(
          retiredStorePath,
          JSON.stringify({
            "agent:retired-agent:main": { sessionId: "sess-retired", updatedAt: 7 },
          }),
          "utf8",
        );
        const cfg = {
          session: {
            mainKey: "main",
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
          agents: { list: [{ id: "main", default: true }] },
        } as OpenClawConfig;
        setRuntimeConfigSnapshot(cfg, cfg);

        const loaded = loadSessionEntry("agent:retired-agent:main");

        expect(loaded.storePath).toBe(resolveSyncRealpath(retiredStorePath));
        expect(loaded.entry?.sessionId).toBe("sess-retired");
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("loadSessionEntry preserves a listed deleted main session over the live default main", async () => {
    resetConfigRuntimeState();
    try {
      await withStateDirEnv("session-utils-load-deleted-main-entry-", async ({ stateDir }) => {
        const storeTemplate = path.join(
          stateDir,
          "agents",
          "{agentId}",
          "sessions",
          "sessions.json",
        );
        const liveSessionsDir = path.join(stateDir, "agents", "ops", "sessions");
        const deletedSessionsDir = path.join(stateDir, "agents", "main", "sessions");
        fs.mkdirSync(liveSessionsDir, { recursive: true });
        fs.mkdirSync(deletedSessionsDir, { recursive: true });
        const liveStorePath = path.join(liveSessionsDir, "sessions.json");
        const deletedStorePath = path.join(deletedSessionsDir, "sessions.json");
        fs.writeFileSync(
          liveStorePath,
          JSON.stringify({
            "agent:ops:main": { sessionId: "sess-live-default", updatedAt: 10 },
          }),
          "utf8",
        );
        fs.writeFileSync(
          deletedStorePath,
          JSON.stringify({
            "agent:main:main": { sessionId: "sess-deleted-main", updatedAt: 20 },
          }),
          "utf8",
        );
        const cfg = {
          session: { mainKey: "main", store: storeTemplate },
          agents: { list: [{ id: "ops", default: true }] },
        } as OpenClawConfig;
        setRuntimeConfigSnapshot(cfg, cfg);

        const target = resolveGatewaySessionStoreTarget({ cfg, key: "agent:main:main" });
        const loaded = loadSessionEntry("agent:main:main");

        expect(target.canonicalKey).toBe("agent:main:main");
        expect(target.agentId).toBe("main");
        expect(target.storePath).toBe(resolveSyncRealpath(deletedStorePath));
        expect(loaded.canonicalKey).toBe("agent:main:main");
        expect(loaded.storePath).toBe(resolveSyncRealpath(deletedStorePath));
        expect(loaded.entry?.sessionId).toBe("sess-deleted-main");
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("loadSessionEntry resolves deleted main aliases when mainKey is customized", async () => {
    resetConfigRuntimeState();
    try {
      await withStateDirEnv("session-utils-load-deleted-main-alias-", async ({ stateDir }) => {
        const storeTemplate = path.join(
          stateDir,
          "agents",
          "{agentId}",
          "sessions",
          "sessions.json",
        );
        const liveSessionsDir = path.join(stateDir, "agents", "ops", "sessions");
        const deletedSessionsDir = path.join(stateDir, "agents", "main", "sessions");
        fs.mkdirSync(liveSessionsDir, { recursive: true });
        fs.mkdirSync(deletedSessionsDir, { recursive: true });
        fs.writeFileSync(
          path.join(liveSessionsDir, "sessions.json"),
          JSON.stringify({
            "agent:ops:work": { sessionId: "sess-live-default", updatedAt: 10 },
          }),
          "utf8",
        );
        const deletedStorePath = path.join(deletedSessionsDir, "sessions.json");
        fs.writeFileSync(
          deletedStorePath,
          JSON.stringify({
            "agent:main:main": { sessionId: "sess-deleted-main", updatedAt: 20 },
          }),
          "utf8",
        );
        const cfg = {
          session: { mainKey: "work", store: storeTemplate },
          agents: { list: [{ id: "ops", default: true }] },
        } as OpenClawConfig;
        setRuntimeConfigSnapshot(cfg, cfg);

        const loaded = loadSessionEntry("agent:main:work");

        expect(loaded.canonicalKey).toBe("agent:main:work");
        expect(loaded.storePath).toBe(resolveSyncRealpath(deletedStorePath));
        expect(loaded.entry?.sessionId).toBe("sess-deleted-main");
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("loadSessionEntry prefers the freshest duplicate row for a logical key", async () => {
    resetConfigRuntimeState();
    try {
      await withStateDirEnv("session-utils-load-entry-freshest-", async ({ stateDir }) => {
        const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
        fs.mkdirSync(sessionsDir, { recursive: true });
        const storePath = path.join(sessionsDir, "sessions.json");
        fs.writeFileSync(
          storePath,
          JSON.stringify(
            {
              "agent:main:main": { sessionId: "sess-stale", updatedAt: 1 },
              "agent:main:MAIN": { sessionId: "sess-fresh", updatedAt: 2 },
            },
            null,
            2,
          ),
          "utf8",
        );
        const cfg = {
          session: {
            mainKey: "main",
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
          agents: { list: [{ id: "main", default: true }] },
        } as OpenClawConfig;
        setRuntimeConfigSnapshot(cfg, cfg);

        const loaded = loadSessionEntry("agent:main:main");

        expect(loaded.entry?.sessionId).toBe("sess-fresh");
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("loadSessionEntry prefers the freshest duplicate row across discovered stores", async () => {
    resetConfigRuntimeState();
    try {
      await withStateDirEnv("session-utils-load-entry-cross-store-", async ({ stateDir }) => {
        const canonicalSessionsDir = path.join(stateDir, "agents", "main", "sessions");
        fs.mkdirSync(canonicalSessionsDir, { recursive: true });
        fs.writeFileSync(
          path.join(canonicalSessionsDir, "sessions.json"),
          JSON.stringify(
            {
              "agent:main:main": { sessionId: "sess-canonical-stale", updatedAt: 10 },
              "agent:main:MAIN": { sessionId: "sess-canonical-fresh", updatedAt: 1000 },
            },
            null,
            2,
          ),
          "utf8",
        );

        const discoveredSessionsDir = path.join(stateDir, "agents", "main ", "sessions");
        fs.mkdirSync(discoveredSessionsDir, { recursive: true });
        fs.writeFileSync(
          path.join(discoveredSessionsDir, "sessions.json"),
          JSON.stringify(
            {
              "agent:main:main": { sessionId: "sess-discovered-mid", updatedAt: 500 },
            },
            null,
            2,
          ),
          "utf8",
        );

        const cfg = {
          session: {
            mainKey: "main",
            store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
          agents: { list: [{ id: "main", default: true }] },
        } as OpenClawConfig;
        setRuntimeConfigSnapshot(cfg, cfg);

        const loaded = loadSessionEntry("agent:main:main");

        expect(loaded.entry?.sessionId).toBe("sess-canonical-fresh");
      });
    } finally {
      resetConfigRuntimeState();
    }
  });

  test("pruneLegacyStoreKeys removes alias and case-variant ghost keys", () => {
    const store: Record<string, unknown> = {
      "agent:ops:work": { sessionId: "canonical", updatedAt: 3 },
      "agent:ops:MAIN": { sessionId: "legacy-upper", updatedAt: 1 },
      "agent:ops:Main": { sessionId: "legacy-mixed", updatedAt: 2 },
      "agent:ops:main": { sessionId: "legacy-lower", updatedAt: 4 },
    };
    pruneLegacyStoreKeys({
      store,
      canonicalKey: "agent:ops:work",
      candidates: ["agent:ops:work", "agent:ops:main"],
    });
    expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);
  });

  test("migrateAndPruneGatewaySessionStoreKey promotes the freshest duplicate row", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    const store: Record<string, SessionEntry> = {
      "agent:main:Main": {
        sessionId: "sess-stale",
        updatedAt: 1,
      } as SessionEntry,
      "agent:main:MAIN": {
        sessionId: "sess-fresh",
        updatedAt: 2,
      } as SessionEntry,
    };

    const result = migrateAndPruneGatewaySessionStoreKey({
      cfg,
      key: "agent:main:main",
      store,
    });

    expect(result.primaryKey).toBe("agent:main:main");
    expect(result.entry?.sessionId).toBe("sess-fresh");
    expect(store["agent:main:main"]?.sessionId).toBe("sess-fresh");
    expect(store["agent:main:MAIN"]).toBeUndefined();
    expect(store["agent:main:Main"]).toBeUndefined();
  });

  test("migrateAndPruneGatewaySessionStoreKey replaces a stale canonical row with a fresher duplicate", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-stale",
        updatedAt: 1,
      } as SessionEntry,
      "agent:main:MAIN": {
        sessionId: "sess-fresh",
        updatedAt: 2,
      } as SessionEntry,
    };

    const result = migrateAndPruneGatewaySessionStoreKey({
      cfg,
      key: "agent:main:main",
      store,
    });

    expect(result.primaryKey).toBe("agent:main:main");
    expect(result.entry?.sessionId).toBe("sess-fresh");
    expect(store["agent:main:main"]?.sessionId).toBe("sess-fresh");
    expect(store["agent:main:MAIN"]).toBeUndefined();
  });

  test("listAgentsForGateway rejects avatar symlink escapes outside workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-avatar-outside-"));
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const outsideFile = path.join(root, "outside.txt");
    fs.writeFileSync(outsideFile, "top-secret", "utf8");
    const linkPath = path.join(workspace, "avatar-link.png");
    if (!createSymlinkOrSkip(outsideFile, linkPath)) {
      return;
    }

    const cfg = createSingleAgentAvatarConfig(workspace);

    const result = listAgentsForGateway(cfg);
    expect(result.agents[0]?.identity?.avatarUrl).toBeUndefined();
  });

  test("listAgentsForGateway allows avatar symlinks that stay inside workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-utils-avatar-inside-"));
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(path.join(workspace, "avatars"), { recursive: true });
    const targetPath = path.join(workspace, "avatars", "actual.png");
    fs.writeFileSync(targetPath, "avatar", "utf8");
    const linkPath = path.join(workspace, "avatar-link.png");
    if (!createSymlinkOrSkip(targetPath, linkPath)) {
      return;
    }

    const cfg = createSingleAgentAvatarConfig(workspace);

    const result = listAgentsForGateway(cfg);
    expect(result.agents[0]?.identity?.avatarUrl).toBe(
      `data:image/png;base64,${Buffer.from("avatar").toString("base64")}`,
    );
  });

  test("listAgentsForGateway keeps explicit agents.list scope over disk-only agents (scope boundary)", async () => {
    await withStateDirEnv("openclaw-agent-list-scope-", async ({ stateDir }) => {
      fs.mkdirSync(path.join(stateDir, "agents", "main"), { recursive: true });
      fs.mkdirSync(path.join(stateDir, "agents", "codex"), { recursive: true });

      const cfg = {
        session: { mainKey: "main" },
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;

      const { agents } = listAgentsForGateway(cfg);
      expect(agents.map((agent) => agent.id)).toEqual(["main"]);
    });
  });

  test("listAgentsForGateway includes effective workspace + model for default agent", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        defaults: {
          workspace: "/tmp/default-workspace",
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["openai-codex/gpt-5.4"],
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    const result = listAgentsForGateway(cfg);
    expect(result.agents[0]).toMatchObject({
      id: "main",
      workspace: "/tmp/default-workspace",
      model: {
        primary: "openai/gpt-5.4",
        fallbacks: ["openai-codex/gpt-5.4"],
      },
    });
  });

  test("listAgentsForGateway respects per-agent fallback override (including explicit empty list)", () => {
    const cfg = {
      session: { mainKey: "main" },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["openai-codex/gpt-5.4"],
          },
        },
        list: [
          { id: "main", default: true },
          {
            id: "ops",
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: [],
            },
          },
        ],
      },
    } as OpenClawConfig;

    const result = listAgentsForGateway(cfg);
    const ops = result.agents.find((agent) => agent.id === "ops");
    expect(ops?.model).toEqual({ primary: "anthropic/claude-opus-4-6" });
  });
});

describe("resolveSessionModelRef", () => {
  test("prefers explicit session overrides ahead of runtime model fields", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s1",
      updatedAt: Date.now(),
      modelProvider: "openai-codex",
      model: "gpt-5.4",
      modelOverride: "claude-opus-4-6",
      providerOverride: "anthropic",
    });

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-opus-4-6" });
  });

  test("preserves openrouter provider when model contains vendor prefix", () => {
    const cfg = createModelDefaultsConfig({
      primary: "openrouter/minimax/minimax-m2.7",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s-or",
      updatedAt: Date.now(),
      modelProvider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
    });

    expect(resolved).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
    });
  });

  test("falls back to override when runtime model is not recorded yet", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s2",
      updatedAt: Date.now(),
      modelOverride: "openai-codex/gpt-5.4",
    });

    expect(resolved).toEqual({ provider: "openai-codex", model: "gpt-5.4" });
  });

  test("keeps nested model ids under the stored provider override", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s-nested",
      updatedAt: Date.now(),
      providerOverride: "nvidia",
      modelOverride: "moonshotai/kimi-k2.5",
    });

    expect(resolved).toEqual({ provider: "nvidia", model: "moonshotai/kimi-k2.5" });
  });

  test("preserves explicit wrapper providers for vendor-prefixed override models", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s-openrouter-override",
      updatedAt: Date.now(),
      providerOverride: "openrouter",
      modelOverride: "anthropic/claude-haiku-4.5",
      modelProvider: "openrouter",
      model: "openrouter/free",
    });

    expect(resolved).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
    });
  });

  test("strips a duplicated provider prefix from stored overrides", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "s-qualified-override",
      updatedAt: Date.now(),
      providerOverride: "openai-codex",
      modelOverride: "openai-codex/gpt-5.4",
    });

    expect(resolved).toEqual({ provider: "openai-codex", model: "gpt-5.4" });
  });

  test("falls back to resolved provider for unprefixed legacy runtime model", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "legacy-session",
      updatedAt: Date.now(),
      model: "claude-sonnet-4-6",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({
      provider: "google-gemini-cli",
      model: "claude-sonnet-4-6",
    });
  });

  test("preserves provider from slash-prefixed model when modelProvider is missing", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveSessionModelRef(cfg, {
      sessionId: "slash-model",
      updatedAt: Date.now(),
      model: "anthropic/claude-sonnet-4-6",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });
});

describe("listSessionsFromStore selected model display", () => {
  test("shows the selected override model even when a fallback runtime model exists", () => {
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-opus-4-6",
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
          modelProvider: "openai-codex",
          model: "gpt-5.4",
        } as SessionEntry,
      },
      opts: {},
    });

    expect(result.sessions[0]?.modelProvider).toBe("anthropic");
    expect(result.sessions[0]?.model).toBe("claude-opus-4-6");
  });
});

describe("resolveSessionModelIdentityRef", () => {
  const resolveLegacyIdentityRef = (cfg: OpenClawConfig, modelProvider?: string) =>
    resolveSessionModelIdentityRef(cfg, {
      sessionId: "legacy-session",
      updatedAt: Date.now(),
      model: "claude-sonnet-4-6",
      modelProvider,
    });

  test("does not inherit default provider for unprefixed legacy runtime model", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveLegacyIdentityRef(cfg);

    expect(resolved).toEqual({ model: "claude-sonnet-4-6" });
  });

  test("infers provider from configured model allowlist when unambiguous", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
      models: {
        "anthropic/claude-sonnet-4-6": {},
      },
    });

    const resolved = resolveLegacyIdentityRef(cfg);

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  test("infers provider from configured provider catalogs when allowlist is absent", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });
    cfg.models = {
      providers: {
        "qwen-dashscope": {
          models: [{ id: "qwen-max" }],
        },
      },
    } as unknown as OpenClawConfig["models"];

    const resolved = resolveSessionModelIdentityRef(cfg, {
      sessionId: "custom-provider-runtime-model",
      updatedAt: Date.now(),
      model: "qwen-max",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({ provider: "qwen-dashscope", model: "qwen-max" });
  });

  test("keeps provider unknown when configured models are ambiguous", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
      models: {
        "anthropic/claude-sonnet-4-6": {},
        "minimax/claude-sonnet-4-6": {},
      },
    });

    const resolved = resolveLegacyIdentityRef(cfg);

    expect(resolved).toEqual({ model: "claude-sonnet-4-6" });
  });

  test("keeps provider unknown when configured provider catalog matches are ambiguous", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });
    cfg.models = {
      providers: {
        "qwen-dashscope": {
          models: [{ id: "qwen-max" }],
        },
        qwen: {
          models: [{ id: "qwen-max" }],
        },
      },
    } as unknown as OpenClawConfig["models"];

    const resolved = resolveSessionModelIdentityRef(cfg, {
      sessionId: "ambiguous-custom-provider-runtime-model",
      updatedAt: Date.now(),
      model: "qwen-max",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({ model: "qwen-max" });
  });

  test("preserves provider from slash-prefixed runtime model", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
    });

    const resolved = resolveSessionModelIdentityRef(cfg, {
      sessionId: "slash-model",
      updatedAt: Date.now(),
      model: "anthropic/claude-sonnet-4-6",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  test("infers wrapper provider for slash-prefixed runtime model when allowlist match is unique", () => {
    const cfg = createModelDefaultsConfig({
      primary: "google-gemini-cli/gemini-3-pro-preview",
      models: {
        "vercel-ai-gateway/anthropic/claude-sonnet-4-6": {},
      },
    });

    const resolved = resolveSessionModelIdentityRef(cfg, {
      sessionId: "slash-model",
      updatedAt: Date.now(),
      model: "anthropic/claude-sonnet-4-6",
      modelProvider: undefined,
    });

    expect(resolved).toEqual({
      provider: "vercel-ai-gateway",
      model: "anthropic/claude-sonnet-4-6",
    });
  });
});

describe("deriveSessionTitle", () => {
  test("returns undefined for undefined entry", () => {
    expect(deriveSessionTitle(undefined)).toBeUndefined();
  });

  test("prefers displayName when set", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      displayName: "My Custom Session",
      subject: "Group Chat",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("My Custom Session");
  });

  test("falls back to subject when displayName is missing", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      subject: "Dev Team Chat",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Dev Team Chat");
  });

  test("uses first user message when displayName and subject missing", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    expect(deriveSessionTitle(entry, "Hello, how are you?")).toBe("Hello, how are you?");
  });

  test("truncates long first user message to 60 chars with ellipsis", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    const longMsg =
      "This is a very long message that exceeds sixty characters and should be truncated appropriately";
    const result = deriveSessionTitle(entry, longMsg);
    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(60);
    expect(result!.endsWith("…")).toBe(true);
  });

  test("truncates at word boundary when possible", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
    } as SessionEntry;
    const longMsg = "This message has many words and should be truncated at a word boundary nicely";
    const result = deriveSessionTitle(entry, longMsg);
    expect(result).toBeDefined();
    expect(result!.endsWith("…")).toBe(true);
    expect(result!.includes("  ")).toBe(false);
  });

  test("falls back to sessionId prefix with date", () => {
    const entry = {
      sessionId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
      updatedAt: new Date("2024-03-15T10:30:00Z").getTime(),
    } as SessionEntry;
    const result = deriveSessionTitle(entry);
    expect(result).toBe("abcd1234 (2024-03-15)");
  });

  test("falls back to sessionId prefix without date when updatedAt missing", () => {
    const entry = {
      sessionId: "abcd1234-5678-90ef-ghij-klmnopqrstuv",
      updatedAt: 0,
    } as SessionEntry;
    const result = deriveSessionTitle(entry);
    expect(result).toBe("abcd1234");
  });

  test("trims whitespace from displayName", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      displayName: "  Padded Name  ",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Padded Name");
  });

  test("ignores empty displayName and falls through", () => {
    const entry = {
      sessionId: "abc123",
      updatedAt: Date.now(),
      displayName: "   ",
      subject: "Actual Subject",
    } as SessionEntry;
    expect(deriveSessionTitle(entry)).toBe("Actual Subject");
  });
});

describe("resolveGatewayModelSupportsImages", () => {
  test("keeps Foundry GPT deployments image-capable even when stale catalog metadata says text-only", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "gpt-5.4",
        provider: "microsoft-foundry",
        loadGatewayModelCatalog: async () => [
          { id: "gpt-5.4", name: "GPT-5.4", provider: "microsoft-foundry", input: ["text"] },
        ],
      }),
    ).resolves.toBe(true);
  });

  test("uses the preserved Foundry model name hint for alias deployments with stale text-only input metadata", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "deployment-gpt5",
        provider: "microsoft-foundry",
        loadGatewayModelCatalog: async () => [
          {
            id: "deployment-gpt5",
            name: "gpt-5.4",
            provider: "microsoft-foundry",
            input: ["text"],
          },
        ],
      }),
    ).resolves.toBe(true);
  });

  test("treats claude-cli Claude models as image-capable even when catalog metadata is stale or missing", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "claude-sonnet-4-6",
        provider: "claude-cli",
        loadGatewayModelCatalog: async () => [
          {
            id: "claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            provider: "claude-cli",
            input: ["text"],
          },
        ],
      }),
    ).resolves.toBe(true);
  });
});
