// Doctor flat auth-profile tests cover legacy flat profile repair and persisted auth-profile loading.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listAuthProfileStoresRequiringMigration } from "../agents/auth-profiles/legacy-source-diagnostic.js";
import { resolveAuthProfileEligibility } from "../agents/auth-profiles/order.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { clearAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import {
  listSessionEntriesReadOnly,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { buildStatusText } from "../status/status-text.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  collectOpenAICodexAuthProfileStoreIdMap,
  maybeMigrateAuthProfileJsonStoresToSqlite,
  maybeRepairOpenAICodexAuthConfig,
} from "./doctor-auth-flat-profiles.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import { maybeRepairCodexSessionRoutes } from "./doctor/shared/codex-route-session-repair.js";

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

async function expectSelectedCodexAccountStatus(params: {
  cfg: OpenClawConfig;
  state: OpenClawTestState;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  const usageProfileIds: Array<string | undefined> = [];
  registerAgentHarness(
    {
      id: "codex",
      label: "Codex",
      autoSelection: { providerIds: ["openai"] },
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt: async () => {
        throw new Error("not used in doctor migration status proof");
      },
      fetchUsageSnapshot: async (context) => {
        usageProfileIds.push(context.authProfileId);
        const selectedProfile = context.authProfileId ?? "openai:peter";
        const credential = loadPersistedAuthProfileStore(params.state.agentDir())?.profiles[
          selectedProfile
        ];
        return {
          provider: "openai",
          displayName: "OpenAI",
          windows: [
            {
              label: "Week",
              usedPercent:
                credential?.type === "oauth" && credential.accountId === "kate-account" ? 25 : 80,
            },
          ],
        };
      },
    },
    { ownerPluginId: "codex" },
  );
  try {
    const status = await buildStatusText({
      cfg: params.cfg,
      sessionEntry: loadSessionEntry({
        storePath: params.storePath,
        sessionKey: params.sessionKey,
        env: params.state.env,
      }),
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      statusChannel: "telegram",
      provider: "openai",
      model: "gpt-5.5",
      resolvedHarness: "codex",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      modelAuthOverride: "oauth",
      activeModelAuthOverride: "oauth",
      skipDefaultTaskLookup: true,
    });
    expect(usageProfileIds).toEqual(["openai:chatgpt-default"]);
    expect(status).toContain("Week 75% left");
    expect(status).not.toContain("Week 20% left");
  } finally {
    clearAgentHarnesses();
  }
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

function listMigratedArchives(sourcePath: string): string[] {
  const prefix = `${path.basename(sourcePath)}.migrated-`;
  return fs
    .readdirSync(path.dirname(sourcePath))
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => path.join(path.dirname(sourcePath), entry));
}

function expectMigratedArchive(sourcePath: string): void {
  expect(listMigratedArchives(sourcePath)).toHaveLength(1);
}

function expectNoMigratedArchive(sourcePath: string): void {
  expect(listMigratedArchives(sourcePath)).toHaveLength(0);
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
  it("migrates the inherited auth owner after it leaves the explicit roster", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(
      state,
      {
        version: 1,
        profiles: {
          "openai:retired-owner": {
            type: "oauth",
            provider: "openai",
            access: "retired-owner-access",
            refresh: "retired-owner-refresh",
            expires: 1_900_000_000_000,
          },
        },
      },
      "retired-ops",
    );

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {
        agents: {
          ownership: "explicit",
          defaults: { authInheritance: { agentId: "retired-ops" } },
          entries: { research: {}, writer: {} },
        },
      },
      prompter: makePrompter(true),
      env: state.env,
      now: () => Date.parse("2026-08-09T12:00:00.000Z"),
    });

    expect(result.warnings).toStrictEqual([]);
    expect(loadPersistedAuthProfileStore(state.agentDir("retired-ops"))).toMatchObject({
      profiles: {
        "openai:retired-owner": {
          type: "oauth",
          provider: "openai",
          access: "retired-owner-access",
          refresh: "retired-owner-refresh",
        },
      },
    });
    expect(fs.existsSync(authPath)).toBe(false);
    expectMigratedArchive(authPath);
  });

  it("imports shared oauth.json into shared-main only and records its archive", async () => {
    const state = await makeTestState();
    const oauthPath = await state.writeJson("credentials/oauth.json", {
      openai: {
        access: "fake-access-token",
        refresh: "fake-refresh-token",
        expires: 1_900_000_000_000,
        accountId: "fake-account",
        subscriptionType: "fake-subscription",
      },
    });
    const sourceBytes = fs.readFileSync(oauthPath);
    const secondaryAgentDir = state.agentDir("secondary");

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {
        agents: { list: [{ id: "secondary", agentDir: secondaryAgentDir }] },
      },
      prompter: makePrompter(true),
      env: state.env,
      now: () => Date.parse("2026-07-25T12:00:00.000Z"),
    });

    expect(result.warnings).toStrictEqual([]);
    expect(
      loadPersistedAuthProfileStore(state.agentDir())?.profiles["openai:default"],
    ).toMatchObject({
      type: "oauth",
      provider: "openai",
      access: "fake-access-token",
      refresh: "fake-refresh-token",
      accountId: "fake-account",
      subscriptionType: "fake-subscription",
    });
    expect(loadPersistedAuthProfileStore(secondaryAgentDir)).toBeNull();
    expect(fs.existsSync(oauthPath)).toBe(false);
    const archives = listMigratedArchives(oauthPath);
    expect(archives).toHaveLength(1);
    expect(fs.readFileSync(archives[0]!)).toEqual(sourceBytes);

    const receipt = openOpenClawStateDatabase({ env: state.env })
      .db.prepare(
        "SELECT status, removed_source, target_table FROM migration_sources WHERE migration_kind = ?",
      )
      .get("auth-profile-json-to-sqlite-v2") as
      | { status: string; removed_source: number; target_table: string }
      | undefined;
    expect(receipt).toEqual({
      status: "completed",
      removed_source: 1,
      target_table: "auth_profile_store",
    });
  });

  it("defers shared OAuth while a higher-priority main credential remains pending", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          oauthRef: {
            source: "openclaw-credentials",
            id: "0123456789abcdef0123456789abcdef",
            provider: "openai-codex",
          },
        },
      },
    });
    const oauthPath = await state.writeJson("credentials/oauth.json", {
      openai: {
        access: "fake-lower-priority-access",
        refresh: "fake-lower-priority-refresh",
        expires: 1_900_000_000_000,
      },
    });

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      env: state.env,
    });

    expect(result.warnings).toEqual([expect.stringContaining("legacy OAuth sidecar profile")]);
    expect(
      loadPersistedAuthProfileStore(state.agentDir())?.profiles["openai:default"],
    ).toMatchObject({
      type: "oauth",
      provider: "openai",
      oauthRef: {
        source: "openclaw-credentials",
        provider: "openai-codex",
      },
    });
    expect(fs.existsSync(authPath)).toBe(false);
    expect(fs.existsSync(oauthPath)).toBe(false);
    expectMigratedArchive(authPath);
    expectMigratedArchive(oauthPath);
  });

  it("preserves state-only profile IDs while migrating shared OAuth", async () => {
    const state = await makeTestState();
    writePersistedAuthProfileStateRaw(
      {
        version: 1,
        order: { openai: ["openai:external"] },
        lastGood: { openai: "openai:external" },
        usageStats: { "openai:external": { cooldownUntil: 1_900_000_000_000 } },
      },
      state.agentDir(),
    );
    await state.writeJson("credentials/oauth.json", {
      anthropic: {
        access: "not-a-real",
        refresh: "not-a-real",
        expires: 1_900_000_000_000,
      },
    });

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      env: state.env,
    });

    expect(result.warnings).toEqual([]);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toMatchObject({
      profiles: {
        "anthropic:default": { type: "oauth", provider: "anthropic" },
      },
      order: { openai: ["openai:external"] },
      lastGood: { openai: "openai:external" },
      usageStats: { "openai:external": { cooldownUntil: 1_900_000_000_000 } },
    });
  });

  it("retries when an absent legacy sibling appears during migration", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "not-a-real",
        },
      },
    });
    const legacyPath = path.join(state.agentDir(), "auth.json");
    let recreated = false;

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      env: state.env,
      deps: {
        loadPersistedAuthProfileStore(agentDir, options) {
          if (!recreated && options?.database === undefined) {
            recreated = true;
            fs.writeFileSync(
              legacyPath,
              `${JSON.stringify({ xai: { type: "api_key", key: "not-a-real" } })}\n`,
              "utf8",
            );
          }
          return loadPersistedAuthProfileStore(agentDir, options);
        },
      },
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("legacy auth source set changed during migration"),
    ]);
    expect(fs.existsSync(authPath)).toBe(true);
    expect(fs.existsSync(legacyPath)).toBe(true);
    expectNoMigratedArchive(authPath);
    expectNoMigratedArchive(legacyPath);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toBeNull();
  });

  it("archives restored OAuth bytes without replaying a terminal receipt", async () => {
    const state = await makeTestState();
    const oauthPath = await state.writeJson("credentials/oauth.json", {
      openai: {
        access: "fake-stale-access",
        refresh: "fake-stale-refresh",
        expires: 1_900_000_000_000,
      },
    });
    const sourceBytes = fs.readFileSync(oauthPath);

    await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      env: state.env,
    });
    saveAuthProfileStore({ version: 1, profiles: {} }, state.agentDir(), {
      syncExternalCli: false,
    });
    fs.writeFileSync(oauthPath, sourceBytes);

    const replay = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      env: state.env,
    });

    expect(replay.changes).toEqual([expect.stringContaining("without replaying credentials")]);
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toEqual({});
    expect(fs.existsSync(oauthPath)).toBe(false);
    expect(listMigratedArchives(oauthPath)).toHaveLength(2);
  });

  it("marks a partially parsed shared OAuth source for manual recovery", async () => {
    const state = await makeTestState();
    const oauthPath = await state.writeJson("credentials/oauth.json", {
      anthropic: {
        access: "fake-access-token",
        refresh: "fake-refresh-token",
        expires: 1_900_000_000_000,
      },
      malformed: 42,
    });

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      env: state.env,
    });

    expect(result.warnings).toContain(
      "Imported valid shared OAuth entries and archived 1 rejected entry for manual recovery.",
    );
    expect(
      loadPersistedAuthProfileStore(state.agentDir())?.profiles["anthropic:default"],
    ).toBeDefined();
    expect(fs.existsSync(oauthPath)).toBe(false);
    const receipt = openOpenClawStateDatabase({ env: state.env })
      .db.prepare("SELECT status FROM migration_sources WHERE migration_kind = ?")
      .get("auth-profile-json-to-sqlite-v2") as { status?: string } | undefined;
    expect(receipt?.status).toBe("archived-unparsed");
  });

  it("leaves shared OAuth in place when the canonical SQLite store is unreadable", async () => {
    const state = await makeTestState();
    const oauthPath = await state.writeJson("credentials/oauth.json", {
      openai: {
        access: "fake-access-token",
        refresh: "fake-refresh-token",
        expires: 1_900_000_000_000,
      },
    });
    const unreadableStore = { version: 1, profiles: "invalid-profile-map" };
    writePersistedAuthProfileStoreRaw(unreadableStore, state.agentDir());

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      env: state.env,
    });

    expect(result.warnings).toContain(
      "Failed to migrate shared legacy OAuth credentials; the source was left in place.",
    );
    expect(fs.existsSync(oauthPath)).toBe(true);
    expectNoMigratedArchive(oauthPath);
    expect(readPersistedAuthProfileStoreRaw(state.agentDir())).toEqual(unreadableStore);
  });

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
      order: { openai: ["openai:default"] },
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
    expectMigratedArchive(authPath);
    expectMigratedArchive(statePath);
    const combinedReceipt = openOpenClawStateDatabase({ env: state.env })
      .db.prepare("SELECT report_json FROM migration_sources WHERE source_path = ?")
      .get(authPath) as { report_json?: string } | undefined;
    expect(JSON.parse(combinedReceipt?.report_json ?? "null")?.expectedStateSha256).toEqual(
      expect.any(String),
    );
  });

  it("imports a valid legacy auth sibling when auth-profiles.json is malformed", async () => {
    const state = await makeTestState();
    const authPath = await state.writeText(
      "agents/main/agent/auth-profiles.json",
      "{ malformed-json\n",
    );
    const legacyPath = await state.writeText(
      "agents/main/agent/auth.json",
      `${JSON.stringify({
        xai: { type: "api_key", provider: "xai", key: "fake-sibling-key" },
      })}\n`,
    );

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
    });

    expect(result.changes).toEqual([expect.stringContaining("Migrated auth profile JSON")]);
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles["xai:default"]).toMatchObject({
      key: "fake-sibling-key",
    });
    expect(fs.existsSync(authPath)).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expectMigratedArchive(authPath);
    expectMigratedArchive(legacyPath);
  });

  it("preserves secret refs and OAuth material when migrating a flat auth-profiles.json", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      chutes: {
        type: "oauth",
        provider: "chutes",
        access: "ACCESS_TOKEN",
        refresh: "REFRESH_TOKEN",
        expires: 1_900_000_000_000,
        clientId: "chutes-client-id-123",
        idToken: "ID_TOKEN_xyz",
        chatgptPlanType: "pro",
      },
      openai: {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", id: "OPENAI_API_KEY" },
      },
    });

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 472,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toMatchObject({
      profiles: {
        "chutes:default": {
          type: "oauth",
          provider: "chutes",
          access: "ACCESS_TOKEN",
          refresh: "REFRESH_TOKEN",
          clientId: "chutes-client-id-123",
          idToken: "ID_TOKEN_xyz",
          chatgptPlanType: "pro",
        },
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", id: "OPENAI_API_KEY" },
        },
      },
    });
    expect(fs.existsSync(authPath)).toBe(false);
    expectMigratedArchive(authPath);
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
    expectMigratedArchive(authPath);
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
    expectMigratedArchive(statePath);
    expect(fs.existsSync(authPath)).toBe(false);
  });

  it("migrates unresolved legacy OAuth sidecar refs so startup can proceed cold", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai:user@example.com": {
          type: "oauth",
          provider: "openai",
          email: "user@example.com",
          oauthRef: {
            source: "openclaw-credentials",
            id: "0123456789abcdef0123456789abcdef",
            provider: "openai-codex",
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
    expect(result.changes).toEqual([expect.stringContaining("Migrated auth profile JSON")]);
    expect(result.warnings).toEqual([
      expect.stringContaining("Migrated 1 legacy OAuth sidecar profile"),
    ]);
    expect(result.warnings[0]).toContain("re-authenticate");
    const store = loadPersistedAuthProfileStore(state.agentDir());
    expect(store?.profiles["openai:user@example.com"]).toMatchObject({
      type: "oauth",
      provider: "openai",
      email: "user@example.com",
      oauthRef: {
        source: "openclaw-credentials",
        provider: "openai-codex",
      },
    });
    expect(
      resolveAuthProfileEligibility({
        store: store!,
        provider: "openai",
        profileId: "openai:user@example.com",
      }),
    ).toEqual({ eligible: false, reasonCode: "unresolved_ref" });
    expect(fs.existsSync(authPath)).toBe(false);
    expectMigratedArchive(authPath);
    expect(
      listAuthProfileStoresRequiringMigration({
        agentDirs: [state.agentDir()],
        env: state.env,
      }),
    ).toEqual([]);
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
            source: "openclaw-credentials",
            id: "0123456789abcdef0123456789abcdef",
            provider: "openai-codex",
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
        "openai:user@example.com": {
          type: "oauth",
          provider: "openai",
          email: "user@example.com",
          oauthRef: {
            source: "openclaw-credentials",
            id: "0123456789abcdef0123456789abcdef",
            provider: "openai-codex",
          },
        },
      },
      order: { openai: ["openai:default", "openai:user@example.com"] },
      lastGood: { openai: "openai:default" },
    });
    expect(fs.existsSync(authPath)).toBe(false);
    expectMigratedArchive(authPath);
    expect(
      listAuthProfileStoresRequiringMigration({
        agentDirs: [state.agentDir()],
        env: state.env,
      }),
    ).toEqual([]);
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
    expectMigratedArchive(authPath);
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
    expectMigratedArchive(authPath);
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
      `Left auth profile JSON in place for ${authPath} because SQLite verification failed (imported profile(s): openrouter:default).`,
    ]);
    expect(fs.existsSync(authPath)).toBe(true);
    expectNoMigratedArchive(authPath);
  });

  it("keeps legacy JSON when the SQLite target changes before the migration transaction", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          key: "fake-imported-key",
        },
      },
    });
    let loadCount = 0;
    const emptyStore: AuthProfileStore = { version: 1, profiles: {} };
    const concurrentStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "fake-concurrent-key",
        },
      },
    };

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 464,
      deps: {
        loadPersistedAuthProfileStore: () => {
          loadCount += 1;
          return loadCount === 1 ? emptyStore : concurrentStore;
        },
      },
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("canonical auth profile store changed during legacy migration"),
    ]);
    expect(fs.existsSync(authPath)).toBe(true);
    expectNoMigratedArchive(authPath);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toBeNull();
  });

  it("keeps legacy JSON when only SQLite auth state changes before the transaction", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          key: "fake-imported-key",
        },
      },
    });
    const baseline: AuthProfileStore = {
      version: 1,
      profiles: {},
      lastGood: { openai: "openai:before" },
    };
    const concurrent: AuthProfileStore = {
      version: 1,
      profiles: {},
      lastGood: { openai: "openai:after" },
    };
    let loadCount = 0;

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      deps: {
        loadPersistedAuthProfileStore: () => {
          loadCount += 1;
          return loadCount === 1 ? baseline : concurrent;
        },
      },
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining("canonical auth profile store changed during legacy migration"),
    ]);
    expect(fs.existsSync(authPath)).toBe(true);
    expectNoMigratedArchive(authPath);
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
    expectNoMigratedArchive(authPath);
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
    expectMigratedArchive(statePath);
    expect(fs.existsSync(authPath)).toBe(false);
    expectNoMigratedArchive(authPath);
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
      expectNoMigratedArchive(authPath);
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
    expectMigratedArchive(authPath);
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

describe("legacy flat profiles through the canonical auth migration owner", () => {
  it("migrates legacy flat auth-profiles.json stores with a receipted archive", async () => {
    const state = await makeTestState();
    const legacy = {
      "ollama-windows": {
        apiKey: "ollama-local",
        baseUrl: "http://10.0.2.2:11434/v1",
      },
    };
    const authPath = await writeLegacyAuthProfilesJson(state, legacy);

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 123,
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.changes).toEqual([expect.stringContaining("Migrated auth profile JSON")]);
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
    const [archive] = listMigratedArchives(authPath);
    expect(JSON.parse(fs.readFileSync(archive!, "utf8"))).toEqual(legacy);
  });

  it("preserves existing SQLite auth profiles when migrating a legacy flat store", async () => {
    const state = await makeTestState();
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "anthropic:default": {
            type: "oauth",
            provider: "anthropic",
            access: "sk-access-live",
            refresh: "sk-refresh-live",
            expires: 9999999999999,
          },
        },
      },
      state.agentDir(),
    );
    const legacy = { openai: { apiKey: "sk-openai-flat" } };
    const authPath = await writeLegacyAuthProfilesJson(state, legacy);

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 123,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toEqual([expect.stringContaining("Migrated auth profile JSON")]);
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toEqual({
      "anthropic:default": {
        type: "oauth",
        provider: "anthropic",
        access: "sk-access-live",
        refresh: "sk-refresh-live",
        expires: 9999999999999,
      },
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "sk-openai-flat",
      },
    });
    expect(fs.existsSync(authPath)).toBe(false);
  });

  it("reports legacy flat stores without rewriting when repair is declined", async () => {
    const state = await makeTestState();
    const legacy = {
      openai: {
        apiKey: "sk-openai",
      },
    };
    const authPath = await writeLegacyAuthProfilesJson(state, legacy);

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
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

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg,
      prompter: makePrompter(true),
      now: () => 456,
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated auth profile JSON"),
      expect.stringContaining("Moved aws-sdk profile metadata"),
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
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toEqual({
      "openrouter:default": {
        type: "api_key",
        provider: "openrouter",
        key: "sk-openrouter",
      },
    });
    expect(fs.existsSync(authPath)).toBe(false);
    const [archive] = listMigratedArchives(authPath);
    expect(JSON.parse(fs.readFileSync(archive!, "utf8"))).toEqual(legacy);
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

describe("legacy OpenAI auth profiles through the canonical migration owner", () => {
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

  it("keeps existing SQLite accounts when planning legacy Codex profile collisions", async () => {
    const state = await makeTestState();
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "peter-access",
          refresh: "peter-refresh",
          expires: 9_999_999_999_999,
          accountId: "peter-account",
        },
      },
    });
    await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "kate-access",
          refresh: "kate-refresh",
          expires: 9_999_999_999_999,
          accountId: "kate-account",
        },
      },
    });

    const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg: {}, env: state.env });
    expect(profileIdMap.get("openai-codex:default")).toBe("openai:chatgpt-default");
    await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      env: state.env,
      prompter: makePrompter(true),
      openAICodexAuthProfileIdMap: profileIdMap,
    });
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toMatchObject({
      "openai:default": { accountId: "peter-account" },
      "openai:chatgpt-default": { accountId: "kate-account" },
    });
  });

  it("migrates config-only legacy OAuth accounts and their selected SQLite session", async () => {
    const state = await makeTestState();
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const sessionKey = "agent:main:main";
    const legacyConfig = {
      auth: {
        profiles: {
          "openai:default": {
            provider: "openai",
            mode: "api_key",
            key: "existing-api-key",
          },
          "openai-codex:default": {
            provider: "openai-codex",
            mode: "oauth",
            access: "kate-access",
            refresh: "kate-refresh",
            expires: 9_999_999_999_999,
            accountId: "kate-account",
          },
        },
      },
    } as OpenClawConfig;
    await replaceSessionEntry(
      { storePath, sessionKey, env: state.env },
      {
        sessionId: "config-only-selected-session",
        updatedAt: Date.now(),
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "user",
      },
    );

    const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({
      cfg: legacyConfig,
      env: state.env,
    });
    expect(profileIdMap.get("openai-codex:default")).toBe("openai:chatgpt-default");
    const cfg = maybeRepairOpenAICodexAuthConfig(legacyConfig, { profileIdMap }).config;
    await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg,
      env: state.env,
      prompter: makePrompter(true),
      openAICodexAuthProfileIdMap: profileIdMap,
    });
    await maybeRepairCodexSessionRoutes({
      cfg,
      env: state.env,
      shouldRepair: true,
      authProfileIdMap: profileIdMap,
    });

    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toMatchObject({
      "openai:default": { type: "api_key" },
      "openai:chatgpt-default": { type: "oauth", accountId: "kate-account" },
    });
    expect(loadSessionEntry({ storePath, sessionKey, env: state.env })).toMatchObject({
      authProfileOverride: "openai:chatgpt-default",
      authProfileOverrideSource: "user",
    });
  });

  it("canonicalizes unresolved sidecar accounts while keeping them cold", async () => {
    const state = await makeTestState();
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const readySessionKey = "agent:main:main";
    const pendingSessionKey = "agent:main:telegram:default:direct:5550100111";
    await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai-codex:ready": {
          type: "oauth",
          provider: "openai-codex",
          access: "ready-access",
          refresh: "ready-refresh",
          expires: 9_999_999_999_999,
          accountId: "ready-account",
        },
        "openai-codex:pending": {
          type: "oauth",
          provider: "openai-codex",
          accountId: "pending-account",
          oauthRef: {
            id: "0123456789abcdef0123456789abcdef",
            provider: "openai-codex",
          },
        },
      },
    });
    for (const [sessionKey, profileId] of [
      [readySessionKey, "openai-codex:ready"],
      [pendingSessionKey, "openai-codex:pending"],
    ] as const) {
      await replaceSessionEntry(
        { storePath, sessionKey, env: state.env },
        {
          sessionId: `session-${profileId}`,
          updatedAt: Date.now(),
          authProfileOverride: profileId,
          authProfileOverrideSource: "user",
        },
      );
    }

    const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg: {}, env: state.env });
    const migration = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      env: state.env,
      prompter: makePrompter(true),
      openAICodexAuthProfileIdMap: profileIdMap,
    });
    expect(migration.changes.length).toBeGreaterThan(0);
    expect(migration.warnings).toEqual([expect.stringContaining("legacy OAuth sidecar profile")]);
    const result = await maybeRepairCodexSessionRoutes({
      cfg: {},
      env: state.env,
      shouldRepair: true,
      authProfileIdMap: profileIdMap,
    });

    expect(result.repairedSessions).toBe(2);
    expect(
      loadSessionEntry({ storePath, sessionKey: readySessionKey, env: state.env }),
    ).toMatchObject({
      authProfileOverride: "openai:ready",
    });
    expect(
      loadSessionEntry({ storePath, sessionKey: pendingSessionKey, env: state.env }),
    ).toMatchObject({
      authProfileOverride: "openai:pending",
      authProfileOverrideSource: "user",
    });
    const coldStore = loadPersistedAuthProfileStore(state.agentDir());
    expect(
      resolveAuthProfileEligibility({
        store: coldStore!,
        provider: "openai",
        profileId: "openai:pending",
      }),
    ).toEqual({ eligible: false, reasonCode: "missing_credential" });
  });

  it("repairs an already-migrated selected account from its verified auth archive", async () => {
    const state = await makeTestState();
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const sessionKey = "agent:main:main";
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "existing-api-key",
        },
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "kate-access",
          refresh: "kate-refresh",
          expires: 9_999_999_999_999,
          accountId: "kate-account",
          email: "kate@example.com",
        },
        "openai-codex:peter": {
          type: "oauth",
          provider: "openai-codex",
          access: "peter-access",
          refresh: "peter-refresh",
          expires: 9_999_999_999_999,
          accountId: "peter-account",
          email: "peter@example.com",
        },
      },
    });
    await replaceSessionEntry(
      { storePath, sessionKey, env: state.env },
      {
        sessionId: "already-migrated-selected-session",
        updatedAt: Date.now(),
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "user",
      },
    );

    const originalMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg: {}, env: state.env });
    await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      env: state.env,
      prompter: makePrompter(true),
      openAICodexAuthProfileIdMap: originalMap,
    });
    expect(fs.existsSync(authPath)).toBe(false);
    expect(loadSessionEntry({ storePath, sessionKey, env: state.env })).toMatchObject({
      authProfileOverride: "openai-codex:default",
    });

    const recoveredMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg: {}, env: state.env });
    expect(recoveredMap.get("openai-codex:default")).toBe("openai:chatgpt-default");
    const repair = await maybeRepairCodexSessionRoutes({
      cfg: {},
      env: state.env,
      shouldRepair: true,
      authProfileIdMap: recoveredMap,
    });

    expect(repair.repairedSessions).toBe(1);
    expect(loadSessionEntry({ storePath, sessionKey, env: state.env })).toMatchObject({
      authProfileOverride: "openai:chatgpt-default",
      authProfileOverrideSource: "user",
    });
    expect(loadPersistedAuthProfileStore(state.agentDir())?.profiles).toMatchObject({
      "openai:default": { type: "api_key" },
      "openai:chatgpt-default": { accountId: "kate-account" },
      "openai:peter": { accountId: "peter-account" },
    });
    await expectSelectedCodexAccountStatus({ cfg: {}, state, sessionKey, storePath });
  });

  it("rejects tampered auth archives instead of guessing a migrated account", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "kate-access",
          refresh: "kate-refresh",
          expires: 9_999_999_999_999,
          accountId: "kate-account",
        },
      },
    });
    await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      env: state.env,
      prompter: makePrompter(true),
    });
    const [archivePath] = listMigratedArchives(authPath);
    fs.appendFileSync(archivePath!, "\n");

    expect(collectOpenAICodexAuthProfileStoreIdMap({ cfg: {}, env: state.env }).size).toBe(0);
  });

  it("leaves archived profile mapping unresolved when account identity is ambiguous", async () => {
    const state = await makeTestState();
    const sharedAccount = {
      type: "oauth",
      provider: "openai-codex",
      access: "shared-access",
      refresh: "shared-refresh",
      expires: 9_999_999_999_999,
      accountId: "shared-account",
    };
    await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai-codex:default": sharedAccount,
        "openai-codex:copy": { ...sharedAccount },
      },
    });
    await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      env: state.env,
      prompter: makePrompter(true),
    });

    expect(collectOpenAICodexAuthProfileStoreIdMap({ cfg: {}, env: state.env }).size).toBe(0);
  });

  it("keeps failed agent accounts separate while repairing verified and inherited main accounts", async () => {
    const state = await makeTestState();
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", default: true },
          { id: "failed" },
          { id: "inherited" },
          { id: "dedup" },
        ],
      },
    };
    const sharedCredential = {
      type: "oauth",
      provider: "openai-codex",
      access: "shared-access",
      refresh: "shared-refresh",
      expires: 9_999_999_999_999,
      accountId: "shared-main-account",
    };
    await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: { "openai-codex:shared": sharedCredential },
    });
    await writeLegacyAuthProfilesJson(
      state,
      {
        version: 1,
        profiles: {
          "openai-codex:shared": {
            type: "oauth",
            provider: "openai-codex",
            accountId: "failed-different-account",
            oauthRef: {
              source: "openclaw-credentials",
              id: "0123456789abcdef0123456789abcdef",
              provider: "openai-codex",
            },
          },
        },
      },
      "failed",
    );
    await writeLegacyAuthProfilesJson(
      state,
      {
        version: 1,
        profiles: {
          "openai-codex:shared": { ...sharedCredential },
          "openai-codex:pending": {
            type: "oauth",
            provider: "openai-codex",
            accountId: "dedup-pending-account",
            oauthRef: {
              id: "fedcba9876543210fedcba9876543210",
              provider: "openai-codex",
            },
          },
        },
      },
      "dedup",
    );
    for (const agentId of ["main", "failed", "inherited", "dedup"]) {
      await replaceSessionEntry(
        {
          storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
          sessionKey: `agent:${agentId}:main`,
          env: state.env,
        },
        {
          sessionId: `${agentId}-session`,
          updatedAt: Date.now(),
          authProfileOverride: "openai-codex:shared",
          authProfileOverrideSource: "user",
        },
      );
    }

    const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg, env: state.env });
    const migration = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg,
      env: state.env,
      prompter: makePrompter(true),
      openAICodexAuthProfileIdMap: profileIdMap,
    });
    expect(migration.warnings.length).toBeGreaterThan(0);
    expect(loadPersistedAuthProfileStore(state.agentDir("dedup"))?.profiles).not.toHaveProperty(
      "openai:shared",
    );

    const repair = await maybeRepairCodexSessionRoutes({
      cfg,
      env: state.env,
      shouldRepair: true,
      authProfileIdMap: profileIdMap,
    });
    expect(repair.repairedSessions).toBe(4);
    for (const agentId of ["main", "failed", "inherited", "dedup"]) {
      expect(
        loadSessionEntry({
          storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
          sessionKey: `agent:${agentId}:main`,
          env: state.env,
        }),
      ).toMatchObject({
        authProfileOverride: "openai:shared",
        authProfileOverrideSource: "user",
      });
    }
    expect(loadPersistedAuthProfileStore(state.agentDir("failed"))?.profiles).toMatchObject({
      "openai:shared": {
        type: "oauth",
        provider: "openai",
        accountId: "failed-different-account",
        oauthRef: {
          source: "openclaw-credentials",
          provider: "openai-codex",
        },
      },
    });
  });

  it("previews noncanonical SQLite sessions without mutating or requiring canonical migration", async () => {
    const state = await makeTestState();
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const sessionKey = "agent:main:main";
    await replaceSessionEntry(
      { storePath, sessionKey, env: state.env },
      {
        sessionId: "noncanonical-preview-session",
        updatedAt: Date.now(),
        modelProvider: "openai-codex",
        model: "gpt-5.5",
      },
    );
    closeOpenClawAgentDatabasesForTest();
    const sqlitePath = path.join(state.agentDir(), "openclaw-agent.sqlite");
    const database = new DatabaseSync(sqlitePath);
    database
      .prepare("UPDATE session_nodes SET entry_valid = 0 WHERE session_key = ?")
      .run(sessionKey);
    database.close();
    expect(() =>
      listSessionEntriesReadOnly({ storePath, agentId: "main", env: state.env }),
    ).toThrow("invalid persisted session row requires repair");

    const preview = await maybeRepairCodexSessionRoutes({
      cfg: {},
      env: state.env,
      shouldRepair: false,
    });

    expect(preview).toMatchObject({
      scannedStores: 1,
      repairedStores: 0,
      repairedSessions: 0,
      changes: [],
    });
    expect(preview.warnings.join("\n")).toContain("Affected sessions: 1.");
    const verifier = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      expect(
        verifier
          .prepare("SELECT entry_valid FROM session_nodes WHERE session_key = ?")
          .get(sessionKey),
      ).toEqual({ entry_valid: 0 });
    } finally {
      verifier.close();
    }
  });

  it("preserves the selected Codex account across auth migration, SQLite sessions, and status", async () => {
    const state = await makeTestState();
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const sessionKey = "agent:main:main";
    const sessionUpdatedAt = Date.now();
    const legacyConfig = {
      auth: {
        profiles: {
          "openai:default": { provider: "openai", mode: "api_key" },
          "openai-codex:peter": {
            provider: "openai-codex",
            mode: "oauth",
            email: "peter@example.com",
          },
          "openai-codex:default": {
            provider: "openai-codex",
            mode: "oauth",
            email: "kate@example.com",
          },
        },
        order: {
          openai: ["openai:default"],
          "openai-codex": ["openai-codex:peter", "openai-codex:default"],
        },
      },
      agents: { defaults: { agentRuntime: { id: "codex" } } },
    } as OpenClawConfig;
    await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "test-openai-api-key",
        },
        "openai-codex:peter": {
          type: "oauth",
          provider: "openai-codex",
          access: "peter-access",
          refresh: "peter-refresh",
          expires: 9_999_999_999_999,
          accountId: "peter-account",
          email: "peter@example.com",
        },
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "kate-access",
          refresh: "kate-refresh",
          expires: 9_999_999_999_999,
          accountId: "kate-account",
          email: "kate@example.com",
        },
      },
      order: {
        openai: ["openai:default"],
        "openai-codex": ["openai-codex:peter", "openai-codex:default"],
      },
    });
    await replaceSessionEntry(
      { storePath, sessionKey, env: state.env },
      {
        sessionId: "selected-kate-session",
        updatedAt: sessionUpdatedAt,
        modelProvider: "openai",
        model: "gpt-5.5",
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "user",
        agentRuntimeOverride: "codex",
      },
    );
    const peterSessionKey = "agent:main:telegram:default:direct:5550100999";
    await replaceSessionEntry(
      { storePath, sessionKey: peterSessionKey, env: state.env },
      {
        sessionId: "selected-peter-session",
        updatedAt: sessionUpdatedAt + 1,
        modelProvider: "openai",
        model: "gpt-5.5",
        authProfileOverride: "openai-codex:peter",
        authProfileOverrideSource: "auto",
      },
    );
    expect(
      loadSessionEntry({ storePath, sessionKey: peterSessionKey, env: state.env }),
    ).toMatchObject({ authProfileOverride: "openai-codex:peter" });
    const missingProfileSessionKey = "agent:main:discord:default:direct:5550100888";
    await replaceSessionEntry(
      { storePath, sessionKey: missingProfileSessionKey, env: state.env },
      {
        sessionId: "missing-profile-session",
        updatedAt: sessionUpdatedAt + 2,
        modelProvider: "openai",
        model: "gpt-5.5",
        authProfileOverride: "openai-codex:missing",
        authProfileOverrideSource: "user",
      },
    );
    expect(fs.existsSync(storePath)).toBe(false);

    const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({
      cfg: legacyConfig,
      env: state.env,
    });
    expect(profileIdMap.get("openai-codex:default")).toBe("openai:chatgpt-default");
    expect(profileIdMap.get("openai-codex:peter")).toBe("openai:peter");
    const cfg = maybeRepairOpenAICodexAuthConfig(legacyConfig, { profileIdMap }).config;
    const migration = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg,
      env: state.env,
      prompter: makePrompter(true),
      openAICodexAuthProfileIdMap: profileIdMap,
    });
    expect(migration.warnings).toEqual([]);
    expect(loadPersistedAuthProfileStore(state.agentDir())?.order?.openai).toEqual([
      "openai:peter",
      "openai:chatgpt-default",
      "openai:default",
    ]);

    const repairParams = {
      cfg,
      env: state.env,
      authProfileIdMap: profileIdMap,
    };
    expect(
      listSessionEntriesReadOnly({ storePath, agentId: "main", env: state.env }).map(
        ({ entry }) => entry.authProfileOverride,
      ),
    ).toEqual(expect.arrayContaining(["openai-codex:default", "openai-codex:peter"]));
    const preview = await maybeRepairCodexSessionRoutes({ ...repairParams, shouldRepair: false });
    expect(preview.repairedSessions).toBe(0);
    expect(preview.warnings.join("\n")).toContain("Affected sessions: 2.");

    const sessionRepair = await maybeRepairCodexSessionRoutes({
      ...repairParams,
      shouldRepair: true,
    });
    expect(sessionRepair.repairedSessions).toBe(2);
    const selectedSession = loadSessionEntry({ storePath, sessionKey, env: state.env });
    expect(selectedSession).toMatchObject({
      authProfileOverride: "openai:chatgpt-default",
      authProfileOverrideSource: "user",
    });
    expect(
      loadSessionEntry({ storePath, sessionKey: peterSessionKey, env: state.env }),
    ).toMatchObject({
      authProfileOverride: "openai:peter",
      authProfileOverrideSource: "auto",
    });
    expect(
      loadSessionEntry({ storePath, sessionKey: missingProfileSessionKey, env: state.env }),
    ).toMatchObject({
      authProfileOverride: "openai-codex:missing",
      authProfileOverrideSource: "user",
      updatedAt: sessionUpdatedAt + 2,
    });
    await expect(
      maybeRepairCodexSessionRoutes({ ...repairParams, shouldRepair: true }),
    ).resolves.toMatchObject({ repairedSessions: 0, changes: [] });

    await expectSelectedCodexAccountStatus({ cfg, state, sessionKey, storePath });
  });

  it("renames legacy OpenAI Codex auth profiles while archiving the untouched source", async () => {
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

    const result = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      env: state.env,
      prompter: makePrompter(true),
      now: () => 789,
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.changes).toEqual([
      expect.stringContaining("Migrated auth profile JSON"),
      `Migrated 1 OpenAI Codex auth profile(s) in ${authPath} to provider "openai".`,
    ]);
    expect(result.warnings).toStrictEqual([]);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toEqual({
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
    expect(fs.existsSync(authPath)).toBe(false);
    const [archive] = listMigratedArchives(authPath);
    expect(JSON.parse(fs.readFileSync(archive!, "utf8"))).toEqual(legacy);
  });

  it("canonicalizes a mixed Codex store before importing it into SQLite", async () => {
    const state = await makeTestState();
    const authPath = await writeLegacyAuthProfilesJson(state, {
      version: 1,
      profiles: {
        "openai:media-api": {
          type: "api_key",
          provider: "openai",
          key: "test-api-key",
        },
        "openai-codex:qa-oauth": {
          type: "oauth",
          provider: "openai-codex",
          access: "test-access",
          refresh: "test-refresh",
          expires: Date.UTC(2036, 0, 1),
          accountId: "qa-codex-account",
        },
      },
      order: {
        openai: ["openai:media-api"],
        "openai-codex": ["openai-codex:qa-oauth"],
      },
    });

    const sqliteMigration = await maybeMigrateAuthProfileJsonStoresToSqlite({
      cfg: {},
      env: state.env,
      prompter: makePrompter(true),
      now: () => 791,
    });
    expect(sqliteMigration.warnings).toStrictEqual([]);
    expect(fs.existsSync(authPath)).toBe(false);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toMatchObject({
      profiles: {
        "openai:media-api": {
          type: "api_key",
          provider: "openai",
        },
        "openai:qa-oauth": {
          type: "oauth",
          provider: "openai",
          accountId: "qa-codex-account",
        },
      },
      order: { openai: ["openai:qa-oauth", "openai:media-api"] },
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
