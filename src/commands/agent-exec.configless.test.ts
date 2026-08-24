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
});
