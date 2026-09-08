import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  createAuthProfileMigrationSourceReceipt,
  type AuthProfileMigrationSourceReceipt,
} from "../commands/doctor-auth-migration-receipts.js";
import type { DoctorPrompter } from "../commands/doctor-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
} from "./doctor-health-contributions.test-support.js";

vi.mock("../commands/doctor-auth-legacy-oauth.js", () => ({
  maybeRepairLegacyOAuthProfileIds: vi.fn(async (config: OpenClawConfig) => ({
    config,
    retiredProfileCleanupPlans: [],
  })),
}));

vi.mock("../commands/doctor-model-catalog-credentials.js", () => ({
  maybeMigrateModelCatalogCredentials: vi.fn(async () => undefined),
}));

vi.mock("../commands/doctor-auth.js", () => ({
  noteAuthProfileHealth: vi.fn(async () => undefined),
  noteLegacyCodexProviderOverride: vi.fn(() => undefined),
  noteSharedAuthStoreStatus: vi.fn(() => undefined),
}));

const states: OpenClawTestState[] = [];
const { recordAuthProfileMigrationImported } = (globalThis as Record<PropertyKey, unknown>)[
  Symbol.for("openclaw.authProfileMigrationReceiptsTestApi")
] as {
  recordAuthProfileMigrationImported: (receipt: AuthProfileMigrationSourceReceipt) => void;
};

function makePrompter(shouldRepair: boolean): DoctorPrompter {
  return {
    confirm: vi.fn(async () => false),
    confirmAutoFix: vi.fn(async () => shouldRepair),
    confirmAggressiveAutoFix: vi.fn(async () => false),
    confirmRuntimeRepair: vi.fn(async () => false),
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

function makeLegacyConfig(): OpenClawConfig {
  return {
    auth: {
      profiles: {
        "openai:bravo": {
          provider: "openai",
          mode: "api_key",
        },
        "openai-codex:bravo": {
          provider: "openai-codex",
          mode: "oauth",
        },
      },
      order: { "openai-codex": ["openai-codex:bravo"] },
    },
  } as OpenClawConfig;
}

async function makeState(): Promise<OpenClawTestState> {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-auth-import-order-",
    env: { OPENCLAW_AGENT_DIR: undefined },
  });
  states.push(state);
  return state;
}

async function writeLegacyRotationState(state: OpenClawTestState): Promise<string> {
  return await state.writeText(
    "agents/main/agent/auth-state.json",
    `${JSON.stringify({
      version: 1,
      order: { "openai-codex": ["openai-codex:bravo"] },
      lastGood: { "openai-codex": "openai-codex:bravo" },
      usageStats: { "openai-codex:bravo": { lastUsed: 123 } },
    })}\n`,
  );
}

async function writeLegacyCredentialStore(state: OpenClawTestState): Promise<string> {
  return await state.writeText(
    "agents/main/agent/auth-profiles.json",
    `${JSON.stringify({
      version: 1,
      profiles: {
        "openai:bravo": {
          type: "api_key",
          provider: "openai",
          key: "existing-key",
        },
        "openai-codex:bravo": {
          type: "oauth",
          provider: "openai-codex",
          access: "legacy-access",
          refresh: "legacy-refresh",
          expires: 1_900_000_000_000,
        },
      },
    })}\n`,
  );
}

function loadMigratedStore(state: OpenClawTestState) {
  return (
    loadPersistedAuthProfileStore(state.agentDir()) ??
    loadPersistedSharedAuthProfileStore(state.env)
  );
}

function authProfilesContribution() {
  const contribution = resolveDoctorHealthContributions().find(
    (entry) => entry.id === "doctor:auth-profiles",
  );
  if (!contribution) {
    throw new Error("doctor:auth-profiles contribution is not registered");
  }
  return contribution;
}

afterEach(async () => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("interactive Doctor auth migration", () => {
  it.each(["failed", "completed", "declined"] as const)(
    "reports interrupted archive recovery when the remaining migration is %s",
    async (outcome) => {
      const state = await makeState();
      const sourcePath = await state.writeText("credentials/oauth.json", "{}\n");
      const sourceBytes = fs.readFileSync(sourcePath);
      const receipt = createAuthProfileMigrationSourceReceipt({
        sourcePath,
        sourceBytes,
        sourceRecordCount: 0,
        targetDatabasePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
        targetTable: "auth_profile_store",
        env: state.env,
      });
      recordAuthProfileMigrationImported(receipt);
      if (outcome === "failed") {
        // A persisted receipt with an invalid target cannot be safely resumed.
        openOpenClawStateDatabase({ env: state.env })
          .db.prepare("UPDATE migration_sources SET target_table = ? WHERE source_key = ?")
          .run("invalid_target", receipt.sourceKey);
      }
      const remainingPath = outcome === "declined" ? await writeLegacyCredentialStore(state) : null;
      const prompter = makePrompter(false);
      const ctx = createDoctorHealthFlowContext({
        cfg: {},
        prompter,
        env: state.env,
        configPath: path.join(state.stateDir, "openclaw.json"),
      });
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      await authProfilesContribution().run(ctx);

      const output = stripVTControlCharacters(
        stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
      )
        .replaceAll("│", "")
        .replace(/\s+/g, " ");
      stdout.mockRestore();
      if (outcome === "failed") {
        expect(output).toContain("Doctor warnings");
        expect(
          output.match(/Could not finalize an interrupted auth profile archive/g),
        ).toHaveLength(1);
        expect(output).toContain("invalid pending auth profile migration receipt");
        expect(fs.readFileSync(sourcePath)).toEqual(sourceBytes);
        expect(fs.existsSync(receipt.archivePath)).toBe(false);
      } else {
        expect(output).toContain("Doctor changes");
        expect(output.match(/Finalized interrupted auth profile archive/g)).toHaveLength(1);
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(fs.readFileSync(receipt.archivePath)).toEqual(sourceBytes);
      }
      if (remainingPath) {
        expect(prompter.confirmAutoFix).toHaveBeenCalledOnce();
        expect(fs.existsSync(remainingPath)).toBe(true);
      } else {
        expect(prompter.confirmAutoFix).not.toHaveBeenCalled();
      }
    },
  );

  it("commits config credentials and standalone state with one mapping after acceptance", async () => {
    const state = await makeState();
    const cfg = makeLegacyConfig();
    await writeLegacyCredentialStore(state);
    await writeLegacyRotationState(state);
    const ctx = createDoctorHealthFlowContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      prompter: makePrompter(true),
      env: state.env,
      configPath: path.join(state.stateDir, "openclaw.json"),
    });

    await authProfilesContribution().run(ctx);

    expect(loadMigratedStore(state)).toMatchObject({
      profiles: {
        "openai:bravo": { key: "existing-key" },
        "openai:chatgpt-bravo": { access: "legacy-access" },
      },
      order: { openai: ["openai:chatgpt-bravo"] },
      lastGood: { openai: "openai:chatgpt-bravo" },
      usageStats: { "openai:chatgpt-bravo": { lastUsed: 123 } },
    });
    expect(ctx.cfg.auth?.profiles).toHaveProperty("openai:chatgpt-bravo");
    expect(ctx.cfg.auth?.profiles).not.toHaveProperty("openai-codex:bravo");
    expect(ctx.cfg.auth?.order?.openai).toEqual(["openai:chatgpt-bravo"]);
  });

  it("leaves config and standalone state unchanged when migration is declined", async () => {
    const state = await makeState();
    const cfg = makeLegacyConfig();
    const authPath = await writeLegacyCredentialStore(state);
    const statePath = await writeLegacyRotationState(state);
    const ctx = createDoctorHealthFlowContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      prompter: makePrompter(false),
      env: state.env,
      configPath: path.join(state.stateDir, "openclaw.json"),
    });

    await authProfilesContribution().run(ctx);

    expect(ctx.cfg).toEqual(cfg);
    expect(fs.existsSync(authPath)).toBe(true);
    expect(fs.existsSync(statePath)).toBe(true);
    expect(loadMigratedStore(state)).toBeNull();
  });
});
