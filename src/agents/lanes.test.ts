import { describe, expect, it } from "vitest";
import { CommandLane } from "../process/lanes.js";
import {
  AGENT_LANE_CRON_NESTED,
  AGENT_LANE_NESTED,
  isNestedAgentLane,
  resolveCronAgentLane,
  resolveNestedAgentLane,
  resolveNestedAgentLaneForSession,
} from "./lanes.js";

describe("resolveNestedAgentLane", () => {
  it("defaults to the nested lane when no lane is provided", () => {
    expect(resolveNestedAgentLane()).toBe(AGENT_LANE_NESTED);
  });

  it("preserves explicit lanes", () => {
    expect(resolveNestedAgentLane("cron")).toBe(CommandLane.Cron);
    expect(resolveNestedAgentLane("  cron  ")).toBe(CommandLane.Cron);
    expect(resolveNestedAgentLane("subagent")).toBe("subagent");
    expect(resolveNestedAgentLane(" custom-lane ")).toBe("custom-lane");
  });
});

describe("resolveCronAgentLane", () => {
  it("defaults cron-owned runs to the cron-nested lane", () => {
    expect(resolveCronAgentLane()).toBe(AGENT_LANE_CRON_NESTED);
  });

  it("moves cron lane callers onto the cron-nested lane", () => {
    expect(resolveCronAgentLane("cron")).toBe(AGENT_LANE_CRON_NESTED);
    expect(resolveCronAgentLane("  cron  ")).toBe(AGENT_LANE_CRON_NESTED);
  });

  it("preserves non-cron lanes", () => {
    expect(resolveCronAgentLane("subagent")).toBe("subagent");
    expect(resolveCronAgentLane(" custom-lane ")).toBe("custom-lane");
  });
});

describe("resolveNestedAgentLaneForSession (#67502)", () => {
  it("falls back to the unscoped nested lane when no session key is provided", () => {
    expect(resolveNestedAgentLaneForSession(undefined)).toBe(AGENT_LANE_NESTED);
    expect(resolveNestedAgentLaneForSession("")).toBe(AGENT_LANE_NESTED);
    expect(resolveNestedAgentLaneForSession("   ")).toBe(AGENT_LANE_NESTED);
  });

  it("scopes the nested lane per target session key", () => {
    expect(resolveNestedAgentLaneForSession("agent:ebao-next:discord:channel:1")).toBe(
      `${AGENT_LANE_NESTED}:agent:ebao-next:discord:channel:1`,
    );
  });

  it("produces distinct lanes for distinct target sessions", () => {
    const laneA = resolveNestedAgentLaneForSession("agent:ebao-next:discord:channel:1");
    const laneB = resolveNestedAgentLaneForSession("agent:ebao-vue:discord:channel:2");
    expect(laneA).not.toBe(laneB);
  });

  it("is deterministic for the same session key across calls", () => {
    const key = "agent:ebao:discord:channel:1";
    expect(resolveNestedAgentLaneForSession(key)).toBe(resolveNestedAgentLaneForSession(key));
  });

  it("trims whitespace around the session key before scoping", () => {
    expect(resolveNestedAgentLaneForSession("   agent:ebao:main   ")).toBe(
      `${AGENT_LANE_NESTED}:agent:ebao:main`,
    );
  });
});

describe("isNestedAgentLane", () => {
  it("returns true for the unscoped nested lane", () => {
    expect(isNestedAgentLane(AGENT_LANE_NESTED)).toBe(true);
  });

  it("returns true for per-session nested lanes", () => {
    expect(isNestedAgentLane(resolveNestedAgentLaneForSession("agent:a:main"))).toBe(true);
    expect(isNestedAgentLane(`${AGENT_LANE_NESTED}:agent:a:main`)).toBe(true);
  });

  it("returns false for unrelated lanes", () => {
    expect(isNestedAgentLane("main")).toBe(false);
    expect(isNestedAgentLane("cron")).toBe(false);
    expect(isNestedAgentLane("subagent")).toBe(false);
    expect(isNestedAgentLane("session:agent:a:main")).toBe(false);
  });

  it("returns false for lanes that merely contain 'nested' as a substring", () => {
    expect(isNestedAgentLane("deeply-nested-lane")).toBe(false);
    expect(isNestedAgentLane("session:nested")).toBe(false);
    expect(isNestedAgentLane("nestedfoo")).toBe(false);
  });

  it("returns false for empty or missing lane names", () => {
    expect(isNestedAgentLane(undefined)).toBe(false);
    expect(isNestedAgentLane("")).toBe(false);
  });
});
