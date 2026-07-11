// Crestodian assistant tests cover plan parsing and inference prompt construction.
import { describe, expect, it } from "vitest";
import {
  buildCrestodianAssistantUserPrompt,
  parseCrestodianAssistantPlanText,
} from "./assistant.js";
import type { CrestodianOverview } from "./overview.js";

function overview(overrides: Partial<CrestodianOverview["tools"]> = {}): CrestodianOverview {
  return {
    config: {
      path: "/tmp/openclaw.json",
      exists: false,
      valid: false,
      issues: [],
      hash: null,
    },
    agents: [],
    defaultAgentId: "default",
    tools: {
      codex: { command: "codex", found: false },
      claude: { command: "claude", found: false },
      gemini: { command: "gemini", found: false },
      apiKeys: { openai: false, anthropic: false },
      ...overrides,
    },
    gateway: {
      url: "ws://127.0.0.1:14567",
      source: "local loopback",
      reachable: false,
    },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  };
}

describe("Crestodian assistant", () => {
  it("parses the first compact JSON command", () => {
    expect(
      parseCrestodianAssistantPlanText(
        'thinking... {"reply":"Aye aye.","command":"restart gateway"}',
      ),
    ).toEqual({
      reply: "Aye aye.",
      command: "restart gateway",
    });
  });

  it("rejects non-JSON and empty plans but accepts chat-only replies", () => {
    expect(parseCrestodianAssistantPlanText("I would edit config directly.")).toBeNull();
    expect(parseCrestodianAssistantPlanText("{}")).toBeNull();
    expect(parseCrestodianAssistantPlanText('{"reply":"just chatting"}')).toEqual({
      reply: "just chatting",
    });
  });

  it("includes only operational summary context in planner prompts", () => {
    const prompt = buildCrestodianAssistantUserPrompt({
      input: "fix my setup",
      overview: {
        ...overview({
          codex: { command: "codex", found: true, version: "codex 1.0.0" },
          apiKeys: { openai: true, anthropic: false },
        }),
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
        references: {
          docsPath: "/tmp/openclaw/docs",
          docsUrl: "https://docs.openclaw.ai",
          sourcePath: "/tmp/openclaw",
          sourceUrl: "https://github.com/openclaw/openclaw",
        },
      },
    });

    expect(prompt).toContain("User request: fix my setup");
    expect(prompt).toContain("Default model: openai/gpt-5.5");
    expect(prompt).toContain("id=main, name=Main, workspace=/tmp/main");
    expect(prompt).toContain("OpenAI API key: found");
    expect(prompt).toContain("OpenClaw docs: /tmp/openclaw/docs");
    expect(prompt).toContain("OpenClaw source: /tmp/openclaw");
  });

  it("keeps truncated conversation history valid at a UTF-16 boundary", () => {
    const prefix = "a".repeat(499);
    const prompt = buildCrestodianAssistantUserPrompt({
      input: "continue",
      overview: overview(),
      history: [{ role: "user", text: `${prefix}🎉tail` }],
    });

    expect(prompt.slice(0, prompt.indexOf("User request:"))).toBe(
      `Conversation so far:\nUser: ${prefix}…\n\n`,
    );
  });
});
