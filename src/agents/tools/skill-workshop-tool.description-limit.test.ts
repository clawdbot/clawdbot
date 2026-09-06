import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-workshop-description-state-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("skill_workshop description validation", () => {
  it("lets the proposal service explain overlong descriptions", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-description-limit-");
    const tool = createSkillWorkshopTool({
      config: {} satisfies OpenClawConfig,
      workspaceDir,
      agentId: "main",
      env: testState.env,
    });
    const args = {
      action: "create" as const,
      name: "Long Description",
      description: "x".repeat(161),
      proposal_content: "# Long Description\n",
    };
    const call = {
      type: "toolCall" as const,
      id: "call-long-description",
      name: "skill_workshop",
      arguments: args,
    };
    expect(validateToolArguments(tool, call)).toEqual(args);

    await expect(tool.execute(call.id, args)).rejects.toThrow(
      "Skill proposal description is too large (161 bytes, max 160).",
    );
  });
});
