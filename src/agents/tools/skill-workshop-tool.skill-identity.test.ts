import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { writeWorkspaceSkills } from "../../skills/test-support/e2e-test-helpers.js";
import { readProposalFrontmatter } from "../../skills/workshop/frontmatter.js";
import { inspectSkillProposal } from "../../skills/workshop/service.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

it.each([
  { action: "update", preparation: "read" },
  { action: "patch", preparation: "read" },
  { action: "patch", preparation: "prepare_patch" },
] as const)(
  "keeps the $action target when following $preparation guidance",
  async ({ action, preparation }) => {
    await withOpenClawTestState(
      { label: "workshop-guided-target", scenario: "minimal" },
      async (state) => {
        const oldString = "Check the starting conditions.";
        const newString = "Check the starting conditions and record the result.";
        await writeWorkspaceSkills(state.workspaceDir, [
          {
            name: "alpha-guide",
            description: "Intended procedure",
            metadata: '{"openclaw":{"skillKey":"beta-guide"}}',
            body: `# Alpha\n\n${oldString}\n`,
          },
          {
            name: "beta-guide",
            description: "Other procedure",
            metadata: '{"openclaw":{"skillKey":"beta-key"}}',
            body: `# Beta\n\n${oldString}\n`,
          },
        ]);
        const paths = ["alpha-guide", "beta-guide"].map((name) =>
          path.join(state.workspaceDir, "skills", name, "SKILL.md"),
        );
        const originals = await Promise.all(paths.map((file) => fs.readFile(file, "utf8")));
        const tool = createSkillWorkshopTool({
          workspaceDir: state.workspaceDir,
          config: {},
          env: state.env,
          proposalOnly: true,
          updateProposals: true,
          proposalMutationBudget: { remaining: 1 },
        });
        let selector: string | undefined;
        let readText = "";
        if (preparation === "prepare_patch") {
          const prepared = await tool.execute("prepare", {
            action: "prepare_patch",
            skill_name: "alpha-guide",
            old_string: oldString,
          });
          const text = prepared.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
          selector = /^Skill: (.+) \(\d+ bytes\)$/m.exec(text)?.[1];
        } else {
          const failure = await tool
            .execute("without-read", {
              action,
              skill_name: "alpha-guide",
              ...(action === "patch"
                ? { old_string: oldString, new_string: newString }
                : { proposal_content: "# Improve the procedure\n" }),
            })
            .then(
              () => {
                throw new Error("Expected a complete-read instruction");
              },
              (error: unknown) => {
                if (!(error instanceof Error)) {
                  throw error;
                }
                return error.message;
              },
            );
          selector = /call action=read with skill_name "([^"]+)"/.exec(failure)?.[1];
          const read = await tool.execute("guided-read", { action: "read", skill_name: selector });
          readText = read.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
        }
        if (!selector) {
          throw new Error("Tool guidance omitted the skill selector");
        }

        const proposed = await tool.execute("guided-mutation", {
          action,
          skill_name: selector,
          ...(action === "patch"
            ? { old_string: oldString, new_string: newString }
            : { proposal_content: `${readText}\nRecord the verified result.\n` }),
        });
        const proposalId = (proposed.details as { id: string }).id;
        const stored = await inspectSkillProposal(proposalId, {
          workspaceDir: state.workspaceDir,
          env: state.env,
        });
        expect(stored?.record.target).toMatchObject({
          skillName: "alpha-guide",
          skillKey: "beta-guide",
          skillFile: paths[0],
        });
        expect(readProposalFrontmatter(stored?.content ?? "")?.name).toBe("alpha-guide");
        expect(proposed.content).toEqual([
          { type: "text", text: expect.stringContaining("for alpha-guide.") },
        ]);
        const inspected = await tool.execute("inspect", {
          action: "inspect",
          proposal_id: proposalId,
        });
        expect(inspected.content).toEqual([
          { type: "text", text: expect.stringContaining("Skill: alpha-guide\n") },
        ]);
        expect(await Promise.all(paths.map((file) => fs.readFile(file, "utf8")))).toEqual(
          originals,
        );
      },
    );
  },
);

it("keeps an existing skill name through proposal revision and apply", async () => {
  await withOpenClawTestState(
    { label: "workshop-proposal-name", scenario: "minimal" },
    async (state) => {
      const tool = createSkillWorkshopTool({
        workspaceDir: state.workspaceDir,
        config: {},
        env: state.env,
        updateProposals: true,
      });
      const created = await tool.execute("seed-create", {
        action: "create",
        name: "alpha-guide",
        description: "Intended procedure",
        proposal_content:
          '---\nmetadata: {"openclaw":{"skillKey":"beta-guide"}}\n---\n\n# Alpha\n\nCheck the starting conditions.\n',
      });
      await tool.execute("seed-apply", {
        action: "apply",
        proposal_id: (created.details as { id: string }).id,
      });
      await tool.execute("read", { action: "read", skill_name: "alpha-guide" });
      const updated = await tool.execute("update", {
        action: "update",
        skill_name: "alpha-guide",
        proposal_content: "# Alpha\n\nCheck the starting conditions and record the result.\n",
      });
      const proposalId = (updated.details as { id: string }).id;
      const proposed = await inspectSkillProposal(proposalId, {
        workspaceDir: state.workspaceDir,
        env: state.env,
      });
      expect(readProposalFrontmatter(proposed?.content ?? "")?.name).toBe("alpha-guide");

      const revised = await tool.execute("revise", {
        action: "revise",
        proposal_id: proposalId,
        proposal_content: `${proposed?.content}\nVerify the saved outcome.\n`,
      });
      const revision = await inspectSkillProposal(proposalId, {
        workspaceDir: state.workspaceDir,
        env: state.env,
      });
      expect(readProposalFrontmatter(revision?.content ?? "")?.name).toBe("alpha-guide");
      await tool.execute("apply", {
        action: "apply",
        proposal_id: proposalId,
        expected_revision_hash: (revised.details as { revisionHash: string }).revisionHash,
      });
      await expect(
        tool.execute("read-again", { action: "read", skill_name: "alpha-guide" }),
      ).resolves.toMatchObject({
        details: { skillName: "alpha-guide", skillKey: "beta-guide", contentIncluded: true },
      });
    },
  );
});
