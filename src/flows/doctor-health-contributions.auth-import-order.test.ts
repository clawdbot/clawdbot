// Regression for #130018: the interactive auth-profile health flow must
// canonicalize config-backed legacy codex profile ids BEFORE the SQLite
// migration imports them. Importing from a legacy config would archive the
// credentials under ids the canonical runtime never selects, so the operator
// loses the imported credential after Doctor runs. The migration runs for
// real against an isolated state dir; only the provider-runtime and note
// layers are stubbed, because they are not the surface under test and their
// runtime loading is out of scope for a unit lane.
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
import type { DoctorHealthFlowContext } from "./doctor-health-contributions.js";
import "./doctor-health-contributions.js";

vi.mock("../commands/doctor-auth-legacy-oauth.js", () => ({
  maybeRepairLegacyOAuthProfileIds: vi.fn(async (cfg: OpenClawConfig) => ({
    config: cfg,
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

type AuthHealthContribution = {
  id: string;
  run: (ctx: DoctorHealthFlowContext) => Promise<void>;
};

function resolveAuthProfilesHealthContribution(): AuthHealthContribution {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.doctorHealthContributionsTestApi")
  ] as {
    resolveDoctorHealthContributions(): Array<{
      id: string;
      run: (ctx: DoctorHealthFlowContext) => Promise<void>;
    }>;
  };
  const contribution = api
    .resolveDoctorHealthContributions()
    .find((entry) => entry.id === "doctor:auth-profiles");
  if (!contribution) {
    throw new Error("doctor:auth-profiles contribution is not registered");
  }
  return contribution;
}

function makeAutoFixPrompter(): DoctorPrompter {
  return {
    confirm: vi.fn(async () => false),
    confirmAutoFix: vi.fn(async () => true),
    confirmAggressiveAutoFix: vi.fn(async () => false),
    confirmRuntimeRepair: vi.fn(async () => false),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair: true,
    shouldForce: false,
    repairMode: {
      shouldRepair: true,
      shouldForce: false,
      nonInteractive: true,
      canPrompt: false,
      updateInProgress: false,
    },
  };
}

function makeAuthHealthContext(params: {
  state: OpenClawTestState;
  cfg: OpenClawConfig;
}): DoctorHealthFlowContext {
  return {
    runtime: {} as never,
    options: { nonInteractive: true } as never,
    prompter: makeAutoFixPrompter(),
    configResult: {} as never,
    cfg: params.cfg,
    cfgForPersistence: params.cfg,
    sourceConfigValid: true,
    configPath: path.join(params.state.stateDir, "openclaw.json"),
    env: params.state.env,
  } as DoctorHealthFlowContext;
}

function makeLegacyCodexConfig(): OpenClawConfig {
  return {
    auth: {
      profiles: {
        "openai-codex:main": {
          type: "api_key",
          provider: "openai-codex",
          key: "sk-codex-main",
        },
      },
    },
  } as unknown as OpenClawConfig;
}

function importedProfileIds(params: { state: OpenClawTestState }): string[] {
  const agentStore = loadPersistedAuthProfileStore(params.state.agentDir())?.profiles ?? {};
  const sharedStore = loadPersistedSharedAuthProfileStore(params.state.env)?.profiles ?? {};
  return [...new Set([...Object.keys(agentStore), ...Object.keys(sharedStore)])].toSorted();
}

function importedProfile(params: { state: OpenClawTestState; profileId: string }): unknown {
  return (
    loadPersistedAuthProfileStore(params.state.agentDir())?.profiles[params.profileId] ??
    loadPersistedSharedAuthProfileStore(params.state.env)?.profiles[params.profileId]
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

describe("doctor auth-profile health config import order", () => {
  it("archives config-backed legacy codex credentials under canonical ids", async () => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-doctor-auth-import-order-",
      env: { OPENCLAW_AGENT_DIR: undefined },
    });
    states.push(state);

    await resolveAuthProfilesHealthContribution().run(
      makeAuthHealthContext({ state, cfg: makeLegacyCodexConfig() }),
    );

    expect(importedProfileIds({ state })).toContain("openai:main");
    expect(importedProfileIds({ state })).not.toContain("openai-codex:main");
    expect(importedProfile({ state, profileId: "openai:main" })).toMatchObject({
      type: "api_key",
      key: "sk-codex-main",
    });
  });
});
