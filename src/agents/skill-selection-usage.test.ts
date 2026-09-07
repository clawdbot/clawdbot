import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import {
  bindWorkspaceSkillUsage,
  discardRunSkillUsage,
  discardRunWorkspaceSkillUsage,
} from "../skills/runtime/run-usage.js";
import type { SkillSnapshot, SkillUsagePath } from "../skills/types.js";
import { createOperationalRunInstanceRef } from "./admitted-run-context.js";
import { recordExplicitSkillSelectionsForRun } from "./skill-selection-usage.js";

function snapshotWithCommands(commands: SkillUsagePath[]): SkillSnapshot {
  return { prompt: "", skills: [], skillCommandUsagePaths: commands };
}

function workspaceCommand(
  readPath: string,
  skillFile = readPath,
  skillName = "demo",
): SkillUsagePath {
  return { readPath, skillFile, skillName, skillSource: "workspace" };
}

describe("explicit skill selection usage", () => {
  it("records only the exact selected workspace skill file", () => {
    const runId = "explicit-selection";
    const operationalRunInstance = createOperationalRunInstanceRef(runId);
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const selectedFile = path.resolve("workspace/skills/selected/SKILL.md");
    const otherFile = path.resolve("workspace/skills/other/SKILL.md");
    try {
      recordExplicitSkillSelectionsForRun({
        operationalRunInstance,
        selections: [{ name: "shared", path: selectedFile }],
        skillsSnapshot: snapshotWithCommands([
          workspaceCommand(selectedFile, selectedFile, "shared"),
          workspaceCommand(otherFile, otherFile, "shared"),
        ]),
      });

      expect(bindWorkspaceSkillUsage({ operationalRunInstance, skillFile: selectedFile })?.()).toBe(
        true,
      );
      expect(
        bindWorkspaceSkillUsage({ operationalRunInstance, skillFile: otherFile }),
      ).toBeUndefined();
    } finally {
      discardRunSkillUsage(runId);
      discardRunWorkspaceSkillUsage(operationalRunInstance);
      releaseAgentRunDelegatedAuthority(authority);
    }
  });

  it("fails closed for relative or ambiguous command paths", () => {
    const runId = "ambiguous-selection";
    const operationalRunInstance = createOperationalRunInstanceRef(runId);
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const sharedPath = path.resolve("workspace/skills/shared/SKILL.md");
    const firstFile = path.resolve("workspace/skills/first/SKILL.md");
    const secondFile = path.resolve("workspace/skills/second/SKILL.md");
    try {
      recordExplicitSkillSelectionsForRun({
        operationalRunInstance,
        selections: [
          { name: "relative", path: "skills/relative/SKILL.md" },
          { name: "ambiguous", path: sharedPath },
        ],
        skillsSnapshot: snapshotWithCommands([
          workspaceCommand(sharedPath, firstFile, "first"),
          workspaceCommand(sharedPath, secondFile, "second"),
        ]),
      });

      expect(
        bindWorkspaceSkillUsage({ operationalRunInstance, skillFile: firstFile }),
      ).toBeUndefined();
      expect(
        bindWorkspaceSkillUsage({ operationalRunInstance, skillFile: secondFile }),
      ).toBeUndefined();
    } finally {
      discardRunSkillUsage(runId);
      discardRunWorkspaceSkillUsage(operationalRunInstance);
      releaseAgentRunDelegatedAuthority(authority);
    }
  });

  it("does not lend a receipt to a replacement admission with the same run id", () => {
    const runId = "reused-run-id";
    const firstRun = createOperationalRunInstanceRef(runId);
    const firstAuthority = claimAgentRunDelegatedAuthority(firstRun);
    const skillFile = path.resolve("workspace/skills/demo/SKILL.md");
    recordExplicitSkillSelectionsForRun({
      operationalRunInstance: firstRun,
      selections: [{ name: "demo", path: skillFile }],
      skillsSnapshot: snapshotWithCommands([workspaceCommand(skillFile)]),
    });
    const firstGuard = bindWorkspaceSkillUsage({ operationalRunInstance: firstRun, skillFile });
    expect(firstGuard?.()).toBe(true);

    const replacementRun = createOperationalRunInstanceRef(runId);
    const replacementAuthority = claimAgentRunDelegatedAuthority(replacementRun);
    try {
      expect(firstGuard?.()).toBe(false);
      expect(
        bindWorkspaceSkillUsage({ operationalRunInstance: replacementRun, skillFile }),
      ).toBeUndefined();
    } finally {
      discardRunSkillUsage(runId);
      discardRunWorkspaceSkillUsage(firstRun);
      discardRunWorkspaceSkillUsage(replacementRun);
      releaseAgentRunDelegatedAuthority(firstAuthority);
      releaseAgentRunDelegatedAuthority(replacementAuthority);
    }
  });

  it("does not authorize non-workspace skill selections", () => {
    const runId = "bundled-selection";
    const operationalRunInstance = createOperationalRunInstanceRef(runId);
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const skillFile = path.resolve("bundled/skills/demo/SKILL.md");
    try {
      recordExplicitSkillSelectionsForRun({
        operationalRunInstance,
        selections: [{ name: "demo", path: skillFile }],
        skillsSnapshot: snapshotWithCommands([
          { ...workspaceCommand(skillFile), skillSource: "bundled" },
        ]),
      });
      expect(bindWorkspaceSkillUsage({ operationalRunInstance, skillFile })).toBeUndefined();
    } finally {
      discardRunSkillUsage(runId);
      discardRunWorkspaceSkillUsage(operationalRunInstance);
      releaseAgentRunDelegatedAuthority(authority);
    }
  });
});
