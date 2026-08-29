import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import type { DoctorPrompter } from "../commands/doctor-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
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
          key: "existing-key",
        },
        "openai-codex:bravo": {
          provider: "openai-codex",
          mode: "api_key",
          key: "legacy-key",
        },
      },
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
  clearRuntimeAuthProfileStoreSnapshots();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("interactive Doctor auth migration", () => {
  it("commits config credentials and standalone state with one mapping after acceptance", async () => {
    const state = await makeState();
    const cfg = makeLegacyConfig();
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
        "openai:chatgpt-bravo": { key: "legacy-key" },
      },
      order: { openai: ["openai:chatgpt-bravo"] },
      lastGood: { openai: "openai:chatgpt-bravo" },
      usageStats: { "openai:chatgpt-bravo": { lastUsed: 123 } },
    });
    expect(ctx.cfg.auth?.profiles).toHaveProperty("openai:chatgpt-bravo");
    expect(ctx.cfg.auth?.profiles).not.toHaveProperty("openai-codex:bravo");
  });

  it("leaves config and standalone state unchanged when migration is declined", async () => {
    const state = await makeState();
    const cfg = makeLegacyConfig();
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
    expect(fs.existsSync(statePath)).toBe(true);
    expect(loadMigratedStore(state)).toBeNull();
  });
});
