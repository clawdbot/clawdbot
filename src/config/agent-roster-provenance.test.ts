import { describe, expect, it } from "vitest";
import {
  configIncludeOwnsAgentRoster,
  hasResolvedRosterBeforeMigrations,
} from "./agent-roster-provenance.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.openclaw.js";

function snapshot(params: {
  parsed: unknown;
  sourceConfigBeforeMigrations: OpenClawConfig;
}): ConfigFileSnapshot {
  return {
    path: "/tmp/openclaw.json",
    includedPaths: [],
    exists: true,
    raw: "{}",
    parsed: params.parsed,
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
    });

    expect(configIncludeOwnsAgentRoster(value)).toBe(true);
  });

  it("recognizes an included empty roster", () => {
    const value = snapshot({
      parsed: { $include: "./base.json" },
      sourceConfigBeforeMigrations: { agents: { entries: {} } },
    });

    expect(hasResolvedRosterBeforeMigrations(value)).toBe(false);
    expect(configIncludeOwnsAgentRoster(value)).toBe(true);
  });

  it("conservatively assigns an agents-scoped include ownership when roster shape is unchanged", () => {
    const entries = { main: { default: true } };
    const value = snapshot({
      parsed: {
        agents: { $include: "./empty-roster.json", entries },
      },
      sourceConfigBeforeMigrations: { agents: { entries } },
    });

    expect(configIncludeOwnsAgentRoster(value)).toBe(true);
  });

  it("treats an ancestor include with an identical roster contribution as include-owned", () => {
    const entries = { main: { default: true } };
    const value = snapshot({
      parsed: {
        $include: "./channels.json",
        agents: { entries },
      },
      sourceConfigBeforeMigrations: { agents: { entries } },
    });

    expect(configIncludeOwnsAgentRoster(value)).toBe(true);
  });

  it("keeps ancestor-include ownership conservative across local env resolution", () => {
    const value = snapshot({
      parsed: {
        $include: "./channels.json",
        agents: { entries: { main: { default: true, agentDir: "${MAIN_AGENT_DIR}" } } },
      },
      sourceConfigBeforeMigrations: {
        agents: { entries: { main: { default: true, agentDir: "/srv/main" } } },
      },
    });

    expect(configIncludeOwnsAgentRoster(value)).toBe(true);
  });
});
