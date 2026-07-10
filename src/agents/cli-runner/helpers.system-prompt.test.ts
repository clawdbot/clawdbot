// Verifies CLI system-prompt construction without loading the full runner.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPluginCommands, registerPluginCommand } from "../../plugins/commands.js";
import { buildCliAgentSystemPrompt } from "./helpers.js";

vi.mock("../../tts/tts.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
}));

describe("buildCliAgentSystemPrompt", () => {
  afterEach(() => {
    clearPluginCommands();
  });

  it("uses config-backed sub-agent delegation mode", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      config: {
        agents: {
          defaults: {
            subagents: {
              delegationMode: "prefer",
            },
          },
        },
      },
      agentId: "main",
      tools: [{ name: "sessions_spawn" } as never],
      modelDisplay: "test/model",
    });

    expect(prompt).toContain("## Sub-Agent Delegation");
    expect(prompt).toContain("Mode: prefer");
    expect(prompt).not.toContain("For long waits, avoid rapid poll loops");
    expect(prompt).not.toContain("Larger work: use `sessions_spawn`");
    expect(prompt).not.toContain("Do not poll `subagents list` / `sessions_list` in a loop");
  });

  it("uses CLI backend tool fallback instead of OpenClaw tool assumptions", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [],
      modelDisplay: "test/model",
    });

    expect(prompt).not.toContain("OpenClaw lists the standard tools above");
    expect(prompt).not.toContain("This runtime enables:");
    expect(prompt).not.toContain("For long waits, avoid rapid poll loops");
    expect(prompt).not.toContain("Larger work: use `sessions_spawn`");
    expect(prompt).not.toContain("Do not poll `subagents list` / `sessions_list` in a loop");
    expect(prompt).toContain("No OpenClaw tool list is injected");
  });

  it("describes bundled exec as synchronous node execution", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [{ name: "exec" } as never],
      modelDisplay: "test/model",
    });

    expect(prompt).toContain(
      "- exec: Run shell commands on connected OpenClaw nodes (synchronous; use host=node)",
    );
    expect(prompt).not.toContain("pty available");
  });

  it("uses cwd, not bootstrap workspace, for CLI workspace guidance", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw-agent",
      cwd: "/tmp/task-repo",
      tools: [],
      modelDisplay: "test/model",
    });

    expect(prompt).toContain("Your working directory is: /tmp/task-repo");
    expect(prompt).not.toContain("Your working directory is: /tmp/openclaw-agent");
  });

  it("renders the Bootstrap Pending gate for full bootstrap mode", () => {
    // CLI-backend runs must gate the first reply on a pending BOOTSTRAP.md the
    // same way the embedded runner does, not just inject the file as context.
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [],
      contextFiles: [
        {
          path: "/tmp/openclaw/BOOTSTRAP.md",
          content: "Figure out who you are, then delete this file.",
        },
      ],
      bootstrapMode: "full",
      modelDisplay: "test/model",
    });

    expect(prompt).toContain("## Bootstrap Pending");
    expect(prompt).toContain(
      "BOOTSTRAP.md is included below in Project Context; follow it before replying normally.",
    );
    expect(prompt).toContain(
      "Do not use a generic first greeting or reply normally until after you have handled BOOTSTRAP.md.",
    );
    expect(prompt).toContain(
      "Your first user-visible reply for a bootstrap-pending workspace must follow BOOTSTRAP.md, not a generic greeting.",
    );
  });

  it("renders limited bootstrap guidance when the run cannot complete bootstrap", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [],
      bootstrapMode: "limited",
      modelDisplay: "test/model",
    });

    expect(prompt).toContain("## Bootstrap Pending");
    expect(prompt).toContain("this run cannot safely complete the full BOOTSTRAP.md workflow here");
  });

  it("omits the bootstrap gate when bootstrap mode is not provided", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [],
      modelDisplay: "test/model",
    });

    expect(prompt).not.toContain("## Bootstrap Pending");
  });

  it("includes CLI-scoped plugin command guidance", () => {
    // Plugin command guidance is surface-filtered; CLI prompts must not leak
    // OpenClaw-main command text into external CLI backends.
    registerPluginCommand("demo-plugin", {
      name: "demo_cli",
      description: "Demo CLI command",
      agentPromptGuidance: [
        {
          text: "CLI-only command guidance.",
          surfaces: ["cli_backend"],
        },
        {
          text: "OpenClaw-only command guidance.",
          surfaces: ["openclaw_main"],
        },
      ],
      handler: async () => ({ text: "ok" }),
    });

    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [{ name: "exec" } as never],
      modelDisplay: "test/model",
    });

    expect(prompt).toContain("CLI-only command guidance.");
    expect(prompt).not.toContain("OpenClaw-only command guidance.");
  });

  it("includes session identity in runtime when provided", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [],
      modelDisplay: "test/model",
      agentId: "main",
      sessionKey: "agent:main:telegram:direct:peer",
      sessionId: "session-123",
    });

    expect(prompt).toContain("agent=main");
    expect(prompt).toContain("session=agent:main:telegram:direct:peer");
    expect(prompt).toContain("sessionId=session-123");
  });

  it("includes Telegram rich text guidance for CLI final replies", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [],
      modelDisplay: "anthropic/claude-opus-4-8",
      runtimeChannel: "telegram",
      runtimeChatType: "direct",
      runtimeCapabilities: ["richText"],
    });

    expect(prompt).toContain("Telegram rich text is available");
    expect(prompt).toContain("headings, tables");
    expect(prompt).toContain("Media tags are blocks, not inline prose");
    expect(prompt).toContain("This is not legacy MarkdownV2/parse_mode");
    expect(prompt).toContain("channel=telegram");
    expect(prompt).not.toContain("### message tool");
  });

  it("requires an explicit message target when the CLI turn policy requires one", () => {
    const prompt = buildCliAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      tools: [{ name: "message" } as never],
      modelDisplay: "test/model",
      sourceReplyDeliveryMode: "message_tool_only",
      requireExplicitMessageTarget: true,
    });

    expect(prompt).toContain("include `target` and `message`; `target` is required for this turn");
    expect(prompt).not.toContain("The target defaults to the current source channel");
  });
});
