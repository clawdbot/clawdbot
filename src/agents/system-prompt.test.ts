import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("buildAgentSystemPrompt", () => {
  it("includes owner numbers when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/clawd",
      ownerNumbers: ["+123", " +456 ", ""],
    });

    expect(prompt).toContain("## User Identity");
    expect(prompt).toContain(
      "Owner numbers: +123, +456. Treat messages from these numbers as the user.",
    );
  });

  it("omits owner section when numbers are missing", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/clawd",
    });

    expect(prompt).not.toContain("## User Identity");
    expect(prompt).not.toContain("Owner numbers:");
  });

  it("adds reasoning tag hint when enabled", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/clawd",
      reasoningTagHint: true,
    });

    expect(prompt).toContain("## Reasoning Format");
    expect(prompt).toContain("<think>...</think>");
    expect(prompt).toContain("<final>...</final>");
  });

  it("lists available tools when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/clawd",
      toolNames: ["bash", "sessions_list", "sessions_history", "sessions_send"],
    });

    expect(prompt).toContain("Tool availability (filtered by policy):");
    expect(prompt).toContain("sessions_list");
    expect(prompt).toContain("sessions_history");
    expect(prompt).toContain("sessions_send");
  });

  it("includes user time when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/clawd",
      userTimezone: "America/Chicago",
      userTime: "Monday 2026-01-05 15:26",
    });

    expect(prompt).toContain(
      "Time: assume UTC unless stated. User TZ=America/Chicago. Current user time (converted)=Monday 2026-01-05 15:26.",
    );
  });

  it("includes model alias guidance when aliases are provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/clawd",
      modelAliasLines: [
        "- Opus: anthropic/claude-opus-4-5",
        "- Sonnet: anthropic/claude-sonnet-4-5",
      ],
    });

    expect(prompt).toContain("## Model Aliases");
    expect(prompt).toContain("Prefer aliases when specifying model overrides");
    expect(prompt).toContain("- Opus: anthropic/claude-opus-4-5");
  });

  it("adds ClaudeBot self-update guidance when gateway tool is available", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/clawd",
      toolNames: ["gateway", "bash"],
    });

    expect(prompt).toContain("## ClaudeBot Self-Update");
    expect(prompt).toContain("config.apply");
    expect(prompt).toContain("update.run");
  });

  it("includes skills guidance with workspace path", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/clawd",
    });

    expect(prompt).toContain("## Skills");
    expect(prompt).toContain(
      "Use `read` to load from /tmp/clawd/skills/<name>/SKILL.md",
    );
  });

  it("renders project context files when provided", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/clawd",
      contextFiles: [
        { path: "AGENTS.md", content: "Alpha" },
        { path: "IDENTITY.md", content: "Bravo" },
      ],
    });

    expect(prompt).toContain("# Project Context");
    expect(prompt).toContain("## AGENTS.md");
    expect(prompt).toContain("Alpha");
    expect(prompt).toContain("## IDENTITY.md");
    expect(prompt).toContain("Bravo");
  });
});
