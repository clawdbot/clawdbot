import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { MoltbotConfig } from "../config/config.js";
import {
  applyAgentBindings,
  applyAgentConfig,
  buildAgentSummaries,
  pruneAgentConfig,
} from "./agents.js";

describe("agents helpers", () => {
  it("buildAgentSummaries includes default + configured agents", () => {
    const cfg: MoltbotConfig = {
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
    expect(main?.workspace).toBe(path.join(os.homedir(), "clawd-main"));
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
    const cfg: MoltbotConfig = {
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

  it("applyAgentBindings skips duplicates and reports conflicts", () => {
    const cfg: MoltbotConfig = {
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

  it("pruneAgentConfig removes agent, bindings, and allowlist entries", () => {
    const cfg: MoltbotConfig = {
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
