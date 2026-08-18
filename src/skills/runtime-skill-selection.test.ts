import { describe, expect, it } from "vitest";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import { buildRuntimeSkillSelectionMarker } from "./runtime-skill-selection.js";

const report: SessionSystemPromptReport = {
  source: "run",
  generatedAt: 0,
  systemPrompt: {
    chars: 0,
    projectContextChars: 0,
    nonProjectContextChars: 0,
  },
  injectedWorkspaceFiles: [],
  skills: {
    promptChars: 0,
    entries: [
      { name: "debug-toolkit", blockChars: 0 },
      { name: "runtime-skill-loading-diagnostics", blockChars: 0 },
      { name: "first-wave-handoff-overlay", blockChars: 0 },
    ],
  },
  tools: {
    listChars: 0,
    schemaChars: 0,
    entries: [],
  },
};

const skillsPrompt = `
<skill>
  <name>debug-toolkit</name>
  <description>Use for complex technical debugging, regressions, flaky tests, and root causes.</description>
</skill>
<skill>
  <name>runtime-skill-loading-diagnostics</name>
  <description>Diagnose OpenClaw skill visibility and overlay runtime claims.</description>
</skill>
<skill>
  <name>first-wave-handoff-overlay</name>
  <description>STOP/handoff overlay for first-wave maintained skills.</description>
</skill>
`;

describe("runtime skill selection marker", () => {
  it("marks deterministic guardrails for critical MemoryTunning observability prompts", () => {
    expect(
      buildRuntimeSkillSelectionMarker({
        agentId: "main",
        sessionKey: "agent:main:discord:channel:1",
        sessionId: "session-1",
        runId: "run-1",
        prompt: "Napraw MemoryTunning selectedSkill observability w openclaw audit",
        systemPromptReport: report,
        skillsPrompt,
      }),
    ).toMatchObject({
      selectedSkill: "runtime-skill-loading-diagnostics",
      selectionSource: "natural_prompt",
      selectionConfidence: "deterministic",
      selectionRule: "deterministic_guardrail",
      visibilityState: "selected",
      redaction: "metadata_only",
    });
  });

  it("keeps neutral prompts as selection.none", () => {
    expect(
      buildRuntimeSkillSelectionMarker({
        prompt: "Powiedz krotko ok",
        systemPromptReport: report,
        skillsPrompt,
      }),
    ).toMatchObject({
      selectedSkill: null,
      selectedOverlay: null,
      selectionSource: "none",
      selectionConfidence: "none",
      selectionRule: "none",
      visibilityState: "injected",
    });
  });

  it("marks overlay selections separately", () => {
    expect(
      buildRuntimeSkillSelectionMarker({
        prompt: "@first-wave-handoff-overlay podsumuj status",
        systemPromptReport: report,
        skillsPrompt,
      }),
    ).toMatchObject({
      selectedOverlay: "first-wave-handoff-overlay",
      selectedSkill: null,
      selectionSource: "explicit_trigger",
      selectionConfidence: "deterministic",
      selectionRule: "explicit_trigger",
    });
  });
});
