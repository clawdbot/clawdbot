/**
 * Regression coverage for local-model lean tool filtering.
 * Verifies agent scope, default flags, preserve lists, and message-tool overrides.
 */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import {
  applyLocalModelLeanToolSearchDefaults,
  filterLocalModelLeanTools,
  isLocalModelLeanEnabled,
  resolveLocalModelLeanPreserveToolNames,
} from "./local-model-lean.js";

function tools(names: string[]): AnyAgentTool[] {
  return names.map((name) => ({ name })) as AnyAgentTool[];
}

describe("local model lean tool filtering", () => {
  it("filters heavyweight tools for one configured agent", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "gemma",
            experimental: {
              localModelLean: true,
            },
          },
        ],
      },
    };

    expect(isLocalModelLeanEnabled({ config: cfg, agentId: "gemma" })).toBe(true);
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config: cfg,
        agentId: "gemma",
      }).map((tool) => tool.name),
    ).toEqual(["read", "exec"]);
  });

  it("keeps explicitly preserved tools when lean mode is enabled", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
          },
        },
      },
    };

    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config: cfg,
        preserveToolNames: ["browser", "cron", "group:messaging"],
      }).map((tool) => tool.name),
    ).toEqual(["read", "browser", "cron", "message", "exec"]);
  });

  it("adds reply-required message tools to lean preservation", () => {
    expect(
      resolveLocalModelLeanPreserveToolNames({
        forceMessageTool: true,
      }),
    ).toEqual(["message"]);
    expect(
      resolveLocalModelLeanPreserveToolNames({
        sourceReplyDeliveryMode: "message_tool_only",
      }),
    ).toEqual(["message"]);
    expect(
      resolveLocalModelLeanPreserveToolNames({
        toolNames: ["group:messaging"],
        forceMessageTool: true,
      }),
    ).toEqual(["group:messaging", "message"]);
  });

  it("does not treat wildcard preservation as disabling lean mode", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
          },
        },
      },
    };

    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config: cfg,
        preserveToolNames: ["*"],
      }).map((tool) => tool.name),
    ).toEqual(["read", "exec"]);
  });

  it("lets an agent opt out of an inherited global lean setting", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
          },
        },
        list: [
          {
            id: "main",
            experimental: {
              localModelLean: false,
            },
          },
        ],
      },
    };

    expect(isLocalModelLeanEnabled({ config: cfg, agentId: "main" })).toBe(false);
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config: cfg,
        agentId: "main",
      }).map((tool) => tool.name),
    ).toEqual(["read", "browser", "cron", "message", "exec"]);
  });

  it("inherits global lean mode when an agent experimental block omits the flag", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
          },
        },
        list: [
          {
            id: "main",
            experimental: {},
          },
        ],
      },
    };

    expect(isLocalModelLeanEnabled({ config: cfg, agentId: "main" })).toBe(true);
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config: cfg,
        agentId: "main",
      }).map((tool) => tool.name),
    ).toEqual(["read", "exec"]);
  });

  it("keeps global lean mode for an agent id without an agent entry", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
          },
        },
      },
    };

    expect(isLocalModelLeanEnabled({ config: cfg, agentId: "ad-hoc" })).toBe(true);
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config: cfg,
        agentId: "ad-hoc",
      }).map((tool) => tool.name),
    ).toEqual(["read", "exec"]);
  });

  it("uses the configured default agent when no agent id is explicit", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "gemma",
            default: true,
            experimental: {
              localModelLean: true,
            },
          },
        ],
      },
    };

    expect(isLocalModelLeanEnabled({ config: cfg })).toBe(true);
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config: cfg,
      }).map((tool) => tool.name),
    ).toEqual(["read", "exec"]);
  });

  it("uses the agent from an agent session key", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            experimental: {
              localModelLean: false,
            },
          },
          {
            id: "gemma",
            experimental: {
              localModelLean: true,
            },
          },
        ],
      },
    };

    expect(isLocalModelLeanEnabled({ config: cfg, sessionKey: "agent:gemma:main" })).toBe(true);
    expect(
      filterLocalModelLeanTools({
        tools: tools(["read", "browser", "cron", "message", "exec"]),
        config: cfg,
        sessionKey: "agent:gemma:main",
      }).map((tool) => tool.name),
    ).toEqual(["read", "exec"]);
  });

  it("defaults lean runs to structured Tool Search controls", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
          },
        },
      },
    };

    const resolved = applyLocalModelLeanToolSearchDefaults({ config: cfg, agentId: "main" });

    expect(resolved).not.toBe(cfg);
    expect(resolved?.tools?.toolSearch).toEqual({
      enabled: true,
      mode: "tools",
      searchDefaultLimit: 5,
      maxSearchLimit: 10,
    });
    expect(cfg.tools?.toolSearch).toBeUndefined();
  });

  it("preserves explicit Tool Search operator config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
          },
        },
      },
      tools: {
        toolSearch: false,
      },
    };

    expect(applyLocalModelLeanToolSearchDefaults({ config: cfg, agentId: "main" })).toBe(cfg);
  });
});
