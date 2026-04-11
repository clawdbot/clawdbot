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
    const main = summaries.find((summary) => summary.id === "main");
    const work = summaries.find((summary) => summary.id === "work");

    expect(main).toBeTruthy();
    expect(main?.workspace).toBe(path.resolve("/main-ws/main"));
    expect(main?.bindings).toBe(1);
    expect(main?.model).toBe("anthropic/claude");
    expect(main?.agentDir.endsWith(path.join("agents", "main", "agent"))).toBe(true);

    expect(work).toBeTruthy();
    expect(work?.name).toBe("Work");
    expect(work?.workspace).toBe(path.resolve("/work-ws"));
    expect(work?.agentDir).toBe(path.resolve("/state/agents/work/agent"));
    expect(work?.bindings).toBe(1);
    expect(work?.isDefault).toBe(true);
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

    expect(result.added).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.config.bindings).toHaveLength(2);
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

    expect(result.added).toHaveLength(0);
    expect(result.updated).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
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

    expect(result.added).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
    expect(result.config.bindings).toHaveLength(2);
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

    expect(result.added).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.config.bindings).toHaveLength(2);
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

    expect(result.removed).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
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
    expect(result.config.agents?.list?.some((agent) => agent.id === "work")).toBe(false);
    expect(result.config.agents?.list?.some((agent) => agent.id === "home")).toBe(true);
    expect(result.config.bindings).toHaveLength(1);
    expect(result.config.bindings?.[0]?.agentId).toBe("home");
    expect(result.config.tools?.agentToAgent?.allow).toEqual(["home"]);
    expect(result.removedBindings).toBe(1);
    expect(result.removedAllow).toBe(1);
  });
});
