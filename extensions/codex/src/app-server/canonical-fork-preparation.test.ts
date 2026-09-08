import { describe, expect, it } from "vitest";
import { resolveCanonicalCodexForkProjectInstructionPolicy } from "./canonical-fork-project-instructions.js";

describe("canonical Codex fork project-instruction policy", () => {
  it("replays same-workspace instructions with native project discovery disabled", () => {
    expect(
      resolveCanonicalCodexForkProjectInstructionPolicy({
        workspaceDir: "/repo",
        cwd: "/repo/.",
        agentWorkspaceDeveloperInstructions: "frozen native hierarchy",
      }),
    ).toEqual({
      developerInstructions: "frozen native hierarchy",
      configPatch: { project_doc_max_bytes: 0 },
    });
  });

  it("preserves native project discovery for a cross-workspace carrier", () => {
    expect(
      resolveCanonicalCodexForkProjectInstructionPolicy({
        workspaceDir: "/agent-workspace",
        cwd: "/native-repository",
        agentWorkspaceDeveloperInstructions: "frozen configured-root carrier",
      }),
    ).toEqual({
      developerInstructions: "frozen configured-root carrier",
      configPatch: undefined,
    });
  });

  it("replays a nested workspace hierarchy with native project discovery disabled", () => {
    expect(
      resolveCanonicalCodexForkProjectInstructionPolicy({
        workspaceDir: "/repo",
        cwd: "/repo/packages/service",
        agentWorkspaceDeveloperInstructions: "frozen root-to-nested hierarchy",
      }).configPatch,
    ).toEqual({ project_doc_max_bytes: 0 });
  });

  it("does not mistake a sibling path prefix for the configured workspace", () => {
    expect(
      resolveCanonicalCodexForkProjectInstructionPolicy({
        workspaceDir: "/repo",
        cwd: "/repo-other",
        agentWorkspaceDeveloperInstructions: "configured-root carrier",
      }).configPatch,
    ).toBeUndefined();
  });
});
