import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import {
  applyGoogleTurnOrderingFix,
  buildEmbeddedSandboxInfo,
  createSystemPromptOverride,
  splitSdkTools,
} from "./pi-embedded-runner.js";
import type { SandboxContext } from "./sandbox.js";

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
    });
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

  it("routes built-ins to custom tools when sandboxed", () => {
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

  it("keeps built-ins as SDK tools when not sandboxed", () => {
    const { builtInTools, customTools } = splitSdkTools({
      tools,
      sandboxEnabled: false,
    });
    expect(builtInTools.map((tool) => tool.name)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
    ]);
    expect(customTools.map((tool) => tool.name)).toEqual(["browser"]);
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
