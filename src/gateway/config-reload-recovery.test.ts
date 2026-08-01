import { describe, expect, it } from "vitest";
import type { GatewayReloadPlan } from "./config-reload-plan.js";
import { shouldRewarmProviderAuthState } from "./config-reload-recovery.js";

function plan(
  changedPaths: string[],
  overrides: Partial<GatewayReloadPlan> = {},
): GatewayReloadPlan {
  return {
    changedPaths,
    restartGateway: false,
    restartReasons: [],
    hotReasons: [],
    reloadHooks: false,
    restartGmailWatcher: false,
    restartCron: false,
    restartHeartbeat: false,
    restartHealthMonitor: false,
    reloadPlugins: false,
    restartChannels: new Set(),
    disposeMcpRuntimes: false,
    noopPaths: [],
    ...overrides,
  };
}

describe("shouldRewarmProviderAuthState", () => {
  it.each([
    "models",
    "models.providers.openai.api",
    "models.providers.anthropic",
    "secrets.api-key-1",
    "agent.model",
    "agent.model.default",
    "agents",
    "agents.defaults",
    "agents.defaults.model",
    "agents.defaults.models.provider",
    "agents.defaults.modelPolicy",
    "agents.defaults.utilityModel",
    "agents.defaults.agentRuntime",
    "agents.defaults.workspace",
    "agents.defaults.agentDir",
    "agents.entries",
    "agents.entries.main",
    "agents.entries.main.models",
    "agents.entries.main.model",
    "agents.entries.main.modelPolicy",
    "agents.entries.main.utilityModel",
    "agents.entries.main.agentRuntime",
    "agents.entries.main.workspace",
    "agents.entries.main.agentDir",
    "agents.entries.main.subagents",
    "agents.entries.main.subagents.model",
    "agents.defaults.subagents",
    "agents.defaults.subagents.model",
    "agents.defaults.subagents.model.default",
  ])("returns true for auth-relevant path %s", (path) => {
    expect(shouldRewarmProviderAuthState(plan([path]))).toBe(true);
  });

  it.each([
    "agents.defaults.heartbeat.target",
    "agents.defaults.heartbeat.delivery.target",
    "agents.entries.main.heartbeat.delivery.target",
    "agent.heartbeat",
    "agents.entries.main.cron",
    "agents.entries.main.ui",
    "agents.entries.main.tools",
    "agents.entries.main.skills",
    "agents.entries.main.memory",
    "agents.entries.main.systemPrompt",
    "agents.defaults.systemPrompt",
    "agents.defaults.subagents.thinking",
    "agents.entries.main.subagents.thinking",
    "agents.defaults.subagents.archiveAfterMinutes",
    "mcp.servers.context7.command",
    "hooks.gmail",
    "hooks.path",
    "logging.level",
    "channels.telegram",
    "channels.discord.accounts.bot",
    "gateway.port",
    "cron.schedules.daily",
  ])("returns false for unrelated path %s", (path) => {
    expect(shouldRewarmProviderAuthState(plan([path]))).toBe(false);
  });

  it("returns true when the plan reloads plugins", () => {
    expect(shouldRewarmProviderAuthState(plan([], { reloadPlugins: true }))).toBe(true);
  });

  it("returns true when an auth-relevant path is mixed with unrelated paths", () => {
    expect(
      shouldRewarmProviderAuthState(plan(["logging.level", "agents.defaults.workspace"])),
    ).toBe(true);
  });
});
