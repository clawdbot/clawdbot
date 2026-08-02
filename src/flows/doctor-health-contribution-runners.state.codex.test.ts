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
    const ctx = {
      cfg,
      env,
      prompter: { shouldRepair: true },
      configResult: {
        cfg,
        openAICodexAuthProfileIdMap: authProfileIdMap,
        blockedCodexModelIdentities: ["codex\0gpt-5.6-sol"],
      },
    } as DoctorHealthFlowContext;

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
    const ctx = {
      cfg,
      env: {},
      prompter: { shouldRepair: false },
      configResult: { cfg },
    } as DoctorHealthFlowContext;

    await runCodexSessionRouteHealth(ctx);

    expect(mocks.maybeRepairCodexSessionRoutes).toHaveBeenCalledWith({
      cfg,
      env: {},
      shouldRepair: false,
    });
  });
});
