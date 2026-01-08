import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import {
  applyAgentBindings,
  applyAgentConfig,
  buildAgentSummaries,
  pruneAgentConfig,
} from "./agents.js";

describe("agents helpers", () => {
  it("buildAgentSummaries includes default + routing agents", () => {
    const cfg: ClawdbotConfig = {
      agent: { workspace: "/main-ws", model: { primary: "anthropic/claude" } },
      routing: {
        defaultAgentId: "work",
        agents: {
          work: {
            name: "Work",
            workspace: "/work-ws",
            agentDir: "/state/agents/work/agent",
            model: "openai/gpt-4.1",
          },
        },
        bindings: [
          {
            agentId: "work",
            match: { provider: "whatsapp", accountId: "biz" },
          },
          { agentId: "main", match: { provider: "telegram" } },
        ],
      },
    };

    const summaries = buildAgentSummaries(cfg);
    const main = summaries.find((summary) => summary.id === "main");
    const work = summaries.find((summary) => summary.id === "work");

    expect(main).toBeTruthy();
    expect(main?.workspace).toBe(path.resolve("/main-ws"));
    expect(main?.bindings).toBe(1);
    expect(main?.model).toBe("anthropic/claude");
    expect(main?.agentDir.endsWith(path.join("agents", "main", "agent"))).toBe(
      true,
    );

    expect(work).toBeTruthy();
    expect(work?.name).toBe("Work");
    expect(work?.workspace).toBe(path.resolve("/work-ws"));
    expect(work?.agentDir).toBe(path.resolve("/state/agents/work/agent"));
    expect(work?.bindings).toBe(1);
    expect(work?.isDefault).toBe(true);
  });

  it("applyAgentConfig merges updates", () => {
    const cfg: ClawdbotConfig = {
      routing: {
        agents: {
          work: { workspace: "/old-ws", model: "anthropic/claude" },
        },
      },
    };

    const next = applyAgentConfig(cfg, {
      agentId: "work",
      name: "Work",
      workspace: "/new-ws",
      agentDir: "/state/work/agent",
    });

    const work = next.routing?.agents?.work;
    expect(work?.name).toBe("Work");
    expect(work?.workspace).toBe("/new-ws");
    expect(work?.agentDir).toBe("/state/work/agent");
    expect(work?.model).toBe("anthropic/claude");
  });

  it("applyAgentBindings skips duplicates and reports conflicts", () => {
    const cfg: ClawdbotConfig = {
      routing: {
        bindings: [
          {
            agentId: "main",
            match: { provider: "whatsapp", accountId: "default" },
          },
        ],
      },
    };

    const result = applyAgentBindings(cfg, [
      {
        agentId: "main",
        match: { provider: "whatsapp", accountId: "default" },
      },
      {
        agentId: "work",
        match: { provider: "whatsapp", accountId: "default" },
      },
      {
        agentId: "work",
        match: { provider: "telegram" },
      },
    ]);

    expect(result.added).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.config.routing?.bindings).toHaveLength(2);
  });

  it("pruneAgentConfig removes agent, bindings, and allowlist entries", () => {
    const cfg: ClawdbotConfig = {
      routing: {
        defaultAgentId: "work",
        agents: {
          work: { workspace: "/work-ws" },
          home: { workspace: "/home-ws" },
        },
        bindings: [
          { agentId: "work", match: { provider: "whatsapp" } },
          { agentId: "home", match: { provider: "telegram" } },
        ],
        agentToAgent: { enabled: true, allow: ["work", "home"] },
      },
    };

    const result = pruneAgentConfig(cfg, "work");
    expect(result.config.routing?.agents?.work).toBeUndefined();
    expect(result.config.routing?.agents?.home).toBeTruthy();
    expect(result.config.routing?.bindings).toHaveLength(1);
    expect(result.config.routing?.bindings?.[0]?.agentId).toBe("home");
    expect(result.config.routing?.agentToAgent?.allow).toEqual(["home"]);
    expect(result.config.routing?.defaultAgentId).toBe(DEFAULT_AGENT_ID);
    expect(result.removedBindings).toBe(1);
    expect(result.removedAllow).toBe(1);
  });
});
