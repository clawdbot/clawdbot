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
  const transcriptPath = path.join(sessionsDir, `${options.name}.jsonl`);
  const sidecarPath = `${transcriptPath}.codex-app-server.json`;
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({ type: "session", id: options.name })}\n`,
    "utf8",
  );
  if (options.sessionIndex !== undefined) {
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify(options.sessionIndex),
      "utf8",
    );
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
    await expect(
      fs.readFile(path.join(fixture.sessionsDir, "sessions.json"), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      "agent:main:session-1": { sessionId: "session-current", agentHarnessId: "codex" },
    });

    await fs.rm(fixture.stateDir, { recursive: true, force: true });
  });

  it("matches an owner through the contained fallback for a stale session file locator", async () => {
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

    expect(result.warnings).toEqual([]);
    await expect(fs.access(`${fixture.sidecarPath}.migrated`)).resolves.toBeUndefined();
    await expect(
      fs.readFile(path.join(fixture.sessionsDir, "sessions.json"), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({ [sessionKey]: { agentHarnessId: "codex" } });
    await expect(
      openBindingStore(fixture.env).lookup(
        bindingStoreKey({
          kind: "session",
          agentId: "main",
          sessionId: "stale-locator",
          sessionKey,
        }),
      ),
    ).resolves.toMatchObject({ state: "active", binding: { threadId: "thread-stale-locator" } });

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
    expect(configuredIndex["agent:main:aliased-store"]).toMatchObject({
      agentHarnessId: "codex",
    });
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
    await expect(fs.readFile(configuredStore, "utf8").then(JSON.parse)).resolves.toMatchObject({
      [sessionKey]: { agentHarnessId: "codex" },
    });

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
        await fs.writeFile(
          path.join(fixture.sessionsDir, "sessions.json"),
          JSON.stringify({
            [sessionKey]: {
              sessionId: "session-current",
              sessionFile: "replacement.jsonl",
              lifecycleRevision: "rev-2",
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
        fs.readFile(path.join(fixture.sessionsDir, "sessions.json"), "utf8").then(JSON.parse),
      ).resolves.not.toHaveProperty(`${sessionKey}.agentHarnessId`);
      await expect(store.lookup(sessionBindingKey)).resolves.toMatchObject({
        version: 1,
        state: "cleared",
        sessionId: "session-current",
        retired: true,
      });

      await fs.rm(fixture.stateDir, { recursive: true, force: true });
    },
  );

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
    await fs.writeFile(
      externalStore,
      JSON.stringify({
        "agent:main:foreign": {
          sessionId: "foreign",
          sessionFile: path.join(outsideDir, "foreign.jsonl"),
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
