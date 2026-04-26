import { describe, expect, it, vi } from "vitest";
import type { RunCliAgentParams } from "../agents/cli-runner/types.js";
import type { RunEmbeddedPiAgentParams } from "../agents/pi-embedded-runner/run/params.js";
import type { EmbeddedPiRunResult } from "../agents/pi-embedded.js";
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

  it("rejects non-command output", () => {
    expect(parseCrestodianAssistantPlanText("I would edit config directly.")).toBeNull();
    expect(parseCrestodianAssistantPlanText('{"reply":"missing command"}')).toBeNull();
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

  it("uses Claude CLI first for configless planning", async () => {
    const runCliAgent = vi.fn(
      async (_params: RunCliAgentParams): Promise<EmbeddedPiRunResult> => ({
        payloads: [{ text: '{"reply":"Checking the shell.","command":"status"}' }],
        meta: { durationMs: 0 },
      }),
    );
    const runEmbeddedPiAgent = vi.fn();

    await expect(
      planCrestodianCommandWithLocalRuntime({
        input: "what is going on",
        overview: overview({
          claude: { command: "claude", found: true },
          codex: { command: "codex", found: true },
        }),
        deps: {
          runCliAgent,
          runEmbeddedPiAgent,
          createTempDir: async () => "/tmp/crestodian-planner",
          removeTempDir: async () => {},
        },
      }),
    ).resolves.toMatchObject({
      command: "status",
      reply: "Checking the shell.",
      modelLabel: "claude-cli/claude-opus-4-7",
    });

    expect(runCliAgent).toHaveBeenCalledTimes(1);
    const firstCliCall = runCliAgent.mock.calls[0][0];
    expect(firstCliCall).toMatchObject({
      provider: "claude-cli",
      model: "claude-opus-4-7",
      cleanupCliLiveSessionOnRunEnd: true,
    });
    expect(firstCliCall.config?.agents?.defaults?.cliBackends).toBeUndefined();
    expect(firstCliCall.extraSystemPrompt).toContain("Do not use tools, shell commands");
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
  });

  it("selects local planner backends without execution state", () => {
    expect(
      selectCrestodianLocalPlannerBackends(
        overview({
          claude: { command: "claude", found: true },
          codex: { command: "codex", found: true },
        }),
      ).map((backend) => backend.kind),
    ).toEqual(["claude-cli", "codex-app-server", "codex-cli"]);

    const [codexAppServer, codexCli] = selectCrestodianLocalPlannerBackends(
      overview({
        codex: { command: "codex", found: true },
      }),
    );
    expect(codexAppServer?.buildConfig("/tmp/workspace")).toMatchObject({
      agents: {
        defaults: {
          workspace: "/tmp/workspace",
          agentRuntime: { id: "codex", fallback: "none" },
          model: { primary: "openai/gpt-5.5" },
        },
      },
      plugins: { entries: { codex: { enabled: true } } },
    });
    expect(codexCli?.buildConfig("/tmp/workspace")).toMatchObject({
      agents: {
        defaults: {
          workspace: "/tmp/workspace",
          model: { primary: "codex-cli/gpt-5.5" },
        },
      },
    });
  });

  it("falls back to Codex app-server when Claude CLI planning fails", async () => {
    const runCliAgent = vi.fn(async () => {
      throw new Error("claude unavailable");
    });
    const runEmbeddedPiAgent = vi.fn(
      async (_params: RunEmbeddedPiAgentParams): Promise<EmbeddedPiRunResult> => ({
        meta: {
          durationMs: 0,
          finalAssistantVisibleText: '{"reply":"Codex planner online.","command":"gateway status"}',
        },
      }),
    );

    await expect(
      planCrestodianCommandWithLocalRuntime({
        input: "is gateway alive",
        overview: overview({
          claude: { command: "claude", found: true },
          codex: { command: "codex", found: true },
        }),
        deps: {
          runCliAgent,
          runEmbeddedPiAgent,
          createTempDir: async () => "/tmp/crestodian-planner",
          removeTempDir: async () => {},
        },
      }),
    ).resolves.toMatchObject({
      command: "gateway status",
      reply: "Codex planner online.",
      modelLabel: "openai/gpt-5.5 via codex",
    });

    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    const firstEmbeddedCall = runEmbeddedPiAgent.mock.calls[0][0];
    expect(firstEmbeddedCall).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      agentHarnessId: "codex",
      disableTools: true,
      toolsAllow: [],
    });
    expect(firstEmbeddedCall.config).toMatchObject({
      agents: {
        defaults: {
          agentRuntime: { id: "codex", fallback: "none" },
          model: { primary: "openai/gpt-5.5" },
        },
      },
      plugins: { entries: { codex: { enabled: true } } },
    });
  });

  it("uses Codex CLI if the app-server planner is not usable", async () => {
    const runCliAgent = vi.fn(async (params: RunCliAgentParams): Promise<EmbeddedPiRunResult> => {
      if (params.provider === "codex-cli") {
        return {
          payloads: [{ text: '{"reply":"CLI fallback.","command":"models"}' }],
          meta: { durationMs: 0 },
        };
      }
      throw new Error("unexpected cli provider");
    });
    const runEmbeddedPiAgent = vi.fn(async () => {
      throw new Error("codex app-server unavailable");
    });

    await expect(
      planCrestodianCommandWithLocalRuntime({
        input: "show models",
        overview: overview({
          codex: { command: "codex", found: true },
        }),
        deps: {
          runCliAgent,
          runEmbeddedPiAgent,
          createTempDir: async () => "/tmp/crestodian-planner",
          removeTempDir: async () => {},
        },
      }),
    ).resolves.toMatchObject({
      command: "models",
      reply: "CLI fallback.",
      modelLabel: "codex-cli/gpt-5.5",
    });

    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    expect(runCliAgent).toHaveBeenCalledTimes(1);
    expect(runCliAgent.mock.calls[0][0]).toMatchObject({
      provider: "codex-cli",
      model: "gpt-5.5",
      cleanupCliLiveSessionOnRunEnd: true,
    });
  });
});
