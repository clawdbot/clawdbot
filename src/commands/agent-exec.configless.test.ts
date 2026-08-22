import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveEffectiveToolPolicy } from "../agents/agent-tools.policy.js";
import { resolveRunWorkspaceDir } from "../agents/workspace-run.js";
import { buildExecRunConfig, resolveExecBaseConfig } from "./agent-exec.js";

describe("agent exec configless workspace ownership", () => {
  it.each([
    { name: "environment-only auth", options: { authEnvOnly: true } },
    { name: "isolated mode", options: { isolated: true } },
  ])("materializes the main-agent roster for $name", async ({ options }) => {
    const config = buildExecRunConfig({
      base: await resolveExecBaseConfig(options),
      cwd: "/run/here",
    });

    expect(
      resolveRunWorkspaceDir({
        agentId: "main",
        config,
        workspaceDir: "/run/here",
      }),
    ).toMatchObject({
      agentId: "main",
      workspaceDir: resolve("/run/here"),
    });
  });

  it("adds explicitly requested one-shot tools without replacing configured additions", () => {
    const config = buildExecRunConfig({
      base: { tools: { alsoAllow: ["read"] } },
      cwd: "/run/here",
      opts: { alsoAllowTool: [" browser ", "read"] },
    });

    expect(config.tools?.alsoAllow).toEqual(["read", "browser"]);
  });

  it("extends a strict allowlist without creating an additive allowlist", () => {
    const config = buildExecRunConfig({
      base: { tools: { allow: ["read"] } },
      cwd: "/run/here",
      opts: { alsoAllowTool: [" browser ", "read"] },
    });

    expect(config.tools?.allow).toEqual(["read", "browser"]);
    expect(config.tools?.alsoAllow).toBeUndefined();
  });

  it("preserves global empty-allow additive semantics", () => {
    const config = buildExecRunConfig({
      base: { tools: { allow: [], alsoAllow: ["read"] } },
      cwd: "/run/here",
      opts: { alsoAllowTool: ["browser"] },
    });

    expect(config.tools?.allow).toEqual([]);
    expect(config.tools?.alsoAllow).toEqual(["read", "browser"]);
  });

  it.each([
    {
      name: "strict allowlist",
      tools: { allow: ["read"] },
      expectedKey: "allow" as const,
    },
    {
      name: "additive allowlist",
      tools: { alsoAllow: ["read"] },
      expectedKey: "alsoAllow" as const,
    },
  ])("extends the selected agent's $name", ({ tools, expectedKey }) => {
    const config = buildExecRunConfig({
      base: { agents: { entries: { ops: { tools } } } },
      cwd: "/run/here",
      agentId: "ops",
      opts: { alsoAllowTool: ["browser"] },
    });

    expect(config.agents?.entries?.ops?.tools?.[expectedKey]).toEqual(["read", "browser"]);
    const effective = resolveEffectiveToolPolicy({ config, agentId: "ops" });
    if (expectedKey === "allow") {
      expect(effective.agentPolicy?.allow).toContain("browser");
    } else {
      expect(effective.profileAlsoAllow).toContain("browser");
    }
  });

  it.each([
    {
      name: "strict allowlists",
      providerPolicy: { allow: ["read"] },
      expected: { allow: ["read", "browser"] },
    },
    {
      name: "additive allowlists",
      providerPolicy: { alsoAllow: ["read"] },
      expected: { alsoAllow: ["read", "browser"] },
    },
    {
      name: "profile-only policies",
      providerPolicy: { profile: "minimal" as const, deny: ["write"] },
      expected: {
        profile: "minimal" as const,
        alsoAllow: ["browser"],
        deny: ["write"],
      },
    },
  ])("composes requested tools through global and selected-agent provider $name", (fixture) => {
    const config = buildExecRunConfig({
      base: {
        tools: { byProvider: { anthropic: fixture.providerPolicy } },
        agents: {
          entries: {
            ops: { tools: { byProvider: { "anthropic/claude-opus-5": fixture.providerPolicy } } },
          },
        },
      },
      cwd: "/run/here",
      agentId: "ops",
      opts: { alsoAllowTool: ["browser"] },
    });

    expect(config.tools?.byProvider?.anthropic).toEqual(fixture.expected);
    expect(config.agents?.entries?.ops?.tools?.byProvider?.["anthropic/claude-opus-5"]).toEqual(
      fixture.expected,
    );
  });

  it("keeps provider denies authoritative over a one-shot addition", () => {
    const config = buildExecRunConfig({
      base: {
        tools: { byProvider: { anthropic: { deny: ["browser"] } } },
      },
      cwd: "/run/here",
      opts: { alsoAllowTool: ["browser"] },
    });

    expect(config.tools?.byProvider?.anthropic).toEqual({
      alsoAllow: ["browser"],
      deny: ["browser"],
    });
  });

  it("rejects empty one-shot tool names", () => {
    expect(() =>
      buildExecRunConfig({
        base: {},
        cwd: "/run/here",
        opts: { alsoAllowTool: [" "] },
      }),
    ).toThrow("--also-allow-tool requires a non-empty tool name");
  });
});
