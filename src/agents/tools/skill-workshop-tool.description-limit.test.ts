import fs from "node:fs/promises";
import path from "node:path";
import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveWorkshopSkillsDir } from "../../skills/workshop/skills-root.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createSkillWorkshopTool as createSkillWorkshopToolImpl } from "./skill-workshop-tool.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
const createSkillWorkshopTool = (
  options: Omit<Parameters<typeof createSkillWorkshopToolImpl>[0], "config" | "agentId"> & {
    config?: OpenClawConfig;
    agentId?: string;
  },
) => createSkillWorkshopToolImpl({ config: {}, agentId: "main", ...options });

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
    const tool = createSkillWorkshopTool({ workspaceDir, env: testState.env });
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

  it("lets the proposal service explain overlong collection descriptions", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-collection-description-limit-");
    const collectionReconcile = {};
    const tool = createSkillWorkshopTool({ workspaceDir, env: testState.env, collectionReconcile });
    const args = {
      action: "reconcile" as const,
      collection: [
        {
          action: "write" as const,
          name: "long-description",
          description: "x".repeat(161),
          content: "# Long Description\n",
        },
      ],
    };
    const call = {
      type: "toolCall" as const,
      id: "call-long-collection-description",
      name: "skill_workshop",
      arguments: args,
    };
    expect(validateToolArguments(tool, call)).toEqual(args);

    await expect(tool.execute(call.id, args)).rejects.toThrow(
      "Skill proposal description is too large (161 bytes, max 160).",
    );
    await expect(
      fs.access(
        path.join(
          resolveWorkshopSkillsDir({}, "main", testState.env),
          "long-description",
          "SKILL.md",
        ),
      ),
    ).rejects.toThrow();
    expect(collectionReconcile).not.toHaveProperty("result");
  });
});
