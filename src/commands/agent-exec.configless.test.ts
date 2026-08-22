import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
