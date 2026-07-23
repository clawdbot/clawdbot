import { describe, expect, it } from "vitest";
import {
  configIncludeOwnsAgentRoster,
  hasResolvedRosterBeforeMigrations,
} from "./agent-roster-provenance.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.openclaw.js";

function snapshot(params: {
  parsed: unknown;
  sourceConfigBeforeMigrations: OpenClawConfig;
  agentRosterIncludeOwned?: boolean;
}): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    includedPaths: [],
    exists: true,
    raw: "{}",
    parsed: params.parsed,
    includeProvenance: { agentRoster: params.agentRosterIncludeOwned === true },
    sourceConfigBeforeMigrations: params.sourceConfigBeforeMigrations,
    sourceConfig: params.sourceConfigBeforeMigrations,
    resolved: params.sourceConfigBeforeMigrations,
    runtimeConfig: params.sourceConfigBeforeMigrations,
    config: params.sourceConfigBeforeMigrations,
    valid: true,
    issues: [],
    warnings: [],
    legacyIssues: [],
  } as ConfigFileSnapshot;
}

describe("agent roster include provenance", () => {
  it("recognizes an include at the entries boundary", () => {
    const value = snapshot({
      parsed: { agents: { entries: { $include: "./agents.json" } } },
      sourceConfigBeforeMigrations: { agents: { entries: { ops: { default: true } } } },
    });

    expect(configIncludeOwnsAgentRoster(value)).toBe(true);
  });

  it("recognizes an empty include at the entries boundary", () => {
    const value = snapshot({
      parsed: { agents: { entries: { $include: "./empty-roster.json" } } },
      sourceConfigBeforeMigrations: { agents: { entries: {} } },
    });

    expect(configIncludeOwnsAgentRoster(value)).toBe(true);
  });

  it("recognizes nested and mixed local-plus-included entries", () => {
    const value = snapshot({
      parsed: {
        $include: "./base.json",
        agents: { entries: { main: { default: true } } },
      },
      sourceConfigBeforeMigrations: {
        agents: {
          entries: {
            main: { default: true },
            ops: {},
          },
        },
      },
      agentRosterIncludeOwned: true,
    });

    expect(configIncludeOwnsAgentRoster(value)).toBe(true);
  });

  it("recognizes an included empty roster", () => {
    const value = snapshot({
      parsed: { $include: "./base.json" },
      sourceConfigBeforeMigrations: { agents: { entries: {} } },
      agentRosterIncludeOwned: true,
    });

    expect(hasResolvedRosterBeforeMigrations(value)).toBe(false);
    expect(configIncludeOwnsAgentRoster(value)).toBe(true);
  });

  it.each([
    {
      label: "unrelated ancestor include with a local roster",
      parsed: { $include: "./channels.json", agents: { entries: {} } },
      resolved: { agents: { entries: {} } },
      includeOwned: false,
      expected: false,
    },
    {
      label: "roster-contributing ancestor include",
      parsed: {
        $include: "./base.json",
        agents: { entries: { main: { default: true } } },
      },
      resolved: {
        agents: { entries: { main: { default: true }, ops: {} } },
      },
      includeOwned: true,
      expected: true,
    },
    {
      label: "identical ancestor include contribution",
      parsed: {
        $include: "./base.json",
        agents: { entries: { main: { default: true } } },
      },
      resolved: { agents: { entries: { main: { default: true } } } },
      includeOwned: true,
      expected: true,
    },
    {
      label: "direct agents.entries include",
      parsed: { agents: { entries: { $include: "./entries.json" } } },
      resolved: { agents: { entries: { ops: { default: true } } } },
      includeOwned: true,
      expected: true,
    },
  ])("classifies $label", ({ parsed, resolved, includeOwned, expected }) => {
    expect(
      configIncludeOwnsAgentRoster(
        snapshot({
          parsed,
          sourceConfigBeforeMigrations: resolved,
          agentRosterIncludeOwned: includeOwned,
        }),
      ),
    ).toBe(expected);
  });
});
