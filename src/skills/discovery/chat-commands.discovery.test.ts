import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnv } from "../../test-utils/env.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import { expandExplicitSkillReferences, listSkillCommandsForWorkspace } from "./chat-commands.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));

describe("skill command discovery through workspace loading", () => {
  it.each(["workspace", "workshop"] as const)(
    "reports allowlist-hidden %s skills without loading another agent's skills",
    async (source) => {
      const root = tempDirs.make("openclaw-skill-command-discovery-");
      const workspaceDir = path.join(root, "workspace");
      const config = {
        plugins: { enabled: false },
        agents: {
          entries: {
            alpha: {
              agentDir: path.join(root, "alpha"),
              workspace: workspaceDir,
              skills: ["allowed"],
            },
            beta: { agentDir: path.join(root, "beta"), workspace: workspaceDir },
          },
        },
        skills: { allowBundled: [], entries: { disabled: { enabled: false } } },
      } satisfies OpenClawConfig;
      const skillRoot =
        source === "workshop"
          ? resolveWorkshopSkillsDir(config, "alpha")
          : path.join(workspaceDir, "skills");
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "allowed"),
        name: "allowed",
        description: "Allowed procedure",
      });
      for (const name of ["hidden", "disabled"]) {
        await writeSkill({
          dir: path.join(skillRoot, name),
          name,
          description: `${name} procedure`,
        });
      }
      await writeSkill({
        dir: path.join(resolveWorkshopSkillsDir(config, "beta"), "beta-only"),
        name: "beta-only",
        description: "Beta's private procedure",
      });
      const bundledSkillsDir = path.join(root, "bundled");
      await fs.mkdir(bundledSkillsDir);
      withEnv({ OPENCLAW_STATE_DIR: root, OPENCLAW_BUNDLED_SKILLS_DIR: bundledSkillsDir }, () => {
        const params = { workspaceDir, cfg: config, agentId: "alpha" };
        const skillCommands = listSkillCommandsForWorkspace(params);
        const allSkillCommands = listSkillCommandsForWorkspace({
          ...params,
          includeAllowlistHidden: true,
        });
        expect(skillCommands.map((command) => command.skillName)).toEqual(["allowed"]);
        expect(allSkillCommands.map((command) => command.skillName)).toEqual(["allowed", "hidden"]);
        for (const text of [
          "Use $hidden for this task.",
          "/hidden run it",
          "/skill hidden run it",
        ]) {
          expect(expandExplicitSkillReferences({ text, skillCommands, allSkillCommands })).toEqual({
            body: text,
            error:
              'Skill "hidden" is not available for this agent. Update the skill allowlist or choose an allowed skill.',
            skills: [],
          });
        }
        expect(
          listSkillCommandsForWorkspace({ ...params, skillFilter: ["hidden"] }).map(
            (command) => command.skillName,
          ),
        ).toEqual(["hidden"]);
      });
    },
  );
});
