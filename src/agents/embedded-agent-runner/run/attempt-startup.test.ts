import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedRunAttemptParams } from "./types.js";

const mocks = vi.hoisted(() => ({
  applySkillEnvOverrides: vi.fn(),
  mapSandboxSkillEntriesForPrompt: vi.fn(),
}));

vi.mock("../../../skills/runtime/env-overrides.js", () => ({
  applySkillEnvOverrides: mocks.applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot: vi.fn(),
}));

vi.mock("../../../skills/runtime/embedded-run-entries.js", () => ({
  resolveEmbeddedRunSkillEntries: vi.fn(() => ({
    shouldLoadSkillEntries: true,
    skillEntries: [],
  })),
}));

vi.mock("../../../skills/loading/workspace.js", () => ({
  resolveSkillsPromptForRun: vi.fn(() => "skills prompt"),
}));

vi.mock("../sandbox-skills.js", () => ({
  resolveSandboxSkillRuntimeInputs: vi.fn(() => ({
    skillsEligibility: undefined,
    skillsPromptWorkspaceDir: "/tmp/workspace",
    skillsSnapshot: undefined,
    skillsWorkspaceDir: "/tmp/workspace",
    workspaceOnly: false,
  })),
  mapSandboxSkillEntriesForPrompt: mocks.mapSandboxSkillEntriesForPrompt,
  mapSandboxSkillUsagePaths: vi.fn(() => []),
}));

import { prepareEmbeddedAttemptSkills } from "./attempt-startup.js";

describe("prepareEmbeddedAttemptSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restores environment overrides when later preparation fails", () => {
    const restore = vi.fn();
    mocks.applySkillEnvOverrides.mockReturnValue(restore);
    mocks.mapSandboxSkillEntriesForPrompt.mockImplementation(() => {
      throw new Error("skill prompt mapping failed");
    });

    expect(() =>
      prepareEmbeddedAttemptSkills({
        attempt: { config: {} } as EmbeddedRunAttemptParams,
        effectiveWorkspace: "/tmp/workspace",
        sandbox: null,
        sessionAgentId: "main",
      }),
    ).toThrow("skill prompt mapping failed");
    expect(restore).toHaveBeenCalledOnce();
  });

  it("does not load skills or apply their environment during settled finalization", () => {
    const prepared = prepareEmbeddedAttemptSkills({
      attempt: { operation: "settled-tool-finalization" } as EmbeddedRunAttemptParams,
      effectiveWorkspace: "/tmp/workspace",
      sandbox: null,
      sessionAgentId: "main",
    });

    expect(prepared.skillsPrompt).toBe("");
    expect(prepared.skillsSnapshotForRun).toBeUndefined();
    expect(mocks.applySkillEnvOverrides).not.toHaveBeenCalled();
    expect(mocks.mapSandboxSkillEntriesForPrompt).not.toHaveBeenCalled();
  });
});
