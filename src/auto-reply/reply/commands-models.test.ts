import { describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { buildCommandContext, handleCommands } from "./commands.js";
import { parseInlineDirectives } from "./directive-handling.js";

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" },
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet" },
    { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
    { provider: "openai", id: "gpt-4.1-mini", name: "GPT-4.1 Mini" },
    { provider: "google", id: "gemini-2.0-flash", name: "Gemini Flash" },
  ]),
}));

function buildParams(commandBody: string, cfg: ClawdbotConfig, ctxOverrides?: Partial<MsgContext>) {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "telegram",
    Surface: "telegram",
    ...ctxOverrides,
  } as MsgContext;

  const command = buildCommandContext({
    ctx,
    cfg,
    isGroup: false,
    triggerBodyNormalized: commandBody.trim().toLowerCase(),
    commandAuthorized: true,
  });

  return {
    ctx,
    cfg,
    command,
    directives: parseInlineDirectives(commandBody),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off" as const,
    resolvedReasoningLevel: "off" as const,
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "anthropic",
    model: "claude-opus-4-5",
    contextTokens: 16000,
    isGroup: false,
  };
}

describe("/models command", () => {
  const cfg = {
    commands: { text: true },
    // allowlist is empty => allowAny, but still okay for listing
    agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
  } as unknown as ClawdbotConfig;

  it.each(["telegram", "discord", "whatsapp"])("lists providers on %s", async (surface) => {
    const params = buildParams("/models", cfg, { Provider: surface, Surface: surface });
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Providers:");
    expect(result.reply?.text).toContain("anthropic");
    expect(result.reply?.text).toContain("Use: /models <provider>");
  });

  it("lists provider models with pagination hints", async () => {
    const params = buildParams("/models anthropic", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Models (anthropic)");
    expect(result.reply?.text).toContain("anthropic/claude-opus-4-5");
    expect(result.reply?.text).toContain("Switch: /model <provider/model>");
    expect(result.reply?.text).toContain("All: /models anthropic all");
  });

  it("handles unknown providers", async () => {
    const params = buildParams("/models not-a-provider", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Unknown provider");
    expect(result.reply?.text).toContain("Available providers");
  });
});
