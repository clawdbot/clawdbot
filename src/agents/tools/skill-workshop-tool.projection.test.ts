import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { createConfiguredSkillWorkshopTool } from "./skill-workshop-tool-factory.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-workshop-projection-state-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("skill_workshop model projection", () => {
  it.each([
    {
      provider: "anthropic",
      model: "small-context",
      modelContextWindowTokens: 8_192,
      maxChars: 2_867,
      contentIncluded: false,
    },
    {
      provider: "openai",
      model: "large-context",
      modelContextWindowTokens: 200_000,
      maxChars: 70_000,
      contentIncluded: true,
    },
  ])(
    "projects complete per-artifact inspection for $provider/$model",
    async ({ modelContextWindowTokens, maxChars, contentIncluded }) => {
      const workspaceDir = await tempDirs.make("openclaw-skill-workshop-inspect-budget-");
      const tool = createConfiguredSkillWorkshopTool({
        workspaceDir,
        config: {},
        agentId: "main",
        modelContextWindowTokens,
        run: { env: testState.env },
      });
      const created = await tool.execute("create-large", {
        action: "create",
        name: "large-proposal",
        description: "Large proposal",
        proposal_content: `# Large proposal\n\nMODEL_VISIBLE_PROPOSAL_BODY\n${"p".repeat(10_000)}`,
        support_files: [
          {
            path: "references/large.txt",
            content: `MODEL_VISIBLE_SUPPORT_BODY\n${"s".repeat(10_000)}`,
          },
        ],
      });

      const inspected = await tool.execute("inspect-large", {
        action: "inspect",
        proposal_id: (created.details as { id: string }).id,
      });
      const text = inspected.content[0]?.type === "text" ? inspected.content[0].text : "";

      expect(text.length).toBeLessThanOrEqual(maxChars);
      expect(text).toContain("large-proposal");
      expect(text).toContain("references/large.txt");
      expect(text.includes("MODEL_VISIBLE_PROPOSAL_BODY")).toBe(contentIncluded);
      expect(text.includes("Content omitted")).toBe(!contentIncluded);
      expect(inspected.details).not.toHaveProperty("proposalContent");
      expect(inspected.details).not.toHaveProperty("supportFiles");
      expect(inspected.details).toMatchObject({ inspect: { contentIncluded } });

      const support = await tool.execute("inspect-support", {
        action: "inspect",
        proposal_id: (created.details as { id: string }).id,
        artifact_path: "references/large.txt",
      });
      const supportText = support.content[0]?.type === "text" ? support.content[0].text : "";
      expect(supportText.length).toBeLessThanOrEqual(maxChars);
      expect(supportText.includes("MODEL_VISIBLE_SUPPORT_BODY")).toBe(contentIncluded);
      expect(supportText).not.toContain("MODEL_VISIBLE_PROPOSAL_BODY");
      expect(support.details).toMatchObject({
        inspect: { artifactPath: "references/large.txt", contentIncluded },
      });
    },
  );

  it("keeps a selected small artifact complete when its manifest is oversized", async () => {
    const workspaceDir = await tempDirs.make("openclaw-skill-workshop-manifest-budget-");
    const supportFiles = Array.from({ length: 16 }, (_, index) => ({
      path: `references/${String(index).padStart(2, "0")}-${"x".repeat(140)}.txt`,
      content: index === 15 ? "SELECTED_SUPPORT_BODY" : `UNSELECTED_SUPPORT_${index}`,
    }));
    const tool = createConfiguredSkillWorkshopTool({
      workspaceDir,
      config: {},
      agentId: "main",
      modelContextWindowTokens: 8_192,
      run: { env: testState.env },
    });
    const created = await tool.execute("create-many", {
      action: "create",
      name: "many-artifacts",
      description: "Many support artifacts",
      proposal_content: "# Many artifacts\n",
      support_files: supportFiles,
    });
    const selected = supportFiles.at(-1);
    if (!selected) {
      throw new Error("expected selected support artifact");
    }

    const inspected = await tool.execute("inspect-selected", {
      action: "inspect",
      proposal_id: (created.details as { id: string }).id,
      artifact_path: selected.path,
    });
    const text = inspected.content[0]?.type === "text" ? inspected.content[0].text : "";

    expect(text.length).toBeLessThanOrEqual(2_867);
    expect(text).toContain("SELECTED_SUPPORT_BODY");
    expect(text).not.toContain("UNSELECTED_SUPPORT_0");
    expect(text).toContain("more artifacts in result metadata");
    expect(inspected.details).toMatchObject({ inspect: { contentIncluded: true } });
  });
});
