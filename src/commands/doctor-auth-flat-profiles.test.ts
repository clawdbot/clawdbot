// Doctor flat auth-profile tests cover legacy flat profile repair and persisted auth-profile loading.
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  collectOpenAICodexAuthProfileStoreIdMap,
  maybeMigrateAuthProfileJsonStoresToSqlite,
  maybeRepairLegacyFlatAuthProfileStores,
  maybeRepairOpenAICodexAuthConfig,
  maybeRepairOpenAICodexAuthProfileStores,
} from "./doctor-auth-flat-profiles.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const states: OpenClawTestState[] = [];

function makePrompter(shouldRepair: boolean): DoctorPrompter {
  return {
    confirm: vi.fn(async () => shouldRepair),
    confirmAutoFix: vi.fn(async () => shouldRepair),
    confirmAggressiveAutoFix: vi.fn(async () => shouldRepair),
    confirmRuntimeRepair: vi.fn(async () => shouldRepair),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair,
    shouldForce: false,
    repairMode: {
      shouldRepair,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
      updateInProgress: false,
    },
  };
}

async function makeTestState(): Promise<OpenClawTestState> {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-flat-auth-",
    env: {
      OPENCLAW_AGENT_DIR: undefined,
    },
  });
  states.push(state);
  return state;
}

async function writeLegacyAuthProfilesJson(
  state: OpenClawTestState,
  value: unknown,
  agentId = "main",
): Promise<string> {
  return await state.writeText(
    `agents/${agentId}/agent/auth-profiles.json`,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("maybeMigrateAuthProfileJsonStoresToSqlite", () => {
  it("imports legacy JSON auth profiles and state into the agent sqlite database", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-migrated",
        },
      },
    });
    const statePath = await state.writeText(
      "agents/main/agent/auth-state.json",
      `${JSON.stringify({ version: 1, lastGood: { openai: "openai:default" } })}\n`,
    );

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 456,
    });

    expect(result.detected.toSorted()).toEqual([authPath, statePath].toSorted());
    expect(result.warnings).toStrictEqual([]);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toMatchObject({
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-migrated",
        },
      },
      lastGood: { openai: "openai:default" },
    });
    expect(fs.existsSync(authPath)).toBe(false);
    expect(fs.existsSync(statePath)).toBe(false);
    expect(fs.existsSync(`${authPath}.sqlite-import.456.bak`)).toBe(true);
    expect(fs.existsSync(`${statePath}.sqlite-import.456.bak`)).toBe(true);
  });

  it("moves legacy aws-sdk auth markers to config before removing JSON", async () => {
    const state = await makeTestState();
    const cfg = {};
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "amazon-bedrock:default": {
          type: "aws-sdk",
          provider: "amazon-bedrock",
        },
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          key: "sk-openrouter",
        },
      },
    });

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg,
      prompter: makePrompter(true),
      now: () => 457,
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.configChanged).toBe(true);
    expect(result.warnings).toStrictEqual([]);
    expect(cfg).toEqual({
      auth: {
        profiles: {
          "amazon-bedrock:default": {
            provider: "amazon-bedrock",
            mode: "aws-sdk",
          },
        },
      },
    });
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toEqual({
      "openrouter:default": {
        type: "api_key",
        provider: "openrouter",
        key: "sk-openrouter",
      },
    });
    expect(fs.existsSync(authPath)).toBe(false);
    expect(fs.existsSync(`${authPath}.sqlite-import.457.bak`)).toBe(true);
  });

  it("preserves state-only legacy auth state for inherited profiles", async () => {
    const state = await makeTestState();
    const statePath = await state.writeText(
      "agents/main/agent/auth-state.json",
      `${JSON.stringify({
        version: 1,
        order: { openai: ["openai:default"] },
        lastGood: { openai: "openai:default" },
        usageStats: {
          "openai:default": {
            errorCount: 2,
            lastFailureAt: 123,
          },
        },
      })}\n`,
    );
    const authPath = state.path("agents/main/agent/auth-profiles.json");

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 459,
    });

    expect(result.detected).toEqual([statePath]);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toMatchObject({
      profiles: {},
      order: { openai: ["openai:default"] },
      lastGood: { openai: "openai:default" },
      usageStats: {
        "openai:default": {
          errorCount: 2,
          lastFailureAt: 123,
        },
      },
    });
    expect(fs.existsSync(statePath)).toBe(false);
    expect(fs.existsSync(`${statePath}.sqlite-import.459.bak`)).toBe(true);
    expect(fs.existsSync(authPath)).toBe(false);
  });

  it("leaves unresolved legacy OAuth sidecar refs in JSON", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai:user@example.com": {
          type: "oauth",
          provider: "openai",
          email: "user@example.com",
          oauthRef: {
            id: "0123456789abcdef0123456789abcdef",
            provider: "openai",
          },
        },
      },
    });

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 460,
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("legacy OAuth sidecar profile"),
      expect.stringContaining("no importable auth profiles or state"),
    ]);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toBeNull();
    expect(fs.existsSync(authPath)).toBe(true);
    expect(fs.existsSync(`${authPath}.sqlite-import.460.bak`)).toBe(false);
  });

  it("imports valid profiles when one legacy OAuth sidecar ref is unresolved", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-imported",
        },
        "openai:user@example.com": {
          type: "oauth",
          provider: "openai",
          email: "user@example.com",
          oauthRef: {
            id: "0123456789abcdef0123456789abcdef",
            provider: "openai",
          },
        },
      },
      order: { openai: ["openai:default", "openai:user@example.com"] },
      lastGood: { openai: "openai:default" },
    });

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 463,
    });

    expect(result.changes).toEqual([expect.stringContaining("Migrated auth profile JSON")]);
    expect(result.warnings).toEqual([expect.stringContaining("legacy OAuth sidecar profile")]);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toMatchObject({
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-imported",
        },
      },
      order: { openai: ["openai:default"] },
      lastGood: { openai: "openai:default" },
    });
    expect(fs.existsSync(authPath)).toBe(true);
    expect(fs.existsSync(`${authPath}.sqlite-import.463.bak`)).toBe(true);
    const remaining = JSON.parse(fs.readFileSync(authPath, "utf8"));
    expect(remaining.profiles).toEqual({
      "openai:user@example.com": {
        type: "oauth",
        provider: "openai",
        email: "user@example.com",
        oauthRef: {
          id: "0123456789abcdef0123456789abcdef",
          provider: "openai",
        },
      },
    });
    expect(remaining.order).toEqual({ openai: ["openai:user@example.com"] });
    expect(remaining.lastGood).toBeUndefined();
  });

  it("keeps existing SQLite credentials when importing stale JSON", async () => {
    const state = await makeTestState();
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-fresh-sqlite",
          },
        },
      },
      state.agentDir(),
      { syncExternalCli: false },
    );
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-stale-json",
        },
      },
    });

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 461,
    });

    expect(result.detected).toEqual([authPath]);
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles["openai:default"]).toEqual({
      type: "api_key",
      provider: "openai",
      key: "sk-fresh-sqlite",
    });
    expect(fs.existsSync(authPath)).toBe(false);
    expect(fs.existsSync(`${authPath}.sqlite-import.461.bak`)).toBe(true);
  });

  it("keeps auth-state.json precedence over auth-profiles.json state during import", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-openai",
        },
        "openai:work": {
          type: "api_key",
          provider: "openai",
          key: "sk-work",
        },
      },
      order: { openai: ["openai:default"] },
    });
    const statePath = await state.writeText(
      "agents/main/agent/auth-state.json",
      `${JSON.stringify({ version: 1, order: { openai: ["openai:work"] } })}\n`,
    );

    await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 462,
    });

    expect(loadPersistedAuthProfileStore(state.agentDir())?.order).toEqual({
      openai: ["openai:work"],
    });
    expect(fs.existsSync(authPath)).toBe(false);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("imports legacy api_key alias fields before removing JSON", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          api_key: "sk-openrouter-legacy",
        },
      },
    });

    await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 458,
    });

    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toEqual({
      "openrouter:default": {
        type: "api_key",
        provider: "openrouter",
        key: "sk-openrouter-legacy",
      },
    });
    expect(fs.existsSync(authPath)).toBe(false);
    expect(fs.existsSync(`${authPath}.sqlite-import.458.bak`)).toBe(true);
  });

  it("keeps legacy JSON when SQLite verification misses an imported profile", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          key: "sk-openrouter",
        },
      },
    });

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 464,
      deps: {
        loadPersistedAuthProfileStore: () => ({
          version: 1,
          profiles: {},
        }),
      },
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([
      `Left auth profile JSON in place for ${authPath} because SQLite verification did not find imported profile(s): openrouter:default.`,
    ]);
    expect(fs.existsSync(authPath)).toBe(true);
    expect(fs.existsSync(`${authPath}.sqlite-import.464.bak`)).toBe(false);
  });

  it("imports default-agent config auth profiles into sqlite when no legacy files exist", async () => {
    const state = await makeTestState();
    const cfg = {
      auth: {
        profiles: {
          "openai:default": {
            provider: "openai",
            mode: "api_key",
            key: "sk-config",
          },
          "anthropic:default": {
            provider: "anthropic",
            mode: "token",
            token: {
              source: "env",
              provider: "default",
              id: "ANTHROPIC_TOKEN",
            },
          },
          "router:default": {
            provider: "router",
            mode: "api_key",
            displayName: "routing only",
          },
        },
        order: {
          openai: ["openai:default"],
          anthropic: ["anthropic:default"],
        },
      },
    } as OpenClawConfig;

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg,
      prompter: makePrompter(true),
      now: () => 465,
    });

    const authPath = `${state.agentDir()}/auth-profiles.json`;
    expect(result.detected).toEqual([authPath]);
    expect(result.configChanged).toBe(true);
    expect(result.warnings).toStrictEqual([]);
    expect(cfg.auth?.profiles?.["openai:default"]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
    expect(cfg.auth?.profiles?.["anthropic:default"]).toEqual({
      provider: "anthropic",
      mode: "token",
    });
    expect(cfg.auth?.profiles?.["router:default"]).toEqual({
      provider: "router",
      mode: "api_key",
      displayName: "routing only",
    });
    expect(cfg.auth?.order).toEqual({
      openai: ["openai:default"],
      anthropic: ["anthropic:default"],
    });
    expect(loadPersistedAuthProfileStore(state.agentDir())).toMatchObject({
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-config",
        },
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          tokenRef: {
            source: "env",
            provider: "default",
            id: "ANTHROPIC_TOKEN",
          },
        },
      },
    });
    expect(
      loadPersistedAuthProfileStore(state.agentDir())?.profiles["router:default"],
    ).toBeUndefined();
    expect(loadPersistedAuthProfileStore(state.agentDir())?.order).toBeUndefined();
    expect(fs.existsSync(authPath)).toBe(false);
    expect(fs.existsSync(`${authPath}.sqlite-import.465.bak`)).toBe(false);
  });

  it("imports default-agent config auth profiles when only legacy state exists", async () => {
    const state = await makeTestState();
    const statePath = await state.writeText(
      "agents/main/agent/auth-state.json",
      `${JSON.stringify({
        version: 1,
        order: { openai: ["openai:default"] },
        lastGood: { openai: "openai:default" },
      })}\n`,
    );
    const cfg = {
      auth: {
        profiles: {
          "openai:default": {
            provider: "openai",
            mode: "api_key",
            key: "sk-config",
          },
        },
      },
    } as OpenClawConfig;

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg,
      prompter: makePrompter(true),
      now: () => 467,
    });

    const authPath = `${state.agentDir()}/auth-profiles.json`;
    expect(result.detected.toSorted()).toEqual([authPath, statePath].toSorted());
    expect(result.configChanged).toBe(true);
    expect(result.warnings).toStrictEqual([]);
    expect(cfg.auth?.profiles?.["openai:default"]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
    expect(loadPersistedAuthProfileStore(state.agentDir())).toMatchObject({
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-config",
        },
      },
      order: { openai: ["openai:default"] },
      lastGood: { openai: "openai:default" },
    });
    expect(fs.existsSync(statePath)).toBe(false);
    expect(fs.existsSync(`${statePath}.sqlite-import.467.bak`)).toBe(true);
    expect(fs.existsSync(authPath)).toBe(false);
    expect(fs.existsSync(`${authPath}.sqlite-import.467.bak`)).toBe(false);
  });

  it("infers config credential provider and mode before stripping config", async () => {
    const cases: Array<{ profileId: string; cfg: OpenClawConfig; now: number }> = [
      {
        profileId: "openai:default",
        cfg: {
          auth: { profiles: { "openai:default": { key: "sk-config" } } },
        } as unknown as OpenClawConfig,
        now: 468,
      },
      {
        profileId: "work",
        cfg: {
          auth: { profiles: { work: { key: "sk-config" } } },
          agents: { defaults: { model: { primary: "openai/gpt-5.5@work" } } },
        } as unknown as OpenClawConfig,
        now: 470,
      },
      {
        profileId: "ordered",
        cfg: {
          auth: {
            profiles: { ordered: { key: "sk-config" } },
            order: { openai: ["ordered"] },
          },
        } as unknown as OpenClawConfig,
        now: 474,
      },
    ];

    for (const entry of cases) {
      const state = await makeTestState();
      const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
        cfg: entry.cfg,
        prompter: makePrompter(true),
        now: () => entry.now,
      });

      const authPath = `${state.agentDir()}/auth-profiles.json`;
      expect(result.detected).toEqual([authPath]);
      expect(result.configChanged).toBe(true);
      expect(result.warnings).toStrictEqual([]);
      expect(entry.cfg.auth?.profiles?.[entry.profileId]).toEqual({
        provider: "openai",
        mode: "api_key",
      });
      expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles[entry.profileId]).toEqual({
        type: "api_key",
        provider: "openai",
        key: "sk-config",
      });
      expect(fs.existsSync(authPath)).toBe(false);
      expect(fs.existsSync(`${authPath}.sqlite-import.${entry.now}.bak`)).toBe(false);
    }
  });

  it("imports missing config credentials while preserving legacy JSON precedence", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-json",
        },
        "openai:work": {
          type: "api_key",
          provider: "openai",
          key: "sk-work",
        },
      },
      order: {
        openai: ["openai:work"],
      },
    });
    const cfg = {
      auth: {
        profiles: {
          "openai:default": {
            provider: "openai",
            mode: "api_key",
            key: "sk-config",
          },
          "anthropic:default": {
            provider: "anthropic",
            mode: "api_key",
            key: "sk-anthropic",
          },
        },
        order: {
          openai: ["openai:default"],
        },
      },
    } as OpenClawConfig;

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg,
      prompter: makePrompter(true),
      now: () => 471,
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.configChanged).toBe(true);
    expect(result.warnings).toStrictEqual([]);
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toMatchObject({
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "sk-json",
      },
      "openai:work": {
        type: "api_key",
        provider: "openai",
        key: "sk-work",
      },
      "anthropic:default": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-anthropic",
      },
    });
    expect(cfg.auth?.profiles?.["openai:default"]).toEqual({
      provider: "openai",
      mode: "api_key",
    });
    expect(cfg.auth?.profiles?.["anthropic:default"]).toEqual({
      provider: "anthropic",
      mode: "api_key",
    });
    expect(loadPersistedAuthProfileStore(state.agentDir())).toMatchObject({
      order: {
        openai: ["openai:work"],
      },
    });
    expect(fs.existsSync(authPath)).toBe(false);
    expect(fs.existsSync(`${authPath}.sqlite-import.471.bak`)).toBe(true);
  });

  it("imports default-agent config api key alias SecretRefs as key refs", async () => {
    const cases = [
      {
        profileId: "openai:api-key-object",
        profile: {
          provider: "openai",
          apiKey: {
            source: "env",
            provider: "default",
            id: "OPENAI_API_KEY",
          },
        },
      },
      {
        profileId: "openai:api-key-template",
        profile: {
          provider: "openai",
          mode: "api_key",
          apiKey: "${OPENAI_API_KEY}",
        },
      },
      {
        profileId: "openai:api-key-legacy-field",
        profile: {
          provider: "openai",
          api_key: {
            source: "env",
            provider: "default",
            id: "OPENAI_API_KEY",
          },
        },
      },
    ];

    for (const entry of cases) {
      const state = await makeTestState();
      const cfg = {
        auth: {
          profiles: {
            [entry.profileId]: entry.profile,
          },
        },
      } as unknown as OpenClawConfig;

      const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
        cfg,
        prompter: makePrompter(true),
        now: () => 473,
      });

      expect(result.configChanged).toBe(true);
      expect(result.warnings).toStrictEqual([]);
      expect(cfg.auth?.profiles?.[entry.profileId]).toEqual({
        provider: "openai",
        mode: "api_key",
      });
      expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles[entry.profileId]).toEqual({
        type: "api_key",
        provider: "openai",
        keyRef: {
          source: "env",
          provider: "default",
          id: "OPENAI_API_KEY",
        },
      });
    }
  });

  it("uses config credentials only when same-id sqlite credentials are incomplete", async () => {
    const cases = [
      {
        existing: {
          type: "api_key" as const,
          provider: "openai",
          key: "sk-sqlite",
        },
        expectedKey: "sk-sqlite",
      },
      {
        existing: {
          type: "api_key" as const,
          provider: "openai",
        },
        expectedKey: "sk-config",
      },
    ];

    for (const entry of cases) {
      const state = await makeTestState();
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openai:default": entry.existing,
          },
        },
        state.agentDir(),
        { syncExternalCli: false },
      );
      const cfg = {
        auth: {
          profiles: {
            "openai:default": {
              provider: "openai",
              mode: "api_key",
              key: "sk-config",
            },
          },
        },
      } as OpenClawConfig;

      const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
        cfg,
        prompter: makePrompter(true),
        now: () => 469,
      });

      expect(result.configChanged).toBe(true);
      expect(result.warnings).toStrictEqual([]);
      expect(cfg.auth?.profiles?.["openai:default"]).toEqual({
        provider: "openai",
        mode: "api_key",
      });
      expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles["openai:default"]).toEqual({
        type: "api_key",
        provider: "openai",
        key: entry.expectedKey,
      });
    }
  });
});

describe("maybeRepairLegacyFlatAuthProfileStores", () => {
  it("migrates legacy flat auth-profiles.json stores with a backup", async () => {
    const state = await makeTestState();
    const legacy = {
      "ollama-windows": {
        apiKey: "ollama-local",
        baseUrl: "http://10.0.2.2:11434/v1",
      },
    };
    const authPath = await writeLegacyAuthProfilesJson(state, legacy);

    const result = await maybeRepairLegacyFlatAuthProfileStores({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 123,
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.changes).toStrictEqual([
      `Migrated ${authPath} to the SQLite auth profile store (backup: ${authPath}.legacy-flat.123.bak).`,
    ]);
    expect(result.warnings).toStrictEqual([]);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toEqual({
      version: 1,
      profiles: {
        "ollama-windows:default": {
          type: "api_key",
          provider: "ollama-windows",
          key: "ollama-local",
        },
      },
    });
    expect(fs.existsSync(authPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${authPath}.legacy-flat.123.bak`, "utf8"))).toEqual(legacy);
  });

  it("reports legacy flat stores without rewriting when repair is declined", async () => {
    const state = await makeTestState();
    const legacy = {
      openai: {
        apiKey: "sk-openai",
      },
    };
    const authPath = await writeLegacyAuthProfilesJson(state, legacy);

    const result = await maybeRepairLegacyFlatAuthProfileStores({
      cfg: {},
      prompter: makePrompter(false),
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([]);
    expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual(legacy);
  });

  it("moves aws-sdk auth profile markers into config metadata", async () => {
    const state = await makeTestState();
    const legacy = {
      version: 1,
      profiles: {
        "amazon-bedrock:default": {
          type: "aws-sdk",
          createdAt: "2026-03-15T10:00:00.000Z",
        },
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          key: "sk-openrouter",
        },
      },
    };
    const authPath = await writeLegacyAuthProfilesJson(state, legacy);
    const cfg = {};

    const result = await maybeRepairLegacyFlatAuthProfileStores({
      cfg,
      prompter: makePrompter(true),
      now: () => 456,
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.changes).toStrictEqual([
      `Moved aws-sdk profile metadata from ${authPath} to auth.profiles (backup: ${authPath}.aws-sdk-profile.456.bak).`,
    ]);
    expect(result.warnings).toStrictEqual([]);
    expect(cfg).toEqual({
      auth: {
        profiles: {
          "amazon-bedrock:default": {
            provider: "amazon-bedrock",
            mode: "aws-sdk",
          },
        },
      },
    });
    expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual({
      version: 1,
      profiles: {
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          key: "sk-openrouter",
        },
      },
    });
    expect(JSON.parse(fs.readFileSync(`${authPath}.aws-sdk-profile.456.bak`, "utf8"))).toEqual(
      legacy,
    );
  });
});

describe("maybeRepairOpenAICodexAuthConfig", () => {
  it("renames legacy OpenAI Codex config profiles and merges auth order", () => {
    const cfg = {
      auth: {
        profiles: {
          "openai:default": {
            provider: "openai",
            mode: "api_key",
          },
          "openai-codex:default": {
            provider: "openai-codex",
            mode: "oauth",
            email: "chatgpt@example.com",
          },
        },
        order: {
          openai: ["openai:default"],
          "openai-codex": ["openai-codex:default"],
        },
      },
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {
              agentRuntime: {
                id: "codex",
                authProfileId: "openai-codex:default",
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeRepairOpenAICodexAuthConfig(cfg);
    const migrated = result.config as OpenClawConfig & {
      agents?: {
        defaults?: {
          models?: Record<string, { agentRuntime?: { authProfileId?: string } }>;
        };
      };
    };

    expect(result.changes).toStrictEqual([
      "Migrated legacy OpenAI Codex auth profile config to the canonical OpenAI provider.",
    ]);
    expect(result.config.auth?.profiles).toEqual({
      "openai:default": {
        provider: "openai",
        mode: "api_key",
      },
      "openai:chatgpt-default": {
        provider: "openai",
        mode: "oauth",
        email: "chatgpt@example.com",
      },
    });
    expect(result.config.auth?.order).toEqual({
      openai: ["openai:chatgpt-default", "openai:default"],
    });
    expect(migrated.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime?.authProfileId).toBe(
      "openai:chatgpt-default",
    );
  });

  it("canonicalizes legacy OpenAI Codex auth order entries without config profiles", () => {
    const cfg = {
      auth: {
        order: {
          "openai-codex": ["openai-codex:work"],
        },
      },
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {
              agentRuntime: {
                authProfileId: "openai-codex:work",
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeRepairOpenAICodexAuthConfig(cfg);
    const migrated = result.config as OpenClawConfig & {
      agents?: {
        defaults?: {
          models?: Record<string, { agentRuntime?: { authProfileId?: string } }>;
        };
      };
    };

    expect(result.changes).toStrictEqual([
      "Migrated legacy OpenAI Codex auth profile config to the canonical OpenAI provider.",
    ]);
    expect(result.config.auth?.order).toEqual({
      openai: ["openai:work"],
    });
    expect(migrated.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime?.authProfileId).toBe(
      "openai:work",
    );
  });

  it("uses auth-store profile renames when canonicalizing config-only auth order", () => {
    const cfg = {
      auth: {
        order: {
          "openai-codex": ["openai-codex:default"],
        },
      },
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {
              agentRuntime: {
                authProfileId: "openai-codex:default",
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeRepairOpenAICodexAuthConfig(cfg, {
      profileIdMap: new Map([["openai-codex:default", "openai:chatgpt-default"]]),
    });
    const migrated = result.config as OpenClawConfig & {
      agents?: {
        defaults?: {
          models?: Record<string, { agentRuntime?: { authProfileId?: string } }>;
        };
      };
    };

    expect(result.config.auth?.order).toEqual({
      openai: ["openai:chatgpt-default"],
    });
    expect(migrated.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime?.authProfileId).toBe(
      "openai:chatgpt-default",
    );
  });

  it("uses auth-store profile renames for profile refs when config has no auth block", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {
              agentRuntime: {
                authProfileId: "openai-codex:default",
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeRepairOpenAICodexAuthConfig(cfg, {
      profileIdMap: new Map([["openai-codex:default", "openai:chatgpt-default"]]),
    });
    const migrated = result.config as OpenClawConfig & {
      agents?: {
        defaults?: {
          models?: Record<string, { agentRuntime?: { authProfileId?: string } }>;
        };
      };
    };

    expect(result.changes).toStrictEqual([
      "Migrated legacy OpenAI Codex auth profile config to the canonical OpenAI provider.",
    ]);
    expect(migrated.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime?.authProfileId).toBe(
      "openai:chatgpt-default",
    );
    expect(result.config.auth).toBeUndefined();
  });

  it("does not rewrite unrelated config strings that look like profile ids", () => {
    const cfg = {
      auth: {
        order: {
          "openai-codex": ["openai-codex:default"],
        },
      },
      agents: {
        defaults: {
          systemPrompt: "Use openai-codex:default as literal text.",
          models: {
            "openai/gpt-5.5": {
              agentRuntime: {
                authProfileId: "openai-codex:default",
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeRepairOpenAICodexAuthConfig(cfg, {
      profileIdMap: new Map([["openai-codex:default", "openai:chatgpt-default"]]),
    });
    const migrated = result.config as OpenClawConfig & {
      agents?: {
        defaults?: {
          systemPrompt?: string;
          models?: Record<string, { agentRuntime?: { authProfileId?: string } }>;
        };
      };
    };

    expect(migrated.agents?.defaults?.systemPrompt).toBe(
      "Use openai-codex:default as literal text.",
    );
    expect(migrated.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime?.authProfileId).toBe(
      "openai:chatgpt-default",
    );
  });

  it("uses auth-store profile renames when canonicalizing config profile entries", () => {
    const cfg = {
      auth: {
        profiles: {
          "openai-codex:default": {
            provider: "openai-codex",
            mode: "oauth",
          },
        },
        order: {
          "openai-codex": ["openai-codex:default"],
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeRepairOpenAICodexAuthConfig(cfg, {
      profileIdMap: new Map([["openai-codex:default", "openai:chatgpt-default"]]),
    });

    expect(result.config.auth?.profiles).toEqual({
      "openai:chatgpt-default": {
        provider: "openai",
        mode: "oauth",
      },
    });
    expect(result.config.auth?.order).toEqual({
      openai: ["openai:chatgpt-default"],
    });
  });

  it("keeps existing OpenAI config profiles when auth-store renames collide", () => {
    const cfg = {
      auth: {
        profiles: {
          "openai:default": {
            provider: "openai",
            mode: "api_key",
          },
          "openai-codex:default": {
            provider: "openai-codex",
            mode: "oauth",
            email: "chatgpt@example.com",
          },
        },
        order: {
          openai: ["openai:default"],
          "openai-codex": ["openai-codex:default"],
        },
      },
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": {
              agentRuntime: {
                authProfileId: "openai-codex:default",
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = maybeRepairOpenAICodexAuthConfig(cfg, {
      profileIdMap: new Map([["openai-codex:default", "openai:default"]]),
    });
    const migrated = result.config as OpenClawConfig & {
      agents?: {
        defaults?: {
          models?: Record<string, { agentRuntime?: { authProfileId?: string } }>;
        };
      };
    };

    expect(result.config.auth?.profiles).toEqual({
      "openai:default": {
        provider: "openai",
        mode: "api_key",
      },
      "openai:chatgpt-default": {
        provider: "openai",
        mode: "oauth",
        email: "chatgpt@example.com",
      },
    });
    expect(result.config.auth?.order).toEqual({
      openai: ["openai:chatgpt-default", "openai:default"],
    });
    expect(migrated.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime?.authProfileId).toBe(
      "openai:chatgpt-default",
    );
  });
});

describe("maybeRepairOpenAICodexAuthProfileStores", () => {
  it("collects the store-derived legacy OpenAI Codex profile id map", async () => {
    const state = await makeTestState();
    await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-openai",
        },
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: 9999999999999,
        },
      },
    });

    expect(
      Array.from(
        collectOpenAICodexAuthProfileStoreIdMap({
          cfg: {},
          env: state.env,
        }),
      ),
    ).toEqual([["openai-codex:default", "openai:chatgpt-default"]]);
  });

  it("renames legacy OpenAI Codex auth store profiles with a backup", async () => {
    const state = await makeTestState();
    const legacy = {
      version: 1,
      profiles: {
        "openai-codex:work": {
          type: "oauth",
          provider: "openai-codex",
          access: "access",
          refresh: "refresh",
          expires: 9999999999999,
        },
      },
      order: {
        "openai-codex": ["openai-codex:work"],
      },
      lastGood: {
        "openai-codex": "openai-codex:work",
      },
      usageStats: {
        "openai-codex:work": {
          blockedUntil: 9999999999999,
          blockedReason: "subscription_limit",
        },
      },
    };
    const authPath = await writeLegacyAuthProfilesJson(state, legacy);

    const result = await maybeRepairOpenAICodexAuthProfileStores({
      cfg: {},
      env: state.env,
      now: () => 789,
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.changes).toStrictEqual([
      `Migrated 1 OpenAI Codex auth profile(s) in ${authPath} to provider "openai" (backup: ${authPath}.openai-provider-unification.789.bak).`,
    ]);
    expect(result.warnings).toStrictEqual([]);
    expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual({
      version: 1,
      profiles: {
        "openai:work": {
          type: "oauth",
          provider: "openai",
          access: "access",
          refresh: "refresh",
          expires: 9999999999999,
        },
      },
      order: {
        openai: ["openai:work"],
      },
      lastGood: {
        openai: "openai:work",
      },
      usageStats: {
        "openai:work": {
          blockedUntil: 9999999999999,
          blockedReason: "subscription_limit",
        },
      },
    });
    expect(
      JSON.parse(fs.readFileSync(`${authPath}.openai-provider-unification.789.bak`, "utf8")),
    ).toEqual(legacy);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
