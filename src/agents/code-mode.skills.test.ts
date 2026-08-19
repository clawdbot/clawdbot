/** Tests Code Mode skills and read tools. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "../skills/loading/skill-contract.js";
import { resolveSkillsPrompt } from "../skills/loading/workspace-skill-prompt.js";
import { createFixtureSkillEntry } from "../skills/test-support/test-helpers.js";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import { resolveCodeModeSkills } from "./code-mode-skills.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  resetCodeModeTestState,
  pluginTool,
  createCodeModeHarness,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { createReadTool } from "./sessions/index.js";

function skillCandidate(params: {
  name: string;
  description: string;
  filePath: string;
  readContent?: string;
}): Skill {
  return {
    ...params,
    baseDir: params.filePath.replace(/\/[^/]+$/u, ""),
    sourceInfo: {
      path: params.filePath,
      source: "test",
      scope: "temporary",
      origin: "top-level",
    },
    disableModelInvocation: false,
    source: "test",
  };
}

describe("Code Mode skills and read tools", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCodeModeTestState();
  });

  it("keeps Code Mode skill parsing aligned with the production prompt renderer", () => {
    const entries = [createFixtureSkillEntry("alpha"), createFixtureSkillEntry("beta")];
    const skillsPrompt = resolveSkillsPrompt({
      entries,
      workspaceDir: "/workspace",
    });

    expect(
      resolveCodeModeSkills({
        skillsPrompt,
        candidates: entries.map((entry) => entry.skill),
      }).map(({ name, location }) => ({ name, location })),
    ).toEqual([
      { name: "alpha", location: "/skills/alpha/SKILL.md" },
      { name: "beta", location: "/skills/beta/SKILL.md" },
    ]);
  });

  it("lists and reads only prompt-eligible skills through the worker bridge", async () => {
    const demo = skillCandidate({
      name: "demo",
      description: "Full demo description",
      filePath: "/host/skills/demo/SKILL.md",
    });
    const hidden = skillCandidate({
      name: "hidden",
      description: "Hidden skill",
      filePath: "/host/skills/hidden/SKILL.md",
    });
    const reader = vi.fn(async ({ location }: { location: string }) =>
      location === "/guest/skills/demo/SKILL.md"
        ? "---\nname: demo\n---\n\n# Complete demo instructions\n"
        : "# Hidden\n",
    );
    const codeModeSkills = resolveCodeModeSkills({
      skillsPrompt: [
        "<available_skills>",
        "  <skill>",
        "    <name>demo</name>",
        "    <description>Short prompt description</description>",
        "    <location>/guest/skills/demo/SKILL.md</location>",
        "  </skill>",
        "</available_skills>",
      ].join("\n"),
      candidates: [demo, hidden],
      reader,
    });
    const {
      config,
      catalogRef,
      tools: codeModeTools,
    } = createCodeModeHarness({
      codeModeSkills,
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
      codeModeSkills,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        const listed = await skills.list();
        const body = await skills.read("demo");
        let unknown;
        try {
          await skills.read("missing");
        } catch (error) {
          unknown = error.message;
        }
        return { listed, body, unknown };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      listed: [
        {
          name: "demo",
          description: "Full demo description",
          location: "/guest/skills/demo/SKILL.md",
        },
      ],
      body: "---\nname: demo\n---\n\n# Complete demo instructions\n",
      unknown: 'Unknown skill "missing". Available skills: demo',
    });
    expect(codeModeTools[0]?.description).toContain("`await skills.read(name)`");
    expect(reader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledWith({
      location: "/guest/skills/demo/SKILL.md",
      signal: expect.any(AbortSignal),
    });
  });

  it("returns ordinary read content through the bare tool global", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const read = createOpenClawReadTool(
      createReadTool("/workspace", {
        operations: {
          access: async () => {},
          detectImageMimeType: async () => null,
          readFile: async () => Buffer.from("ordinary file content"),
        },
      }) as unknown as Parameters<typeof createOpenClawReadTool>[0],
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, read],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `return await read({ path: "notes.txt" });`,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({ kind: "text", content: "ordinary file content" });
  });
});
