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
  type StoredCodexAppServerBinding,
} from "./src/app-server/session-binding.js";
import { legacyCodexConversationBindingId } from "./src/conversation-binding-data.js";

function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("codex", {
        ...options,
        env: options.env ?? env,
      });
    },
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
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const transcriptPath = path.join(sessionsDir, "session-current.jsonl");
    const sidecarPath = `${transcriptPath}.codex-app-server.json`;
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(transcriptPath, '{"type":"session","id":"session-current"}\n', "utf8");
    await fs.writeFile(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({
        "agent:main:session-1": {
          sessionId: "session-current",
          sessionFile: "session-current.jsonl",
          updatedAt: Date.now(),
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({
        schemaVersion: 2,
        threadId: "thread-1",
        sessionFile: transcriptPath,
        updatedAt: "2026-01-01T00:00:00.000Z",
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
      }),
      "utf8",
    );
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("missing Codex binding migration");
    }

    await expect(migration.detectLegacyState(params)).resolves.toMatchObject({
      preview: [expect.stringContaining("legacy sidecar")],
    });
    await expect(migration.migrateLegacyState(params)).resolves.toMatchObject({
      changes: [expect.stringContaining("Migrated 1")],
      warnings: [],
    });

    const store = createDoctorContext(env).openPluginStateKeyedStore<StoredCodexAppServerBinding>({
      namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
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
          bindingId: legacyCodexConversationBindingId(transcriptPath),
        }),
      ),
    ).resolves.toMatchObject({ state: "active", binding: { threadId: "thread-1" } });
    await expect(fs.access(`${sidecarPath}.migrated`)).resolves.toBeUndefined();
    await expect(
      fs.readFile(path.join(sessionsDir, "sessions.json"), "utf8").then(JSON.parse),
    ).resolves.toMatchObject({
      "agent:main:session-1": { sessionId: "session-current", agentHarnessId: "codex" },
    });

    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("reports unresolved-owner binding sidecars as notices after importing conversation binding", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-"));
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    const transcriptPath = path.join(sessionsDir, "orphan.jsonl");
    const sidecarPath = `${transcriptPath}.codex-app-server.json`;
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({
        schemaVersion: 2,
        threadId: "thread-orphan",
        sessionFile: transcriptPath,
        updatedAt: "2026-01-01T00:00:00.000Z",
        pluginAppPolicyContext: {
          fingerprint: "policy-1",
          apps: {},
          pluginAppIds: {},
        },
      }),
      "utf8",
    );
    const params = {
      config: {},
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: createDoctorContext(env),
    };
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("missing Codex binding migration");
    }

    const result = await migration.migrateLegacyState(params);
    const canonicalSidecarPath = await fs.realpath(sidecarPath);

    expect(result.warnings).toStrictEqual([]);
    expect(result.notices).toStrictEqual([
      `Left Codex binding sidecar in place after importing its conversation binding because its session owner could not be resolved: ${canonicalSidecarPath}`,
    ]);
    expect(result.changes).toContain(
      "Migrated 1 safe Codex app-server binding row(s) to plugin state; retained legacy sidecars needing review",
    );
    await expect(fs.access(sidecarPath)).resolves.toBeUndefined();
    const store = createDoctorContext(env).openPluginStateKeyedStore<StoredCodexAppServerBinding>({
      namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await expect(
      store.lookup(
        bindingStoreKey({
          kind: "conversation",
          bindingId: legacyCodexConversationBindingId(transcriptPath),
        }),
      ),
    ).resolves.toMatchObject({ state: "active", binding: { threadId: "thread-orphan" } });

    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("does not scan above stateDir when a session store sits at its parent", async () => {
    const outerDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-doctor-outer-"));
    const stateDir = path.join(outerDir, "state");
    await fs.mkdir(stateDir, { recursive: true });
    const strayDir = path.join(outerDir, "unrelated");
    await fs.mkdir(strayDir, { recursive: true });
    await fs.writeFile(
      path.join(strayDir, "foreign.jsonl.codex-app-server.json"),
      JSON.stringify({ schemaVersion: 2, threadId: "thread-foreign" }),
      "utf8",
    );
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const params = {
      // The store dir is exactly the parent of stateDir; doctor must treat it
      // as an external store (indexed reads only), not a scannable state root.
      config: { session: { store: path.join(outerDir, "sessions.json") } },
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

    await fs.rm(outerDir, { recursive: true, force: true });
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
