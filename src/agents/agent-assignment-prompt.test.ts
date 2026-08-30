import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildAgentAssignmentPrompt } from "./agent-assignment-prompt.js";

describe("buildAgentAssignmentPrompt", () => {
  it("omits the block when no agent was selected", () => {
    expect(buildAgentAssignmentPrompt({ config: {}, agentId: undefined })).toBeUndefined();
  });

  it("keeps the selected technical identity when optional metadata is absent", () => {
    expect(buildAgentAssignmentPrompt({ config: {}, agentId: "worker" })).toBe(
      [
        "## Agent Assignment",
        "OpenClaw config is authoritative for agent ID, name, specialist scope, and handoff boundary.",
        "Agent ID: worker",
      ].join("\n"),
    );
  });

  it("sanitizes and bounds human-authored assignment metadata", () => {
    const config = {
      agents: {
        entries: {
          worker: {
            identity: { name: "\nBuild\u200b Agent\r" },
            description: `  Owns\nimplementation.  ${"x".repeat(1_100)}😀`,
          },
        },
      },
    } satisfies OpenClawConfig;

    const prompt = buildAgentAssignmentPrompt({ config, agentId: "worker" });

    expect(prompt).toContain(
      "OpenClaw config is authoritative for agent ID, name, specialist scope, and handoff boundary.",
    );
    expect(prompt).toContain("Name: Build Agent");
    expect(prompt).toContain("Specialist scope and handoff boundary: Owns implementation.");
    expect(prompt).not.toContain("\nimplementation");
    expect(prompt).not.toContain("\u200b");
    expect(prompt).not.toContain("😀");
    expect(prompt?.split("Specialist scope and handoff boundary: ")[1]).toHaveLength(1_024);
  });
});
