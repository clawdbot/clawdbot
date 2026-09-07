import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readSkillProposalRecord } from "../../skills/workshop/store.js";
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
    prefix: "openclaw-skill-workshop-support-paths-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("skill_workshop support paths", () => {
  it("rejects non-neighbor overlaps and persists distinct paths", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-tool-");
    const tool = createSkillWorkshopTool({ workspaceDir, env: testState.env });

    await expect(
      tool.execute("call-overlap", {
        action: "create",
        name: "Non-neighbor Support Path",
        description: "Reject separated path conflicts",
        proposal_content: "# Non-neighbor Support Path\n",
        support_files: [
          { path: "scripts/a/b", content: "bad\n" },
          { path: "scripts/a-b", content: "bad\n" },
          { path: "scripts/a", content: "bad\n" },
        ],
      }),
    ).rejects.toThrow("Support file paths cannot overlap: scripts/a and scripts/a/b");

    const result = await tool.execute("call-distinct", {
      action: "create",
      name: "Distinct Support Paths",
      description: "Keep distinct paths accepted",
      proposal_content: "# Distinct Support Paths\n",
      support_files: [
        { path: "scripts/a/b", content: "good\n" },
        { path: "scripts/a-b", content: "good\n" },
        { path: "references/a", content: "good\n" },
      ],
    });
    await expect(
      readSkillProposalRecord(
        (result.details as { id: string }).id,
        { config: {}, env: testState.env },
        {},
        { config: {} },
      ),
    ).resolves.toMatchObject({
      supportFiles: [{ path: "scripts/a/b" }, { path: "scripts/a-b" }, { path: "references/a" }],
    });
  });
});
