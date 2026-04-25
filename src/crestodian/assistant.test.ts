import { describe, expect, it } from "vitest";
import {
  buildCrestodianAssistantUserPrompt,
  parseCrestodianAssistantPlanText,
} from "./assistant.js";
import type { CrestodianOverview } from "./overview.js";

function overviewFixture(): CrestodianOverview {
  return {
    config: {
      path: "/tmp/openclaw.json",
      exists: true,
      valid: true,
      issues: [],
      hash: "hash",
    },
    agents: [
      {
        id: "main",
        name: "Main",
        isDefault: true,
        model: "openai/gpt-5.5",
        workspace: "/tmp/main",
      },
    ],
    defaultAgentId: "main",
    defaultModel: "openai/gpt-5.5",
    tools: {
      codex: { command: "codex", found: true, version: "codex 1.0.0" },
      claude: { command: "claude", found: false },
      apiKeys: { openai: true, anthropic: false },
    },
    gateway: {
      url: "ws://127.0.0.1:18200",
      source: "local loopback",
      reachable: false,
    },
    references: {
      docsPath: "/tmp/openclaw/docs",
      docsUrl: "https://docs.openclaw.ai",
      sourcePath: "/tmp/openclaw",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  };
}

describe("parseCrestodianAssistantPlanText", () => {
  it("extracts compact planner JSON", () => {
    expect(
      parseCrestodianAssistantPlanText(
        'tiny claw says {"reply":"I can restart it.","command":"restart gateway"}',
      ),
    ).toEqual({
      reply: "I can restart it.",
      command: "restart gateway",
    });
  });

  it("rejects non-command output", () => {
    expect(parseCrestodianAssistantPlanText("I would edit config directly.")).toBeNull();
    expect(parseCrestodianAssistantPlanText('{"reply":"missing command"}')).toBeNull();
  });
});

describe("buildCrestodianAssistantUserPrompt", () => {
  it("includes only operational summary context", () => {
    const prompt = buildCrestodianAssistantUserPrompt({
      input: "fix my setup",
      overview: overviewFixture(),
    });

    expect(prompt).toContain("User request: fix my setup");
    expect(prompt).toContain("Default model: openai/gpt-5.5");
    expect(prompt).toContain("id=main, name=Main, workspace=/tmp/main");
    expect(prompt).toContain("OpenAI API key: found");
    expect(prompt).toContain("OpenClaw docs: /tmp/openclaw/docs");
    expect(prompt).toContain("OpenClaw source: /tmp/openclaw");
  });
});
