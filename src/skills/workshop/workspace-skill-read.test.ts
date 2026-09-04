import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  listWritableWorkspaceSkillSummaries,
  readWritableWorkspaceSkill,
} from "./workspace-skill-read.js";

it("reads the named workspace skill when an earlier skill aliases its name", async () => {
  await withOpenClawTestState(
    { label: "workshop-skill-name", scenario: "minimal" },
    async (state) => {
      for (const [folder, name, skillKey, body] of [
        ["a-alias", "another-skill", "requested-skill", "Other skill instructions."],
        ["b-target", "requested-skill", "target-key", "Requested skill instructions."],
      ] as const) {
        const directory = path.join(state.workspaceDir, "skills", folder);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(
          path.join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: Workspace lookup fixture\nmetadata: {"openclaw":{"skillKey":"${skillKey}"}}\n---\n\n${body}\n`,
        );
      }

      const result = await readWritableWorkspaceSkill(state.workspaceDir, "requested-skill", {
        config: {},
      });

      expect(result.skillFile).toBe(
        path.join(state.workspaceDir, "skills", "b-target", "SKILL.md"),
      );
      expect(result.skillKey).toBe("target-key");
      expect(result.content).toContain("Requested skill instructions.");

      const summaries = listWritableWorkspaceSkillSummaries(state.workspaceDir, { config: {} });
      expect(summaries).toHaveLength(2);
      for (const summary of summaries) {
        const read = await readWritableWorkspaceSkill(state.workspaceDir, summary.name, {
          config: {},
        });
        expect(read.skillFile).toBe(summary.filePath);
      }
    },
  );
});
