import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCodexSessionRouteHealth } from "./doctor-health-contribution-runners.state.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

const mocks = vi.hoisted(() => ({
  maybeRepairCodexSessionRoutes: vi.fn(),
  note: vi.fn(),
}));

vi.mock("../commands/doctor/shared/codex-route-warnings.js", () => ({
  maybeRepairCodexSessionRoutes: mocks.maybeRepairCodexSessionRoutes,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: mocks.note,
}));

function createDoctorHealthContext(params: {
  cfg: DoctorHealthFlowContext["cfg"];
  env: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  configResult?: Omit<DoctorHealthFlowContext["configResult"], "cfg">;
}): DoctorHealthFlowContext {
  const { cfg, env, shouldRepair, configResult } = params;
  return {
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    options: {},
    prompter: {
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
        nonInteractive: true,
        canPrompt: false,
        updateInProgress: false,
      },
    },
    configResult: { cfg, ...configResult },
    cfg,
    cfgForPersistence: cfg,
    sourceConfigValid: true,
    configPath: "/tmp/openclaw-doctor-session-owner/openclaw.json",
    env,
  };
}

describe("Codex session doctor health owner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.maybeRepairCodexSessionRoutes.mockResolvedValue({
      scannedStores: 1,
      repairedStores: 1,
      repairedSessions: 1,
      changes: [],
      warnings: [],
    });
  });

  it("applies the exact ephemeral auth map after earlier session migration owners", async () => {
    const authProfileIdMap = new Map([["openai-codex:default", "openai:chatgpt-default"]]);
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-doctor-session-owner" };
    const cfg = {};
    const ctx = createDoctorHealthContext({
      cfg,
      env,
      shouldRepair: true,
      configResult: {
        openAICodexAuthProfileIdMap: authProfileIdMap,
        blockedCodexModelIdentities: ["codex\0gpt-5.6-sol"],
      },
    });

    await runCodexSessionRouteHealth(ctx);

    expect(mocks.maybeRepairCodexSessionRoutes).toHaveBeenCalledWith({
      cfg,
      env,
      shouldRepair: true,
      authProfileIdMap,
      blockedModelIdentities: new Set(["codex\0gpt-5.6-sol"]),
    });
  });

  it("keeps preview mode read-only without inventing an auth migration map", async () => {
    const cfg = {};
    const ctx = createDoctorHealthContext({
      cfg,
      env: {},
      shouldRepair: false,
    });

    await runCodexSessionRouteHealth(ctx);

    expect(mocks.maybeRepairCodexSessionRoutes).toHaveBeenCalledWith({
      cfg,
      env: {},
      shouldRepair: false,
    });
  });
});
