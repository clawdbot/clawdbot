import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import {
  applyGoogleTurnOrderingFix,
  buildEmbeddedSandboxInfo,
  createSystemPromptOverride,
  runEmbeddedPiAgent,
  splitSdkTools,
} from "./pi-embedded-runner.js";
import type { SandboxContext } from "./sandbox.js";

vi.mock("./model-auth.js", () => ({
  getApiKeyForModel: vi.fn(),
  ensureAuthProfileStore: vi.fn(() => ({ profiles: {} })),
  resolveAuthProfileOrder: vi.fn(() => []),
}));

vi.mock("../providers/github-copilot-token.js", async () => {
  const actual = await vi.importActual<
    typeof import("../providers/github-copilot-token.js")
  >("../providers/github-copilot-token.js");
  return {
    ...actual,
    resolveCopilotApiToken: vi.fn(),
  };
});

describe("buildEmbeddedSandboxInfo", () => {
  it("returns undefined when sandbox is missing", () => {
    expect(buildEmbeddedSandboxInfo()).toBeUndefined();
  });

  it("maps sandbox context into prompt info", () => {
    const sandbox = {
      enabled: true,
      sessionKey: "session:test",
      workspaceDir: "/tmp/clawdbot-sandbox",
      agentWorkspaceDir: "/tmp/clawdbot-workspace",
      workspaceAccess: "none",
      containerName: "clawdbot-sbx-test",
      containerWorkdir: "/workspace",
      docker: {
        image: "clawdbot-sandbox:bookworm-slim",
        containerPrefix: "clawdbot-sbx-",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: ["/tmp"],
        network: "none",
        user: "1000:1000",
        capDrop: ["ALL"],
        env: { LANG: "C.UTF-8" },
      },
      tools: {
        allow: ["bash"],
        deny: ["browser"],
      },
      browserAllowHostControl: true,
      browser: {
        controlUrl: "http://localhost:9222",
        noVncUrl: "http://localhost:6080",
        containerName: "clawdbot-sbx-browser-test",
      },
    } satisfies SandboxContext;

    expect(buildEmbeddedSandboxInfo(sandbox)).toEqual({
      enabled: true,
      workspaceDir: "/tmp/clawdbot-sandbox",
      workspaceAccess: "none",
      agentWorkspaceMount: undefined,
      browserControlUrl: "http://localhost:9222",
      browserNoVncUrl: "http://localhost:6080",
      hostBrowserAllowed: true,
    });
  });

  it("includes elevated info when allowed", () => {
    const sandbox = {
      enabled: true,
      sessionKey: "session:test",
      workspaceDir: "/tmp/clawdbot-sandbox",
      agentWorkspaceDir: "/tmp/clawdbot-workspace",
      workspaceAccess: "none",
      containerName: "clawdbot-sbx-test",
      containerWorkdir: "/workspace",
      docker: {
        image: "clawdbot-sandbox:bookworm-slim",
        containerPrefix: "clawdbot-sbx-",
        workdir: "/workspace",
        readOnlyRoot: true,
        tmpfs: ["/tmp"],
        network: "none",
        user: "1000:1000",
        capDrop: ["ALL"],
        env: { LANG: "C.UTF-8" },
      },
      tools: {
        allow: ["bash"],
        deny: ["browser"],
      },
      browserAllowHostControl: false,
    } satisfies SandboxContext;

    expect(
      buildEmbeddedSandboxInfo(sandbox, {
        enabled: true,
        allowed: true,
        defaultLevel: "on",
      }),
    ).toEqual({
      enabled: true,
      workspaceDir: "/tmp/clawdbot-sandbox",
      workspaceAccess: "none",
      agentWorkspaceMount: undefined,
      hostBrowserAllowed: false,
      elevated: { allowed: true, defaultLevel: "on" },
    });
  });
});

describe("resolveSessionAgentIds", () => {
  const cfg = {
    agents: {
      list: [{ id: "main" }, { id: "beta", default: true }],
    },
  } as ClawdbotConfig;

  it("falls back to the configured default when sessionKey is missing", () => {
    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
      config: cfg,
    });
    expect(defaultAgentId).toBe("beta");
    expect(sessionAgentId).toBe("beta");
  });

  it("falls back to the configured default when sessionKey is non-agent", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "telegram:slash:123",
      config: cfg,
    });
    expect(sessionAgentId).toBe("beta");
  });

  it("falls back to the configured default for global sessions", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "global",
      config: cfg,
    });
    expect(sessionAgentId).toBe("beta");
  });

  it("keeps the agent id for provider-qualified agent sessions", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "agent:beta:slack:channel:C1",
      config: cfg,
    });
    expect(sessionAgentId).toBe("beta");
  });

  it("uses the agent id from agent session keys", () => {
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "agent:main:main",
      config: cfg,
    });
    expect(sessionAgentId).toBe("main");
  });
});

function createStubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({ content: [], details: {} }),
  };
}

describe("splitSdkTools", () => {
  const tools = [
    createStubTool("read"),
    createStubTool("bash"),
    createStubTool("edit"),
    createStubTool("write"),
    createStubTool("browser"),
  ];

  it("routes all tools to customTools when sandboxed", () => {
    const { builtInTools, customTools } = splitSdkTools({
      tools,
      sandboxEnabled: true,
    });
    expect(builtInTools).toEqual([]);
    expect(customTools.map((tool) => tool.name)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "browser",
    ]);
  });

  it("routes all tools to customTools even when not sandboxed", () => {
    const { builtInTools, customTools } = splitSdkTools({
      tools,
      sandboxEnabled: false,
    });
    expect(builtInTools).toEqual([]);
    expect(customTools.map((tool) => tool.name)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "browser",
    ]);
  });
});

describe("createSystemPromptOverride", () => {
  it("returns the override prompt regardless of default prompt", () => {
    const override = createSystemPromptOverride("OVERRIDE");
    expect(override("DEFAULT")).toBe("OVERRIDE");
  });

  it("returns an empty string for blank overrides", () => {
    const override = createSystemPromptOverride("  \n  ");
    expect(override("DEFAULT")).toBe("");
  });
});

describe("applyGoogleTurnOrderingFix", () => {
  const makeAssistantFirst = () =>
    [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "bash", arguments: {} },
        ],
      },
    ] satisfies AgentMessage[];

  it("prepends a bootstrap once and records a marker for Google models", () => {
    const sessionManager = SessionManager.inMemory();
    const warn = vi.fn();
    const input = makeAssistantFirst();
    const first = applyGoogleTurnOrderingFix({
      messages: input,
      modelApi: "google-generative-ai",
      sessionManager,
      sessionId: "session:1",
      warn,
    });
    expect(first.messages[0]?.role).toBe("user");
    expect(first.messages[1]?.role).toBe("assistant");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(
      sessionManager
        .getEntries()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "google-turn-ordering-bootstrap",
        ),
    ).toBe(true);

    applyGoogleTurnOrderingFix({
      messages: input,
      modelApi: "google-generative-ai",
      sessionManager,
      sessionId: "session:1",
      warn,
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("skips non-Google models", () => {
    const sessionManager = SessionManager.inMemory();
    const warn = vi.fn();
    const input = makeAssistantFirst();
    const result = applyGoogleTurnOrderingFix({
      messages: input,
      modelApi: "openai",
      sessionManager,
      sessionId: "session:2",
      warn,
    });
    expect(result.messages).toBe(input);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("runEmbeddedPiAgent", () => {
  it("exchanges github token for copilot token", async () => {
    const { getApiKeyForModel } = await import("./model-auth.js");
    const { resolveCopilotApiToken } = await import(
      "../providers/github-copilot-token.js"
    );

    vi.mocked(getApiKeyForModel).mockResolvedValue({
      apiKey: "gh-token",
      source: "test",
    });
    vi.mocked(resolveCopilotApiToken).mockResolvedValue({
      token: "copilot-token",
      expiresAt: Date.now() + 60_000,
      source: "test",
    });

    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-agent-copilot-"),
    );
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-workspace-copilot-"),
    );
    const sessionFile = path.join(workspaceDir, "session.jsonl");

    await expect(
      runEmbeddedPiAgent({
        sessionId: "session:test",
        sessionKey: "agent:dev:test",
        sessionFile,
        workspaceDir,
        prompt: "hi",
        provider: "github-copilot",
        model: "gpt-4o",
        timeoutMs: 1,
        agentDir,
      }),
    ).rejects.toThrow();

    expect(resolveCopilotApiToken).toHaveBeenCalledWith({
      githubToken: "gh-token",
    });
  });

  it("writes models.json into the provided agentDir", async () => {
    const agentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-agent-"),
    );
    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-workspace-"),
    );
    const sessionFile = path.join(workspaceDir, "session.jsonl");

    const cfg = {
      models: {
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/v1",
            api: "openai-completions",
            apiKey: "sk-minimax-test",
            models: [
              {
                id: "minimax-m2.1",
                name: "MiniMax M2.1",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } satisfies ClawdbotConfig;

    await expect(
      runEmbeddedPiAgent({
        sessionId: "session:test",
        sessionKey: "agent:dev:test",
        sessionFile,
        workspaceDir,
        config: cfg,
        prompt: "hi",
        provider: "definitely-not-a-provider",
        model: "definitely-not-a-model",
        timeoutMs: 1,
        agentDir,
      }),
    ).rejects.toThrow(/Unknown model:/);

    await expect(
      fs.stat(path.join(agentDir, "models.json")),
    ).resolves.toBeTruthy();
  });
});
