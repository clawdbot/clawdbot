import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDoctorConfigSnapshot } from "../commands/doctor-config-snapshot.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWriteConfigHealth } from "./doctor-health-contribution-runners.config.js";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

const mocks = vi.hoisted(() => ({
  removeAuthProfilesAcrossOwnerStores: vi.fn(async () => true),
  replaceConfigFile: vi.fn(async (_params: unknown) => undefined),
}));

vi.mock("../agents/auth-profiles.js", () => ({
  removeAuthProfilesAcrossOwnerStores: mocks.removeAuthProfilesAcrossOwnerStores,
}));

vi.mock("../commands/doctor/shared/config-flow-steps.js", () => ({
  restoreDoctorConfigEnvRefs: (cfg: OpenClawConfig) => cfg,
}));

vi.mock("../config/config.js", () => ({
  transformConfigFile: async ({
    transform,
    ...options
  }: Parameters<typeof import("../config/config.js").transformConfigFile>[0]) => {
    const { nextConfig } = await transform(
      {},
      { snapshot: createDoctorConfigSnapshot(), previousHash: null, attempt: 0 },
      {},
    );
    return mocks.replaceConfigFile({ ...options, nextConfig });
  },
}));

vi.mock("../config/logging.js", () => ({
  logConfigUpdated: vi.fn(),
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  applyWizardMetadata: (cfg: OpenClawConfig) => cfg,
}));

function createContext(): DoctorHealthFlowContext {
  const cfg = { gateway: { mode: "local" } } satisfies OpenClawConfig;
  return {
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    options: {},
    prompter: {} as DoctorHealthFlowContext["prompter"],
    configResult: {
      cfg,
      retiredAuthProfileCleanupPlans: [
        { agentDir: "/tmp/openclaw/agents/main", profileIds: ["anthropic:claude-cli"] },
      ],
    },
    cfg,
    cfgForPersistence: {},
    sourceConfigValid: true,
    configPath: "/tmp/openclaw.json",
  };
}

describe("Doctor retired auth profile cleanup", () => {
  beforeEach(() => {
    mocks.removeAuthProfilesAcrossOwnerStores.mockClear().mockResolvedValue(true);
    mocks.replaceConfigFile.mockClear().mockResolvedValue(undefined);
  });

  it("removes retired profiles only after the repaired config commits", async () => {
    await runWriteConfigHealth(createContext());

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(mocks.removeAuthProfilesAcrossOwnerStores).toHaveBeenCalledWith({
      agentDir: "/tmp/openclaw/agents/main",
      profileIds: ["anthropic:claude-cli"],
    });
    expect(mocks.replaceConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeAuthProfilesAcrossOwnerStores.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps retired profiles when the repaired config write fails", async () => {
    mocks.replaceConfigFile.mockRejectedValueOnce(new Error("write failed"));

    await expect(runWriteConfigHealth(createContext())).rejects.toThrow("write failed");

    expect(mocks.removeAuthProfilesAcrossOwnerStores).not.toHaveBeenCalled();
  });
});
