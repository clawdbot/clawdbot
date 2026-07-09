// Crestodian assistant tests cover assistant-driven rescue message generation.
import { describe, expect, it, vi } from "vitest";
import type { RunCliAgentParams } from "../agents/cli-runner/types.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "../agents/embedded-agent.js";
import { selectCrestodianLocalPlannerBackends } from "./assistant-backends.js";
import {
  buildCrestodianAssistantUserPrompt,
  planCrestodianCommandWithLocalRuntime,
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

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function firstMockArg(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("Expected mock to be called");
  }
  return requireRecord(call[0]);
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
    // Conversational turns without a command are valid: the custodian can
    // answer questions without proposing an operation.
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

  it("uses Claude CLI first for configless planning", async () => {
    const runCliAgent = vi.fn(
      async (_params: RunCliAgentParams): Promise<EmbeddedAgentRunResult> => ({
        payloads: [{ text: '{"reply":"Checking the shell.","command":"status"}' }],
        meta: { durationMs: 0 },
      }),
    );
    const runEmbeddedAgent = vi.fn();

    const result = await planCrestodianCommandWithLocalRuntime({
      input: "what is going on",
      overview: overview({
        claude: { command: "claude", found: true },
        codex: { command: "codex", found: true },
      }),
      deps: {
        runCliAgent,
        runEmbeddedAgent,
        createTempDir: async () => "/tmp/crestodian-planner",
        removeTempDir: async () => {},
      },
    });
    if (result === null) {
      throw new Error("Expected planner result");
    }
    expect(result.command).toBe("status");
    expect(result.reply).toBe("Checking the shell.");
    expect(result.modelLabel).toBe("claude-cli/claude-opus-4-8");

    expect(runCliAgent).toHaveBeenCalledTimes(1);
    const firstCliCall = firstMockArg(runCliAgent);
    expect(firstCliCall.provider).toBe("claude-cli");
    expect(firstCliCall.model).toBe("claude-opus-4-8");
    expect(firstCliCall.cleanupCliLiveSessionOnRunEnd).toBe(true);
    const firstCliConfig = requireRecord(firstCliCall.config);
    const firstCliAgents = requireRecord(firstCliConfig.agents);
    const firstCliDefaults = requireRecord(firstCliAgents.defaults);
    expect(firstCliDefaults.cliBackends).toBeUndefined();
    expect(firstCliCall.extraSystemPrompt).toBeTypeOf("string");
    expect(firstCliCall.extraSystemPrompt).toContain("Do not use tools, shell commands");
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("selects local planner backends without execution state", () => {
    expect(
      selectCrestodianLocalPlannerBackends(
        overview({
          claude: { command: "claude", found: true },
          codex: { command: "codex", found: true },
        }),
      ).map((backend) => backend.kind),
    ).toEqual(["claude-cli", "codex-app-server"]);

    // Setup-ladder order: Claude Code, Codex, Gemini.
    expect(
      selectCrestodianLocalPlannerBackends(
        overview({
          claude: { command: "claude", found: true },
          codex: { command: "codex", found: true },
          gemini: { command: "gemini", found: true },
        }),
      ).map((backend) => backend.kind),
    ).toEqual(["claude-cli", "codex-app-server", "gemini-cli"]);

    const [codexAppServer] = selectCrestodianLocalPlannerBackends(
      overview({
        codex: { command: "codex", found: true },
      }),
    );
    const codexAppServerConfig = requireRecord(codexAppServer?.buildConfig("/tmp/workspace"));
    const codexAppServerAgents = requireRecord(codexAppServerConfig.agents);
    const codexAppServerDefaults = requireRecord(codexAppServerAgents.defaults);
    const codexAppServerModel = requireRecord(codexAppServerDefaults.model);
    const codexAppServerPlugins = requireRecord(codexAppServerConfig.plugins);
    const codexAppServerEntries = requireRecord(codexAppServerPlugins.entries);
    const codexAppServerCodexEntry = requireRecord(codexAppServerEntries.codex);
    expect(codexAppServerDefaults.workspace).toBe("/tmp/workspace");
    expect(codexAppServerModel.primary).toBe("openai/gpt-5.5");
    expect(codexAppServerCodexEntry.enabled).toBe(true);
  });

  it("falls back to Codex app-server when Claude CLI planning fails", async () => {
    const runCliAgent = vi.fn(async () => {
      throw new Error("claude unavailable");
    });
    const runEmbeddedAgent = vi.fn(
      async (_params: RunEmbeddedAgentParams): Promise<EmbeddedAgentRunResult> => ({
        meta: {
          durationMs: 0,
          finalAssistantVisibleText: '{"reply":"Codex planner online.","command":"gateway status"}',
        },
      }),
    );

    const result = await planCrestodianCommandWithLocalRuntime({
      input: "is gateway alive",
      overview: overview({
        claude: { command: "claude", found: true },
        codex: { command: "codex", found: true },
      }),
      deps: {
        runCliAgent,
        runEmbeddedAgent,
        createTempDir: async () => "/tmp/crestodian-planner",
        removeTempDir: async () => {},
      },
    });
    if (result === null) {
      throw new Error("Expected planner result");
    }
    expect(result.command).toBe("gateway status");
    expect(result.reply).toBe("Codex planner online.");
    expect(result.modelLabel).toBe("openai/gpt-5.5 via codex");

    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
    const firstEmbeddedCall = firstMockArg(runEmbeddedAgent);
    expect(firstEmbeddedCall.provider).toBe("openai");
    expect(firstEmbeddedCall.model).toBe("gpt-5.5");
    expect(firstEmbeddedCall.agentHarnessId).toBe("codex");
    expect(firstEmbeddedCall.disableTools).toBe(true);
    expect(firstEmbeddedCall.toolsAllow).toEqual([]);
    const embeddedConfig = requireRecord(firstEmbeddedCall.config);
    const embeddedAgents = requireRecord(embeddedConfig.agents);
    const embeddedDefaults = requireRecord(embeddedAgents.defaults);
    const embeddedModel = requireRecord(embeddedDefaults.model);
    const embeddedPlugins = requireRecord(embeddedConfig.plugins);
    const embeddedEntries = requireRecord(embeddedPlugins.entries);
    const embeddedCodexEntry = requireRecord(embeddedEntries.codex);
    expect(embeddedModel.primary).toBe("openai/gpt-5.5");
    expect(embeddedCodexEntry.enabled).toBe(true);
  });

  it("does not fall back to Codex CLI if the app-server planner is not usable", async () => {
    const runCliAgent = vi.fn(async (): Promise<EmbeddedAgentRunResult> => {
      throw new Error("unexpected cli provider");
    });
    const runEmbeddedAgent = vi.fn(async () => {
      throw new Error("codex app-server unavailable");
    });

    const result = await planCrestodianCommandWithLocalRuntime({
      input: "show models",
      overview: overview({
        codex: { command: "codex", found: true },
      }),
      deps: {
        runCliAgent,
        runEmbeddedAgent,
        createTempDir: async () => "/tmp/crestodian-planner",
        removeTempDir: async () => {},
      },
    });
    expect(result).toBeNull();

    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
    expect(runCliAgent).not.toHaveBeenCalled();
  });
});
