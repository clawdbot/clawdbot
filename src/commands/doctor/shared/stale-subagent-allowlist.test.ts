// Stale subagent allowlist tests cover doctor warnings for obsolete subagent allowlists.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  collectStaleSubagentAllowlistWarnings,
  maybeRepairStaleSubagentAllowlists,
  scanStaleSubagentAllowlistReferences,
} from "./stale-subagent-allowlist.js";

describe("stale subagent allowlist doctor repair", () => {
  it("detects stale default and per-agent subagent targets", () => {
    const cfg = {
      agents: {
        defaults: {
          subagents: {
            allowAgents: ["planner", "stale-default"],
          },
        },
        list: [
          {
            id: "main",
            subagents: {
              allowAgents: ["planner", "stale-main"],
            },
          },
          { id: "planner" },
        ],
      },
    } as OpenClawConfig;

    expect(scanStaleSubagentAllowlistReferences(cfg)).toStrictEqual([
      {
        pathLabel: "agents.defaults.subagents.allowAgents",
        agentId: "stale-default",
        normalizedAgentId: "stale-default",
      },
      {
        pathLabel: "agents.list.main.subagents.allowAgents",
        agentId: "stale-main",
        normalizedAgentId: "stale-main",
      },
    ]);
  });

  it("keeps wildcard, configured OpenClaw agents, and configured ACP targets", () => {
    const cfg = {
      acp: {
        defaultAgent: "claude",
        allowedAgents: ["codex"],
      },
      agents: {
        defaults: {
          subagents: {
            allowAgents: ["*", "main", "planner", "codex", "claude", "writer", "stale"],
          },
        },
        list: [
          { id: "main" },
          { id: "planner" },
          {
            id: "writer-agent",
            runtime: { type: "acp", acp: { agent: "writer" } },
          },
        ],
      },
    } as OpenClawConfig;

    expect(scanStaleSubagentAllowlistReferences(cfg)).toStrictEqual([
      {
        pathLabel: "agents.defaults.subagents.allowAgents",
        agentId: "stale",
        normalizedAgentId: "stale",
      },
    ]);
  });

  it("repairs stale entries without widening an explicit empty allowlist", () => {
    const cfg = {
      agents: {
        defaults: {
          subagents: {
            allowAgents: ["stale"],
          },
        },
        list: [
          {
            id: "main",
            subagents: {
              allowAgents: ["*", "planner", "stale-main"],
            },
          },
          { id: "planner" },
        ],
      },
    } as OpenClawConfig;

    const result = maybeRepairStaleSubagentAllowlists(cfg);

    expect(result.config.agents?.defaults?.subagents?.allowAgents).toStrictEqual([]);
    expect(result.config.agents?.list?.[0]?.subagents?.allowAgents).toStrictEqual(["*", "planner"]);
    expect(result.changes).toStrictEqual([
      "- agents.defaults.subagents.allowAgents: removed 1 stale subagent target id (stale)",
      "- agents.list.main.subagents.allowAgents: removed 1 stale subagent target id (stale-main)",
    ]);
  });

  it("formats preview warnings with the doctor fix command", () => {
    const warnings = collectStaleSubagentAllowlistWarnings({
      hits: [
        {
          pathLabel: "agents.defaults.subagents.allowAgents",
          agentId: "research",
          normalizedAgentId: "research",
        },
      ],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toStrictEqual([
      '- agents.defaults.subagents.allowAgents: stale subagent target "research" is not in the configured agent registry.',
      '- Run "openclaw doctor --fix" to remove stale subagent target ids, or add a configured agent or ACP target for each intended target.',
    ]);
  });
});
