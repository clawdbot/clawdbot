import { describe, expect, it, vi } from "vitest";

import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.js";
import type { ClawdbotConfig } from "../../config/config.js";
import * as internalHooks from "../../hooks/internal-hooks.js";
import type { MsgContext } from "../templating.js";
import { resetBashChatCommandForTests } from "./bash-command.js";
import { buildCommandContext, handleCommands } from "./commands.js";
import { parseInlineDirectives } from "./directive-handling.js";

function buildParams(commandBody: string, cfg: ClawdbotConfig, ctxOverrides?: Partial<MsgContext>) {
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

describe("handleCommands gating", () => {
  it("blocks /bash when disabled", async () => {
    resetBashChatCommandForTests();
    const cfg = {
      commands: { bash: false, text: true },
      whatsapp: { allowFrom: ["*"] },
    } as ClawdbotConfig;
    const params = buildParams("/bash echo hi", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("bash is disabled");
  });

  it("blocks /bash when elevated is not allowlisted", async () => {
    resetBashChatCommandForTests();
    const cfg = {
      commands: { bash: true, text: true },
      whatsapp: { allowFrom: ["*"] },
    } as ClawdbotConfig;
    const params = buildParams("/bash echo hi", cfg);
    params.elevated = {
      enabled: true,
      allowed: false,
      failures: [{ gate: "allowFrom", key: "tools.elevated.allowFrom.whatsapp" }],
    };
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("elevated is not available");
  });

  it("blocks /config when disabled", async () => {
    const cfg = {
      commands: { config: false, debug: false, text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as ClawdbotConfig;
    const params = buildParams("/config show", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/config is disabled");
  });

  it("blocks /debug when disabled", async () => {
    const cfg = {
      commands: { config: false, debug: false, text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as ClawdbotConfig;
    const params = buildParams("/debug show", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/debug is disabled");
  });
});

describe("handleCommands bash alias", () => {
  it("routes !poll through the /bash handler", async () => {
    resetBashChatCommandForTests();
    const cfg = {
      commands: { bash: true, text: true },
      whatsapp: { allowFrom: ["*"] },
    } as ClawdbotConfig;
    const params = buildParams("!poll", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("No active bash job");
  });

  it("routes !stop through the /bash handler", async () => {
    resetBashChatCommandForTests();
    const cfg = {
      commands: { bash: true, text: true },
      whatsapp: { allowFrom: ["*"] },
    } as ClawdbotConfig;
    const params = buildParams("!stop", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("No active bash job");
  });
});

describe("handleCommands identity", () => {
  it("returns sender details for /whoami", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as ClawdbotConfig;
    const params = buildParams("/whoami", cfg, {
      SenderId: "12345",
      SenderUsername: "TestUser",
      ChatType: "direct",
    });
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Channel: whatsapp");
    expect(result.reply?.text).toContain("User id: 12345");
    expect(result.reply?.text).toContain("Username: @TestUser");
    expect(result.reply?.text).toContain("AllowFrom: 12345");
  });
});

describe("handleCommands hooks", () => {
  it("triggers hooks for /new with arguments", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as ClawdbotConfig;
    const params = buildParams("/new take notes", cfg);
    const spy = vi.spyOn(internalHooks, "triggerInternalHook").mockResolvedValue();

    await handleCommands(params);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: "command", action: "new" }));
    spy.mockRestore();
  });
});

describe("handleCommands context", () => {
  it("returns context help for /context", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as ClawdbotConfig;
    const params = buildParams("/context", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/context list");
    expect(result.reply?.text).toContain("Inline shortcut");
  });

  it("returns a per-file breakdown for /context list", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as ClawdbotConfig;
    const params = buildParams("/context list", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Injected workspace files:");
    expect(result.reply?.text).toContain("AGENTS.md");
  });

  it("returns a detailed breakdown for /context detail", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as ClawdbotConfig;
    const params = buildParams("/context detail", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Context breakdown (detailed)");
    expect(result.reply?.text).toContain("Top tools (schema size):");
  });
});

describe("handleCommands subagents", () => {
  it("lists subagents when none exist", async () => {
    resetSubagentRegistryForTests();
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as ClawdbotConfig;
    const params = buildParams("/subagents list", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Subagents: none");
  });

  it("returns help for unknown subagents action", async () => {
    resetSubagentRegistryForTests();
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as ClawdbotConfig;
    const params = buildParams("/subagents foo", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/subagents");
  });

  it("returns usage for subagents info without target", async () => {
    resetSubagentRegistryForTests();
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as ClawdbotConfig;
    const params = buildParams("/subagents info", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/subagents info");
  });

  it("includes subagent count in /status when active", async () => {
    resetSubagentRegistryForTests();
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { mainKey: "main", scope: "per-sender" },
    } as ClawdbotConfig;
    const params = buildParams("/status", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("🤖 Subagents: 1 active");
  });

  it("includes subagent details in /status when verbose", async () => {
    resetSubagentRegistryForTests();
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    addSubagentRunForTests({
      runId: "run-2",
      childSessionKey: "agent:main:subagent:def",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "finished task",
      cleanup: "keep",
      createdAt: 900,
      startedAt: 900,
      endedAt: 1200,
      outcome: { status: "ok" },
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { mainKey: "main", scope: "per-sender" },
    } as ClawdbotConfig;
    const params = buildParams("/status", cfg);
    params.resolvedVerboseLevel = "on";
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("🤖 Subagents: 1 active");
    expect(result.reply?.text).toContain("· 1 done");
  });

  it("returns info for a subagent", async () => {
    resetSubagentRegistryForTests();
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
      endedAt: 2000,
      outcome: { status: "ok" },
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { mainKey: "main", scope: "per-sender" },
    } as ClawdbotConfig;
    const params = buildParams("/subagents info 1", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Subagent info");
    expect(result.reply?.text).toContain("Run: run-1");
    expect(result.reply?.text).toContain("Status: done");
  });
});
