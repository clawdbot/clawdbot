import { describe, expect, it, vi } from "vitest";

import type { MoltbotConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { buildCommandContext, handleCommands } from "./commands.js";
import { parseInlineDirectives } from "./directive-handling.js";
import { callGateway } from "../../gateway/call.js";

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

function buildParams(commandBody: string, cfg: MoltbotConfig, ctxOverrides?: Partial<MsgContext>) {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "whatsapp",
    Surface: "whatsapp",
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
    provider: "whatsapp",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
}

describe("/approve command", () => {
  it("rejects invalid usage", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as MoltbotConfig;
    const params = buildParams("/approve", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Usage: /approve");
  });

  it("submits approval", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as MoltbotConfig;
    const params = buildParams("/approve abc allow-once", cfg, { SenderId: "123" });

    const mockCallGateway = vi.mocked(callGateway);
    mockCallGateway.mockResolvedValueOnce({ ok: true });

    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Exec approval allow-once submitted");
    expect(mockCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "exec.approval.resolve",
        params: { id: "abc", decision: "allow-once" },
      }),
    );
  });
});
