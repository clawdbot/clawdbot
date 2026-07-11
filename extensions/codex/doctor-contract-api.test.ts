// Codex tests cover doctor contract api plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  legacyConfigRules,
  normalizeCompatibilityConfig,
  stateMigrations,
} from "./doctor-contract-api.js";
import {
  bindingStoreKey,
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createStoredCodexAppServerBinding,
  hashCodexAppServerBindingFingerprint,
  type StoredCodexAppServerBinding,
} from "./src/app-server/session-binding.js";
import { legacyCodexConversationBindingId } from "./src/conversation-binding-data.js";

function createDoctorContext(
  env: NodeJS.ProcessEnv,
  afterRegister?: () => Promise<void>,
): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      const store = createPluginStateKeyedStoreForTests<T>("codex", {
        ...options,
        env: options.env ?? env,
      });
      return afterRegister
        ? {
            ...store,
            async registerIfAbsent(...args: Parameters<typeof store.registerIfAbsent>) {
              const registered = await store.registerIfAbsent(...args);
              await afterRegister();
              return registered;
            },
          }
        : store;
    },
  };
}

function openBindingStore(env: NodeJS.ProcessEnv) {
  return createDoctorContext(env).openPluginStateKeyedStore<StoredCodexAppServerBinding>({
    namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
    maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

async function createBindingMigrationFixture(options: {
  binding?: Record<string, unknown>;
  name: string;
  sessionIndex?: Record<string, unknown>;
  threadId: string;
}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-"));
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
  const storePath = path.join(sessionsDir, "sessions.json");
  const transcriptPath = path.join(sessionsDir, `${options.name}.jsonl`);
  const sidecarPath = `${transcriptPath}.codex-app-server.json`;
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({ type: "session", id: options.name })}\n`,
    "utf8",
  );
  if (options.sessionIndex !== undefined) {
    await fs.writeFile(storePath, JSON.stringify(options.sessionIndex), "utf8");
  }
  await fs.writeFile(
    sidecarPath,
    JSON.stringify({
      schemaVersion: 2,
      threadId: options.threadId,
      sessionFile: transcriptPath,
      updatedAt: "2026-01-01T00:00:00.000Z",
      pluginAppPolicyContext: {
        fingerprint: "policy-1",
        apps: {},
        pluginAppIds: {},
      },
      ...options.binding,
    }),
    "utf8",
  );
  const migration = stateMigrations[0];
  if (!migration) {
    throw new Error("missing Codex binding migration");
  }
  return {
    env,
    migration,
    params: {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    },
    sessionsDir,
    sidecarPath,
    stateDir,
    storePath,
    transcriptPath,
  };
}

afterEach(() => {
  resetPluginStateStoreForTests();
});

describe("codex doctor contract", () => {
  it("reports the retired dynamic tools profile config key", () => {
    expect(
      legacyConfigRules[0]?.match({
        codexDynamicToolsProfile: "openclaw-compat",
        codexDynamicToolsLoading: "direct",
      }),
    ).toBe(true);
    expect(legacyConfigRules[0]?.match({ codexDynamicToolsLoading: "direct" })).toBe(false);
  });

  it("reports old approval-routed destructive plugin policy values", () => {
    expect(
      legacyConfigRules[1]?.match({
        allow_destructive_actions: "on-request",
        plugins: {},
      }),
    ).toBe(true);
    expect(
      legacyConfigRules[1]?.match({
        allow_destructive_actions: true,
        plugins: {
          "google-calendar": { allow_destructive_actions: "on-request" },
        },
      }),
    ).toBe(true);
    expect(
      legacyConfigRules[1]?.match({
        allow_destructive_actions: "auto",
        plugins: {
          "google-calendar": { allow_destructive_actions: true },
        },
      }),
    ).toBe(false);
    expect(
      legacyConfigRules[1]?.match({
        allow_destructive_actions: "ask",
        plugins: {
          "google-calendar": { allow_destructive_actions: "ask" },
        },
      }),
    ).toBe(false);
    expect(
      legacyConfigRules[1]?.match({
        allow_destructive_actions: "always",
        plugins: {
          "google-calendar": { allow_destructive_actions: "always" },
        },
      }),
    ).toBe(false);
  });

  it("reports the retired on-failure app-server approval policy", () => {
    expect(legacyConfigRules[2]?.match({ approvalPolicy: "on-failure" })).toBe(true);
    expect(legacyConfigRules[2]?.match({ approvalPolicy: "on-request" })).toBe(false);
  });

  it("removes the retired dynamic tools profile without dropping other Codex config", () => {
    const original = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexDynamicToolsProfile: "openclaw-compat",
              codexDynamicToolsLoading: "direct",
              codexDynamicToolsExclude: ["custom_tool"],
              appServer: { mode: "guardian" },
            },
          },
        },
      },
    };

    const result = normalizeCompatibilityConfig({ cfg: original });

    expect(result.changes).toEqual([
      "Removed retired plugins.entries.codex.config.codexDynamicToolsProfile; Codex app-server always keeps Codex-native workspace tools native.",
    ]);
    expect(result.config.plugins?.entries?.codex?.config).toEqual({
      codexDynamicToolsLoading: "direct",
      codexDynamicToolsExclude: ["custom_tool"],
      appServer: { mode: "guardian" },
    });
    expect(original.plugins.entries.codex.config).toHaveProperty("codexDynamicToolsProfile");
  });

  it("imports and archives shipped binding sidecars", async () => {
    const fixture = await createBindingMigrationFixture({
      name: "session-current",
      sessionIndex: {
        "agent:main:session-1": {
          sessionId: "session-current",
          sessionFile: "session-current.jsonl",
          updatedAt: 1,
        },
      },
      threadId: "thread-1",
      binding: {
        pluginAppPolicyContext: {
          fingerprint: "policy-1",
          apps: {
            app: {
              configKey: "app",
              marketplaceName: "openai-curated",
              pluginName: "plugin",
              allowDestructiveActions: true,
              destructiveApprovalMode: "ask",
              mcpServerNames: [],
            },
          },
          pluginAppIds: {},
        },
      },
    });

    await expect(fixture.migration.detectLegacyState(fixture.params)).resolves.toMatchObject({
      preview: [expect.stringContaining("legacy sidecar")],
    });
    await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toMatchObject({
      changes: [expect.stringContaining("Migrated 1")],
      warnings: [],
    });

    const store = openBindingStore(fixture.env);
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "main",
          sessionId: "session-current",
          sessionKey: "agent:main:session-1",
        }),
      ),
    ).resolves.toMatchObject({
      state: "active",
      sessionId: "session-current",
      binding: {
        threadId: "thread-1",
        pluginAppPolicyContext: {
          apps: { app: { destructiveApprovalMode: "ask" } },
        },
      },
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "conversation",
          bindingId: legacyCodexConversationBindingId(fixture.transcriptPath),
        }),
      ),
    ).resolves.toMatchObject({ state: "active", binding: { threadId: "thread-1" } });
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();
    expect(
      getSessionEntry({
        agentId: "main",
        env: fixture.env,
        sessionKey: "agent:main:session-1",
        storePath: fixture.storePath,
      }),
    ).toMatchObject({
      sessionId: "session-current",
      agentHarnessId: "codex",
    });
    await expect(
      fs.readFile(fixture.storePath, "utf8").then(JSON.parse),
    ).resolves.not.toHaveProperty("agent:main:session-1.agentHarnessId");

    await fs.rm(fixture.stateDir, { recursive: true, force: true });
  });

  it("bounds oversized legacy fingerprints before plugin-state import", async () => {
    const rawDynamicToolsFingerprint = JSON.stringify([
      { name: "legacy_large_tool", inputSchema: { description: "dynamic-marker".repeat(8_000) } },
    ]);
    const rawUserMcpServersFingerprint = JSON.stringify({
      mcp_servers: {
        legacy: {
          command: "node",
          args: ["user-mcp-marker".repeat(8_000)],
          http_headers: { authorization: "Bearer legacy-secret" },
        },
      },
    });
    const sessionKey = "agent:main:oversized";
    const fixture = await createBindingMigrationFixture({
      name: "oversized",
      sessionIndex: {
        [sessionKey]: {
          sessionId: "oversized",
          sessionFile: "oversized.jsonl",
        },
      },
      threadId: "thread-oversized",
      binding: {
        dynamicToolsFingerprint: rawDynamicToolsFingerprint,
        userMcpServersFingerprint: rawUserMcpServersFingerprint,
      },
    });
    expect((await fs.stat(fixture.sidecarPath)).size).toBeGreaterThan(65_536);

    await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
      changes: [
        "Migrated 1 Codex app-server binding sidecar(s) to plugin state and archived the legacy sources",
      ],
      warnings: [],
    });

    const stored = await openBindingStore(fixture.env).lookup(
      bindingStoreKey({
        kind: "session",
        agentId: "main",
        sessionId: "oversized",
        sessionKey,
      }),
    );
    expect(stored).toMatchObject({
      state: "active",
      binding: {
        dynamicToolsFingerprint: hashCodexAppServerBindingFingerprint(rawDynamicToolsFingerprint),
        userMcpServersFingerprint: hashCodexAppServerBindingFingerprint(
          rawUserMcpServersFingerprint,
        ),
      },
    });
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThan(65_536);
    expect(JSON.stringify(stored)).not.toContain("dynamic-marker");
    expect(JSON.stringify(stored)).not.toContain("user-mcp-marker");
    expect(JSON.stringify(stored)).not.toContain("legacy-secret");
    await expect(fs.access(fixture.sidecarPath)).rejects.toThrow();
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();
    await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });

    await fs.rm(fixture.stateDir, { recursive: true, force: true });
  });

  it("normalizes a partial raw conversation import before copying the session row", async () => {
    const threadId = "thread-partial-import";
    const sessionId = "partial-import";
    const sessionKey = "agent:main:partial-import";
    const emptyConversation: StoredCodexAppServerBinding = {
      version: 1,
      state: "active",
      binding: {
        threadId,
        cwd: "",
        dynamicToolsFingerprint: "",
      },
    };
    const rawFingerprint = "x".repeat(
      65_535 - Buffer.byteLength(JSON.stringify(emptyConversation)),
    );
    const rawConversation: StoredCodexAppServerBinding = {
      ...emptyConversation,
      binding: {
        ...emptyConversation.binding,
        dynamicToolsFingerprint: rawFingerprint,
      },
    };
    const rawSession = { ...rawConversation, sessionId };
    expect(Buffer.byteLength(JSON.stringify(rawConversation))).toBe(65_535);
    expect(Buffer.byteLength(JSON.stringify(rawSession))).toBeGreaterThan(65_536);

    const fixture = await createBindingMigrationFixture({
      name: sessionId,
      sessionIndex: {
        [sessionKey]: {
          sessionId,
          sessionFile: `${sessionId}.jsonl`,
        },
      },
      threadId,
      binding: { dynamicToolsFingerprint: rawFingerprint },
    });
    const conversationKey = bindingStoreKey({
      kind: "conversation",
      bindingId: legacyCodexConversationBindingId(fixture.transcriptPath),
    });
    const sessionBindingKey = bindingStoreKey({
      kind: "session",
      agentId: "main",
      sessionId,
      sessionKey,
    });
    const store = openBindingStore(fixture.env);
    await store.register(conversationKey, rawConversation);

    await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
      changes: [
        "Migrated 1 Codex app-server binding sidecar(s) to plugin state and archived the legacy sources",
      ],
      warnings: [],
    });

    const expectedFingerprint = hashCodexAppServerBindingFingerprint(rawFingerprint);
    await expect(store.lookup(conversationKey)).resolves.toMatchObject({
      state: "active",
      binding: { dynamicToolsFingerprint: expectedFingerprint },
    });
    await expect(store.lookup(sessionBindingKey)).resolves.toMatchObject({
      state: "active",
      sessionId,
      binding: { dynamicToolsFingerprint: expectedFingerprint },
    });
    await expect(fs.access(fixture.sidecarPath)).rejects.toThrow();
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();
    await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });

    await fs.rm(fixture.stateDir, { recursive: true, force: true });
  });

  it("normalizes retained raw conversation and session rows before comparison", async () => {
    const threadId = "thread-retained-import";
    const sessionId = "retained-import";
    const sessionKey = "agent:main:retained-import";
    const rawFingerprint = "x".repeat(60_000);
    const rawConversation: StoredCodexAppServerBinding = {
      version: 1,
      state: "active",
      binding: {
        threadId,
        cwd: "",
        dynamicToolsFingerprint: rawFingerprint,
      },
    };
    const rawSession: StoredCodexAppServerBinding = {
      ...rawConversation,
      sessionId,
    };
    expect(Buffer.byteLength(JSON.stringify(rawSession))).toBeLessThan(65_536);

    const fixture = await createBindingMigrationFixture({
      name: sessionId,
      sessionIndex: {
        [sessionKey]: {
          sessionId,
          sessionFile: `${sessionId}.jsonl`,
        },
      },
      threadId,
      binding: { dynamicToolsFingerprint: rawFingerprint },
    });
    const conversationKey = bindingStoreKey({
      kind: "conversation",
      bindingId: legacyCodexConversationBindingId(fixture.transcriptPath),
    });
    const sessionBindingKey = bindingStoreKey({
      kind: "session",
      agentId: "main",
      sessionId,
      sessionKey,
    });
    const store = openBindingStore(fixture.env);
    await store.register(conversationKey, rawConversation);
    await store.register(sessionBindingKey, rawSession);

    await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
      changes: [
        "Migrated 1 Codex app-server binding sidecar(s) to plugin state and archived the legacy sources",
      ],
      warnings: [],
    });

    const expectedFingerprint = hashCodexAppServerBindingFingerprint(rawFingerprint);
    await expect(store.lookup(conversationKey)).resolves.toMatchObject({
      state: "active",
      binding: { dynamicToolsFingerprint: expectedFingerprint },
    });
    await expect(store.lookup(sessionBindingKey)).resolves.toMatchObject({
      state: "active",
      sessionId,
      binding: { dynamicToolsFingerprint: expectedFingerprint },
    });
    await expect(fs.access(fixture.sidecarPath)).rejects.toThrow();
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();
    await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
      changes: [],
      warnings: [],
    });

    await fs.rm(fixture.stateDir, { recursive: true, force: true });
  });

  it("rejects an explicit session file locator outside the session directory", async () => {
    const sessionKey = "agent:main:stale-locator";
    const fixture = await createBindingMigrationFixture({
      name: "stale-locator",
      sessionIndex: {
        [sessionKey]: {
          sessionId: "stale-locator",
          sessionFile: "../outside.jsonl",
        },
      },
      threadId: "thread-stale-locator",
    });

    const result = await fixture.migration.migrateLegacyState(fixture.params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("invalid locator");
    await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).rejects.toThrow();
    expect(
      getSessionEntry({
        agentId: "main",
        env: fixture.env,
        sessionKey,
        storePath: fixture.storePath,
      }),
    ).toBeUndefined();
    await expect(openBindingStore(fixture.env).entries()).resolves.toEqual([]);

    await fs.rm(fixture.stateDir, { recursive: true, force: true });
  });

  it("deduplicates session-store aliases before classifying binding ownership", async () => {
    const fixture = await createBindingMigrationFixture({
      name: "aliased-store",
      sessionIndex: {
        "agent:main:aliased-store": {
          sessionId: "aliased-store",
          sessionFile: "aliased-store.jsonl",
        },
      },
      threadId: "thread-aliased-store",
    });
    await fs.writeFile(
      path.join(fixture.sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:aliased-store": {
          sessionId: "aliased-store",
          sessionFile: fixture.transcriptPath,
        },
      }),
      "utf8",
    );
    const storeAlias = path.join(fixture.stateDir, "sessions-alias.json");
    await fs.symlink(path.join(fixture.sessionsDir, "sessions.json"), storeAlias);

    const result = await fixture.migration.migrateLegacyState({
      ...fixture.params,
      config: { session: { store: storeAlias } },
    });

    expect(result.warnings).toEqual([]);
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();
    const configuredIndex = JSON.parse(await fs.readFile(storeAlias, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    const targetIndex = JSON.parse(
      await fs.readFile(path.join(fixture.sessionsDir, "sessions.json"), "utf8"),
    ) as Record<string, Record<string, unknown>>;
    expect(
      getSessionEntry({
        agentId: "main",
        env: fixture.env,
        sessionKey: "agent:main:aliased-store",
        storePath: storeAlias,
      }),
    ).toMatchObject({ agentHarnessId: "codex" });
    expect(configuredIndex["agent:main:aliased-store"]).not.toHaveProperty("agentHarnessId");
    expect(targetIndex["agent:main:aliased-store"]).not.toHaveProperty("agentHarnessId");

    await fs.rm(fixture.stateDir, { recursive: true, force: true });
  });

  it("resolves relative session files from a symlinked store path", async () => {
    const sessionKey = "agent:main:symlinked-store";
    const fixture = await createBindingMigrationFixture({
      name: "symlinked-store",
      sessionIndex: {
        [sessionKey]: {
          sessionId: "symlinked-store",
          sessionFile: "symlinked-store.jsonl",
        },
      },
      threadId: "thread-symlinked-store",
    });
    const configuredDir = path.join(fixture.stateDir, "configured-sessions");
    const configuredStore = path.join(configuredDir, "sessions.json");
    const configuredTranscript = path.join(configuredDir, "symlinked-store.jsonl");
    const configuredSidecar = `${configuredTranscript}.codex-app-server.json`;
    await fs.mkdir(configuredDir, { recursive: true });
    await fs.rename(fixture.transcriptPath, configuredTranscript);
    await fs.rename(fixture.sidecarPath, configuredSidecar);
    const sidecar = JSON.parse(await fs.readFile(configuredSidecar, "utf8")) as Record<
      string,
      unknown
    >;
    await fs.writeFile(
      configuredSidecar,
      JSON.stringify({ ...sidecar, sessionFile: configuredTranscript }),
      "utf8",
    );
    await fs.symlink(path.join(fixture.sessionsDir, "sessions.json"), configuredStore);

    const result = await fixture.migration.migrateLegacyState({
      ...fixture.params,
      config: { session: { store: configuredStore } },
    });

    expect(result.warnings).toEqual([]);
    await expect(fs.access(`${configuredSidecar}.migrated`)).resolves.toBeUndefined();
    expect(
      getSessionEntry({
        agentId: "main",
        env: fixture.env,
        sessionKey,
        storePath: configuredStore,
      }),
    ).toMatchObject({ agentHarnessId: "codex" });
    await expect(fs.readFile(configuredStore, "utf8").then(JSON.parse)).resolves.not.toHaveProperty(
      `${sessionKey}.agentHarnessId`,
    );

    await fs.rm(fixture.stateDir, { recursive: true, force: true });
  });

  it.each([
    { label: "new", preexisting: false },
    { label: "pre-existing", preexisting: true },
  ])(
    "retires a $label session row when its owner rebinds during migration",
    async ({ preexisting }) => {
      const sessionKey = "agent:main:session-1";
      const fixture = await createBindingMigrationFixture({
        name: "session-current",
        sessionIndex: {
          [sessionKey]: {
            sessionId: "session-current",
            sessionFile: "session-current.jsonl",
            lifecycleRevision: "rev-1",
          },
        },
        threadId: "thread-1",
      });
      const sessionBindingKey = bindingStoreKey({
        kind: "session",
        agentId: "main",
        sessionId: "session-current",
        sessionKey,
      });
      const imported = createStoredCodexAppServerBinding(
        JSON.parse(await fs.readFile(fixture.sidecarPath, "utf8")),
      );
      if (!imported) {
        throw new Error("missing imported Codex binding");
      }
      const store = openBindingStore(fixture.env);
      if (preexisting) {
        await store.register(sessionBindingKey, { ...imported, sessionId: "session-current" });
      }
      let rebound = false;
      const context = createDoctorContext(fixture.env, async () => {
        if (rebound) {
          return;
        }
        rebound = true;
        await upsertSessionEntry({
          agentId: "main",
          env: fixture.env,
          sessionKey,
          storePath: fixture.storePath,
          entry: {
            sessionId: "session-current",
            lifecycleRevision: "rev-2",
            updatedAt: Date.now(),
          },
        });
      });

      const result = await fixture.migration.migrateLegacyState({ ...fixture.params, context });

      expect(result.warnings).toEqual([
        expect.stringContaining("session owner changed before Codex ownership could be recorded"),
      ]);
      await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
      await expect(fs.access(`${fixture.sidecarPath}.migrated`)).rejects.toThrow();
      await expect(
        fs.readFile(path.join(fixture.sessionsDir, "sessions.json"), "utf8").then(JSON.parse),
      ).resolves.not.toHaveProperty(`${sessionKey}.agentHarnessId`);
      expect(
        getSessionEntry({
          agentId: "main",
          env: fixture.env,
          sessionKey,
          storePath: fixture.storePath,
        }),
      ).toMatchObject({ lifecycleRevision: "rev-2" });
      await expect(store.lookup(sessionBindingKey)).resolves.toMatchObject({
        version: 1,
        state: "cleared",
        sessionId: "session-current",
        retired: true,
      });

      await fs.rm(fixture.stateDir, { recursive: true, force: true });
    },
  );

  it("retires an imported row when its locator escapes during owner revalidation", async () => {
    const sessionKey = "agent:main:locator-race";
    const fixture = await createBindingMigrationFixture({
      name: "locator-race",
      sessionIndex: {
        [sessionKey]: {
          sessionId: "locator-race",
          sessionFile: "locator-race.jsonl",
        },
      },
      threadId: "thread-locator-race",
    });
    let rebound = false;
    const context = createDoctorContext(fixture.env, async () => {
      if (rebound) {
        return;
      }
      rebound = true;
      await fs.writeFile(
        fixture.storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "locator-race",
            sessionFile: "../outside.jsonl",
          },
        }),
      );
    });

    const result = await fixture.migration.migrateLegacyState({ ...fixture.params, context });

    expect(result.warnings).toEqual([
      expect.stringContaining("session owner changed before Codex ownership could be recorded"),
    ]);
    await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).rejects.toThrow();
    await expect(
      openBindingStore(fixture.env).lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "main",
          sessionId: "locator-race",
          sessionKey,
        }),
      ),
    ).resolves.toMatchObject({
      version: 1,
      state: "cleared",
      sessionId: "locator-race",
      retired: true,
    });

    await fs.rm(fixture.stateDir, { recursive: true, force: true });
  });

  it("does not resurrect a retired session generation from its legacy sidecar", async () => {
    const sessionKey = "agent:main:retired";
    const fixture = await createBindingMigrationFixture({
      name: "retired",
      sessionIndex: {
        [sessionKey]: {
          sessionId: "retired",
          sessionFile: "retired.jsonl",
        },
      },
      threadId: "thread-retired",
    });
    const store = openBindingStore(fixture.env);
    const active = createStoredCodexAppServerBinding(
      JSON.parse(await fs.readFile(fixture.sidecarPath, "utf8")),
    );
    if (!active) {
      throw new Error("missing imported Codex binding");
    }
    await store.register(
      bindingStoreKey({
        kind: "conversation",
        bindingId: legacyCodexConversationBindingId(fixture.transcriptPath),
      }),
      active,
    );
    const sessionBindingKey = bindingStoreKey({
      kind: "session",
      agentId: "main",
      sessionId: "retired",
      sessionKey,
    });
    const retired: StoredCodexAppServerBinding = {
      version: 1,
      state: "cleared",
      sessionId: "retired",
      retired: true,
    };
    await store.register(sessionBindingKey, retired);

    const result = await fixture.migration.migrateLegacyState(fixture.params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(`canonical plugin state changed at ${sessionBindingKey}`),
    ]);
    await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
    await expect(store.lookup(sessionBindingKey)).resolves.toEqual(retired);
    await expect(
      fs.readFile(path.join(fixture.sessionsDir, "sessions.json"), "utf8").then(JSON.parse),
    ).resolves.not.toHaveProperty(`${sessionKey}.agentHarnessId`);

    await fs.rm(fixture.stateDir, { recursive: true, force: true });
  });

  it.each(["active", "cleared"] as const)(
    "archives zero-owner sidecars without changing imported $state conversation state",
    async (state) => {
      const fixture = await createBindingMigrationFixture({
        name: `orphan-${state}`,
        threadId: "thread-orphan",
      });
      const bindingKey = bindingStoreKey({
        kind: "conversation",
        bindingId: legacyCodexConversationBindingId(fixture.transcriptPath),
      });
      const active = createStoredCodexAppServerBinding(
        JSON.parse(await fs.readFile(fixture.sidecarPath, "utf8")),
      );
      if (!active) {
        throw new Error("missing imported Codex binding");
      }
      const existing: StoredCodexAppServerBinding =
        state === "active" ? active : { version: 1, state: "cleared", retired: true };
      const store = openBindingStore(fixture.env);
      await store.register(bindingKey, existing);

      await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
        changes: [
          "Migrated 1 Codex app-server binding sidecar(s) to plugin state and archived the legacy sources",
        ],
        warnings: [],
      });
      await expect(fs.access(fixture.sidecarPath)).rejects.toThrow();
      await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();
      await expect(store.lookup(bindingKey)).resolves.toEqual(existing);
      await expect(fixture.migration.detectLegacyState(fixture.params)).resolves.toBeNull();
      await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
        changes: [],
        warnings: [],
      });

      await fs.rm(fixture.stateDir, { recursive: true, force: true });
    },
  );

  it("ignores metadata-only session rows when proving zero ownership", async () => {
    const fixture = await createBindingMigrationFixture({
      name: "orphan-metadata-row",
      sessionIndex: {
        "agent:main:metadata-only": {
          label: "Waiting for first turn",
          updatedAt: 1,
        },
      },
      threadId: "thread-orphan",
    });

    await expect(fixture.migration.migrateLegacyState(fixture.params)).resolves.toEqual({
      changes: [
        "Migrated 1 Codex app-server binding sidecar(s) to plugin state and archived the legacy sources",
      ],
      warnings: [],
    });
    await expect(fs.access(fixture.sidecarPath)).rejects.toThrow();
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();

    await fs.rm(fixture.stateDir, { recursive: true, force: true });
  });

  it("retains a zero-owner sidecar when canonical plugin state is malformed", async () => {
    const fixture = await createBindingMigrationFixture({
      name: "orphan-invalid-state",
      threadId: "thread-orphan",
    });
    const bindingKey = bindingStoreKey({
      kind: "conversation",
      bindingId: legacyCodexConversationBindingId(fixture.transcriptPath),
    });
    const store = createDoctorContext(fixture.env).openPluginStateKeyedStore<unknown>({
      namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const malformed = { version: 1, state: "active" };
    await store.register(bindingKey, malformed);

    const result = await fixture.migration.migrateLegacyState(fixture.params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining(`canonical plugin state is invalid at ${bindingKey}`),
    ]);
    await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
    await expect(store.lookup(bindingKey)).resolves.toEqual(malformed);

    await fs.rm(fixture.stateDir, { recursive: true, force: true });
  });

  it("retains mixed Codex and foreign ambiguous binding owners", async () => {
    const fixture = await createBindingMigrationFixture({
      name: "shared",
      sessionIndex: {
        "agent:main:first": {
          sessionId: "first",
          sessionFile: "shared.jsonl",
          agentHarnessId: "codex",
        },
        "agent:main:second": {
          sessionId: "second",
          sessionFile: "shared.jsonl",
          agentHarnessId: "pi",
        },
      },
      threadId: "thread-shared",
    });

    const result = await fixture.migration.migrateLegacyState(fixture.params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("2 matching session owners make ownership ambiguous");
    await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
    await expect(openBindingStore(fixture.env).entries()).resolves.toEqual([]);

    await fs.rm(fixture.stateDir, { recursive: true, force: true });
  });

  it("retains a sidecar owned by a foreign harness without importing plugin state", async () => {
    const fixture = await createBindingMigrationFixture({
      name: "foreign",
      sessionIndex: {
        "agent:main:foreign": {
          sessionId: "foreign",
          sessionFile: "foreign.jsonl",
          agentHarnessId: "pi",
        },
      },
      threadId: "thread-foreign",
    });

    const result = await fixture.migration.migrateLegacyState(fixture.params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("owned by agent harness pi")]);
    await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
    await expect(openBindingStore(fixture.env).entries()).resolves.toEqual([]);

    await fs.rm(fixture.stateDir, { recursive: true, force: true });
  });

  it.each([
    { contents: "{", detail: "invalid JSON", label: "invalid JSON" },
    {
      contents: JSON.stringify({
        "agent:main:invalid": { sessionId: "invalid", agentHarnessId: 42 },
      }),
      detail: "invalid entries",
      label: "malformed harness metadata",
    },
    {
      contents: JSON.stringify({
        "agent:main:unsafe": { sessionId: "../unsafe", sessionFile: "unsafe.jsonl" },
      }),
      detail: "invalid entries",
      label: "unsafe session id",
    },
  ])("retains binding sidecars for an indeterminate $label index", async ({ contents, detail }) => {
    const fixture = await createBindingMigrationFixture({
      name: "unknown-owner",
      threadId: "thread-unknown-owner",
    });
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-store-"));
    const externalStore = path.join(externalDir, "sessions.json");
    await fs.writeFile(externalStore, contents, "utf8");
    const params = {
      ...fixture.params,
      config: { session: { store: externalStore } },
    };

    const result = await fixture.migration.migrateLegacyState(params);

    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("session index");
    expect(result.warnings[0]).toContain(detail);
    await expect(fs.access(fixture.sidecarPath)).resolves.toBeUndefined();
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).rejects.toThrow();
    await expect(openBindingStore(fixture.env).entries()).resolves.toEqual([]);

    await Promise.all([
      fs.rm(fixture.stateDir, { recursive: true, force: true }),
      fs.rm(externalDir, { recursive: true, force: true }),
    ]);
  });

  it("does not scan above stateDir or follow escaped external store locators", async () => {
    const outerDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-outer-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-outside-"));
    const stateDir = path.join(outerDir, "state");
    await fs.mkdir(stateDir, { recursive: true });
    const strayDir = path.join(outerDir, "unrelated");
    await fs.mkdir(strayDir, { recursive: true });
    const externalStore = path.join(outerDir, "sessions.json");
    await fs.writeFile(
      path.join(strayDir, "foreign.jsonl.codex-app-server.json"),
      JSON.stringify({ schemaVersion: 2, threadId: "thread-foreign" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(outsideDir, "foreign.jsonl.codex-app-server.json"),
      JSON.stringify({ schemaVersion: 2, threadId: "thread-escaped" }),
      "utf8",
    );
    await fs.symlink(outsideDir, path.join(outerDir, "escaped"));
    await fs.writeFile(
      externalStore,
      JSON.stringify({
        "agent:main:foreign": {
          sessionId: "foreign",
          // The transcript is missing, but the sidecar exists through an
          // escaping symlink. Containment must resolve the existing ancestor.
          sessionFile: "escaped/foreign.jsonl",
        },
      }),
      "utf8",
    );
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const params = {
      // The store directory is exactly stateDir's parent. It stays indexed-only,
      // and its explicit locator cannot escape that directory.
      config: { session: { store: externalStore } },
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("missing Codex binding migration");
    }

    await expect(migration.detectLegacyState(params)).resolves.toBeNull();

    await Promise.all([
      fs.rm(outerDir, { recursive: true, force: true }),
      fs.rm(outsideDir, { recursive: true, force: true }),
    ]);
  });

  it("renames old approval-routed destructive plugin policy values", () => {
    const original = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexDynamicToolsProfile: "openclaw-compat",
              codexPlugins: {
                enabled: true,
                allow_destructive_actions: "on-request",
                plugins: {
                  "google-calendar": {
                    enabled: true,
                    allow_destructive_actions: "on-request",
                  },
                  slack: {
                    enabled: true,
                    allow_destructive_actions: false,
                  },
                },
              },
            },
          },
        },
      },
    };

    const result = normalizeCompatibilityConfig({ cfg: original });

    expect(result.changes).toEqual([
      "Removed retired plugins.entries.codex.config.codexDynamicToolsProfile; Codex app-server always keeps Codex-native workspace tools native.",
      'Renamed plugins.entries.codex.config.codexPlugins allow_destructive_actions="on-request" values to "auto".',
    ]);
    expect(result.config.plugins?.entries?.codex?.config).toEqual({
      codexPlugins: {
        enabled: true,
        allow_destructive_actions: "auto",
        plugins: {
          "google-calendar": {
            enabled: true,
            allow_destructive_actions: "auto",
          },
          slack: {
            enabled: true,
            allow_destructive_actions: false,
          },
        },
      },
    });
    expect(
      original.plugins.entries.codex.config.codexPlugins.plugins["google-calendar"]
        .allow_destructive_actions,
    ).toBe("on-request");
  });

  it("renames the retired app-server on-failure approval policy", () => {
    const original = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              appServer: {
                approvalPolicy: "on-failure",
                sandbox: "workspace-write",
              },
            },
          },
        },
      },
    };

    const result = normalizeCompatibilityConfig({ cfg: original });

    expect(result.changes).toEqual([
      'Renamed plugins.entries.codex.config.appServer.approvalPolicy="on-failure" to "on-request".',
    ]);
    expect(result.config.plugins?.entries?.codex?.config).toEqual({
      appServer: {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
    });
    expect(original.plugins.entries.codex.config.appServer.approvalPolicy).toBe("on-failure");
  });
});
