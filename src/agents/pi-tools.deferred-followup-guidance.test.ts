import { describe, expect, it } from "vitest";
import { applyDeferredFollowupToolDescriptions } from "./pi-tools.deferred-followup.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

function findToolDescription(toolName: string, senderIsOwner: boolean) {
  const tools = applyDeferredFollowupToolDescriptions([
    { name: "exec", description: "exec base" },
    { name: "process", description: "process base" },
    ...(senderIsOwner ? [{ name: "cron", description: "cron base" }] : []),
  ] as AnyAgentTool[]);
  const tool = tools.find((entry) => entry.name === toolName);
  return {
    toolNames: tools.map((entry) => entry.name),
    description: tool?.description ?? "",
  };
}

describe("createOpenClawCodingTools deferred follow-up guidance", () => {
  it("keeps cron-specific guidance when cron survives filtering", () => {
    const exec = findToolDescription("exec", true);
    const process = findToolDescription("process", true);

    expect(exec.toolNames).toContain("cron");
    expect(exec.description).toContain("use cron instead");
    expect(process.description).toContain("use cron for scheduled follow-ups");
  });

  it("drops cron-specific guidance when cron is unavailable", () => {
    const exec = findToolDescription("exec", false);
    const process = findToolDescription("process", false);

    expect(exec.toolNames).not.toContain("cron");
    expect(exec.description).not.toContain("use cron instead");
    expect(process.description).not.toContain("use cron for scheduled follow-ups");
  });
});
