import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureSkillEntry } from "../../../skills/test-support/test-helpers.js";
import type { AnyAgentTool } from "../../tools/common.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];
const skillsPrompt = [
  "<available_skills>",
  "  <skill>",
  "    <name>demo</name>",
  "    <description>demo description</description>",
  "    <location>/skills/demo/SKILL.md</location>",
  "  </skill>",
  "</available_skills>",
].join("\n");

beforeAll(async () => {
  await preloadRunEmbeddedAttemptForTests();
});

beforeEach(() => {
  resetEmbeddedAttemptHarness();
});

afterEach(async () => {
  await cleanupTempPaths(tempPaths);
  vi.restoreAllMocks();
});

describe("runEmbeddedAttempt skill policy projections", () => {
  it("keeps wildcard allowlists equivalent to an unrestricted attempt", async () => {
    const observed: Array<{
      label: string;
      skillsPrompt?: string;
      skillsListAvailable: boolean;
    }> = [];

    for (const testCase of [
      { label: "undefined", toolsAllow: undefined },
      { label: "wildcard", toolsAllow: ["*"] },
      { label: "mixed wildcard", toolsAllow: ["message", "*"] },
      { label: "finite", toolsAllow: ["message"] },
    ]) {
      resetEmbeddedAttemptHarness();
      hoisted.resolveEmbeddedRunSkillEntriesMock.mockReturnValue({
        shouldLoadSkillEntries: true,
        skillEntries: [createFixtureSkillEntry("demo")],
        loadSkillEntries: vi.fn(() => [createFixtureSkillEntry("demo")]),
      });
      hoisted.resolveSkillsPromptForRunMock.mockReturnValue(skillsPrompt);

      await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: `agent:main:${testCase.label.replace(" ", "-")}`,
        tempPaths,
        attemptOverrides: {
          disableTools: false,
          toolsAllow: testCase.toolsAllow,
          config: { tools: { codeMode: true } },
        },
      });

      const sessionOptions = hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0] as
        | { customTools?: AnyAgentTool[] }
        | undefined;
      const execTool = sessionOptions?.customTools?.find((tool) => tool.name === "exec");
      if (!execTool) {
        throw new Error("expected Code Mode exec tool");
      }
      const promptInput = hoisted.embeddedSystemPromptInputs.at(-1) as
        | { skillsPrompt?: string }
        | undefined;
      observed.push({
        label: testCase.label,
        skillsPrompt: promptInput?.skillsPrompt,
        skillsListAvailable: execTool.description.includes("await skills.list()"),
      });
    }

    expect(observed).toEqual([
      { label: "undefined", skillsPrompt, skillsListAvailable: true },
      { label: "wildcard", skillsPrompt, skillsListAvailable: true },
      { label: "mixed wildcard", skillsPrompt, skillsListAvailable: true },
      { label: "finite", skillsPrompt: undefined, skillsListAvailable: false },
    ]);
  });
});
