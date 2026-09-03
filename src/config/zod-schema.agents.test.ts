import { describe, expect, it } from "vitest";
import { AgentsSchema } from "./zod-schema.agents.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("agent roster ownership", () => {
  it("rejects an empty roster after load-time migration", () => {
    expect(AgentsSchema.safeParse({ entries: {} }).success).toBe(false);
  });

  it("accepts sole and explicitly owned multi-agent rosters without a stored default", () => {
    expect(AgentsSchema.safeParse({ entries: { alpha: {} } }).success).toBe(true);
    expect(
      AgentsSchema.safeParse({ ownership: "explicit", entries: { alpha: {}, beta: {} } }).success,
    ).toBe(true);
  });

  it("rejects a markerless multi-agent roster without explicit ownership", () => {
    const result = AgentsSchema.safeParse({ entries: { alpha: {}, beta: {} } });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('agents.ownership="explicit"');
      expect(result.error.issues[0]?.message).toContain("run openclaw doctor");
    }
  });

  it("accepts one legacy default marker", () => {
    expect(
      AgentsSchema.safeParse({ entries: { alpha: { default: true }, beta: {} } }).success,
    ).toBe(true);
  });

  it("rejects multiple legacy default markers", () => {
    expect(
      AgentsSchema.safeParse({
        entries: { alpha: { default: true }, beta: { default: true } },
      }).success,
    ).toBe(false);
  });

  it("rejects entry keys that resolve to the same agent id", () => {
    const result = AgentsSchema.safeParse({
      ownership: "explicit",
      entries: { Ops: {}, ops: {} },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        path: ["entries", "ops"],
        message:
          'agents.entries keys "Ops" and "ops" resolve to the same agent id "ops"; rename one key so each agent has a unique id',
      });
    }
  });

  it("accepts one mixed-case entry key", () => {
    expect(AgentsSchema.safeParse({ entries: { Ops: {} } }).success).toBe(true);
  });

  it("rejects a legacy marker with explicit ownership", () => {
    expect(
      AgentsSchema.safeParse({
        ownership: "explicit",
        entries: { alpha: { default: true }, beta: {} },
      }).success,
    ).toBe(false);
  });
});

describe("explicit ambient agent targets", () => {
  it.each([
    {
      agents: {
        defaults: { heartbeat: { agentId: "missing" } },
        entries: { main: {} },
      },
    },
    {
      agents: {
        defaults: { systemAgent: { agentId: "missing" } },
        entries: { main: {} },
      },
    },
    { agents: { entries: { main: {} } }, talk: { agentId: "missing" } },
  ])("rejects an unknown explicit target", (target) => {
    const result = OpenClawSchema.safeParse(target);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("Unknown agent id");
    }
  });

  it("accepts configured heartbeat, system-agent, compatibility, and Talk targets", () => {
    expect(
      OpenClawSchema.safeParse({
        agents: {
          defaults: {
            heartbeat: { agentId: "ops" },
            systemAgent: { agentId: "ops" },
            authInheritance: { agentId: "ops" },
            sessionStore: { agentId: "ops" },
          },
          entries: { ops: {} },
        },
        talk: { agentId: "ops" },
      }).success,
    ).toBe(true);
  });

  it.each([
    {
      agents: {
        defaults: { heartbeat: { agentId: " " } },
        entries: { main: {} },
      },
    },
    {
      agents: {
        defaults: { systemAgent: { agentId: " " } },
        entries: { main: {} },
      },
    },
    {
      agents: {
        defaults: { authInheritance: { agentId: " " } },
        entries: { main: {} },
      },
    },
    {
      agents: {
        defaults: { sessionStore: { agentId: " " } },
        entries: { main: {} },
      },
    },
    { agents: { entries: { main: {} } }, talk: { agentId: " " } },
  ])("rejects blank explicit targets", (config) => {
    expect(OpenClawSchema.safeParse(config).success).toBe(false);
  });

  it("validates targets against the implicit main roster", () => {
    expect(OpenClawSchema.safeParse({ talk: { agentId: "main" } }).success).toBe(true);
    expect(OpenClawSchema.safeParse({ talk: { agentId: "missing" } }).success).toBe(false);
  });

  it("allows upgrade compatibility owners to outlive their roster entries", () => {
    expect(
      OpenClawSchema.safeParse({
        agents: {
          ownership: "explicit",
          defaults: {
            authInheritance: { agentId: "retired-ops" },
            sessionStore: { agentId: "retired-ops" },
          },
          entries: { research: {}, writer: {} },
        },
      }).success,
    ).toBe(true);
  });
});
