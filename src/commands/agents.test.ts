import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyAgentBindings,
  applyAgentConfig,
  buildAgentSummaries,
  pruneAgentConfig,
  removeAgentBindings,
} from "./agents.js";

function requireAgentSummary(
  summaries: ReturnType<typeof buildAgentSummaries>,
  id: string,
): ReturnType<typeof buildAgentSummaries>[number] {
  const summary = summaries.find((entry) => entry.id === id);
  if (!summary) {
    throw new Error(`expected agent summary ${id}`);
  }
  return summary;
}

describe("agents helpers", () => {
  it("buildAgentSummaries includes default + configured agents", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: "/main-ws",
          model: { primary: "anthropic/claude" },
        },
        list: [
          { id: "main" },
          {
            id: "work",
            default: true,
            name: "Work",
            workspace: "/work-ws",
            agentDir: "/state/agents/work/agent",
            model: "openai/gpt-4.1",
          },
        ],
      },
      bindings: [
        {
          agentId: "work",
          match: { channel: "whatsapp", accountId: "biz" },
        },
        { agentId: "main", match: { channel: "telegram" } },
      ],
    };

    const summaries = buildAgentSummaries(cfg);
    const main = requireAgentSummary(summaries, "main");
    const work = requireAgentSummary(summaries, "work");

    expect(main.workspace).toBe(path.resolve("/main-ws/main"));
    expect(main.bindings).toBe(1);
    expect(main.model).toBe("anthropic/claude");
    expect(main.agentDir.endsWith(path.join("agents", "main", "agent"))).toBe(true);

    expect(work.name).toBe("Work");
    expect(work.workspace).toBe(path.resolve("/work-ws"));
    expect(work.agentDir).toBe(path.resolve("/state/agents/work/agent"));
    expect(work.bindings).toBe(1);
    expect(work.isDefault).toBe(true);
  });

  it("applyAgentConfig merges updates", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "work", workspace: "/old-ws", model: "anthropic/claude" }],
      },
    };

    const next = applyAgentConfig(cfg, {
      agentId: "work",
      name: "Work",
      workspace: "/new-ws",
      agentDir: "/state/work/agent",
    });

    const work = next.agents?.list?.find((agent) => agent.id === "work");
    expect(work?.name).toBe("Work");
    expect(work?.workspace).toBe("/new-ws");
    expect(work?.agentDir).toBe("/state/work/agent");
    expect(work?.model).toBe("anthropic/claude");
  });

  it("applyAgentConfig merges identity with existing", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "work", identity: { name: "Old", theme: "chill", emoji: "🐢" } }],
      },
    };

    const next = applyAgentConfig(cfg, {
      agentId: "work",
      identity: { name: "New", emoji: "🦀" },
    });

    const work = next.agents?.list?.find((agent) => agent.id === "work");
    expect(work?.identity?.name).toBe("New");
    expect(work?.identity?.emoji).toBe("🦀");
    expect(work?.identity?.theme).toBe("chill");
  });

  it("applyAgentConfig skips identity when not provided", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "work", identity: { name: "Keep", emoji: "🐢" } }],
      },
    };

    const next = applyAgentConfig(cfg, { agentId: "work", name: "Renamed" });

    const work = next.agents?.list?.find((agent) => agent.id === "work");
    expect(work?.name).toBe("Renamed");
    expect(work?.identity?.name).toBe("Keep");
    expect(work?.identity?.emoji).toBe("🐢");
  });

  it("applyAgentBindings skips duplicates and reports conflicts", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "main",
          match: { channel: "whatsapp", accountId: "default" },
        },
      ],
    };

    const result = applyAgentBindings(cfg, [
      {
        agentId: "main",
        match: { channel: "whatsapp", accountId: "default" },
      },
      {
        agentId: "work",
        match: { channel: "whatsapp", accountId: "default" },
      },
      {
        agentId: "work",
        match: { channel: "telegram" },
      },
    ]);

    expect(result.added).toStrictEqual([
      {
        agentId: "work",
        match: { channel: "telegram" },
      },
    ]);
    expect(result.skipped).toStrictEqual([
      {
        agentId: "main",
        match: { channel: "whatsapp", accountId: "default" },
      },
    ]);
    expect(result.conflicts).toStrictEqual([
      {
        binding: {
          agentId: "work",
          match: { channel: "whatsapp", accountId: "default" },
        },
        existingAgentId: "main",
      },
    ]);
    expect(result.config.bindings).toStrictEqual([
      {
        agentId: "main",
        match: { channel: "whatsapp", accountId: "default" },
      },
      {
        agentId: "work",
        match: { channel: "telegram" },
      },
    ]);
  });

  it("applyAgentBindings upgrades channel-only binding to account-specific binding for same agent", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "main",
          match: { channel: "telegram" },
        },
      ],
    };

    const result = applyAgentBindings(cfg, [
      {
        agentId: "main",
        match: { channel: "telegram", accountId: "work" },
      },
    ]);

    expect(result.added).toStrictEqual([]);
    expect(result.updated).toStrictEqual([
      {
        agentId: "main",
        match: { channel: "telegram", accountId: "work" },
      },
    ]);
    expect(result.conflicts).toStrictEqual([]);
    expect(result.config.bindings).toEqual([
      {
        agentId: "main",
        match: { channel: "telegram", accountId: "work" },
      },
    ]);
  });

  it("applyAgentBindings treats role-based bindings as distinct routes", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "main",
          match: {
            channel: "discord",
            accountId: "guild-a",
            guildId: "123",
            roles: ["111", "222"],
          },
        },
      ],
    };

    const result = applyAgentBindings(cfg, [
      {
        agentId: "work",
        match: {
          channel: "discord",
          accountId: "guild-a",
          guildId: "123",
        },
      },
    ]);

    expect(result.added).toStrictEqual([
      {
        agentId: "work",
        match: {
          channel: "discord",
          accountId: "guild-a",
          guildId: "123",
        },
      },
    ]);
    expect(result.conflicts).toStrictEqual([]);
    expect(result.config.bindings).toStrictEqual([
      {
        agentId: "main",
        match: {
          channel: "discord",
          accountId: "guild-a",
          guildId: "123",
          roles: ["111", "222"],
        },
      },
      {
        agentId: "work",
        match: {
          channel: "discord",
          accountId: "guild-a",
          guildId: "123",
        },
      },
    ]);
  });

  it("applyAgentBindings keeps distinct bindings when persisted match fields contain pipes", () => {
    const cfg: OpenClawConfig = {};

    const result = applyAgentBindings(cfg, [
      {
        agentId: "main",
        match: {
          channel: "discord",
          peer: { kind: "direct", id: "a|b" },
          accountId: "default",
        },
      },
      {
        agentId: "main",
        match: {
          channel: "discord",
          peer: { kind: "direct", id: "a" },
          guildId: "b",
          accountId: "|default",
        },
      },
    ]);

    expect(result.added).toStrictEqual([
      {
        agentId: "main",
        match: {
          channel: "discord",
          peer: { kind: "direct", id: "a|b" },
          accountId: "default",
        },
      },
      {
        agentId: "main",
        match: {
          channel: "discord",
          peer: { kind: "direct", id: "a" },
          guildId: "b",
          accountId: "|default",
        },
      },
    ]);
    expect(result.skipped).toStrictEqual([]);
    expect(result.conflicts).toStrictEqual([]);
    expect(result.config.bindings).toStrictEqual(result.added);
  });

  it("removeAgentBindings does not remove role-based bindings when removing channel-level routes", () => {
    const cfg: OpenClawConfig = {
      bindings: [
        {
          agentId: "main",
          match: {
            channel: "discord",
            accountId: "guild-a",
            guildId: "123",
            roles: ["111", "222"],
          },
        },
        {
          agentId: "main",
          match: {
            channel: "discord",
            accountId: "guild-a",
            guildId: "123",
          },
        },
      ],
    };

    const result = removeAgentBindings(cfg, [
      {
        agentId: "main",
        match: {
          channel: "discord",
          accountId: "guild-a",
          guildId: "123",
        },
      },
    ]);

    expect(result.removed).toStrictEqual([
      {
        agentId: "main",
        match: {
          channel: "discord",
          accountId: "guild-a",
          guildId: "123",
        },
      },
    ]);
    expect(result.conflicts).toStrictEqual([]);
    expect(result.config.bindings).toEqual([
      {
        agentId: "main",
        match: {
          channel: "discord",
          accountId: "guild-a",
          guildId: "123",
          roles: ["111", "222"],
        },
      },
    ]);
  });

  it("pruneAgentConfig removes agent, bindings, and allowlist entries", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "work", default: true, workspace: "/work-ws" },
          { id: "home", workspace: "/home-ws" },
        ],
      },
      bindings: [
        { agentId: "work", match: { channel: "whatsapp" } },
        { agentId: "home", match: { channel: "telegram" } },
      ],
      tools: {
        agentToAgent: { enabled: true, allow: ["work", "home"] },
      },
    };

    const result = pruneAgentConfig(cfg, "work");
    expect(result.config.agents?.list?.map((agent) => agent.id)).not.toContain("work");
    expect(result.config.agents?.list?.map((agent) => agent.id)).toContain("home");
    expect(result.config.bindings).toStrictEqual([
      { agentId: "home", match: { channel: "telegram" } },
    ]);
    expect(result.config.tools?.agentToAgent?.allow).toEqual(["home"]);
    expect(result.removedBindings).toBe(1);
    expect(result.removedAllow).toBe(1);
  });
});
