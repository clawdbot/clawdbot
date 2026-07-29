// Coverage for sessions_spawn workspace inheritance from sandbox context.
import { describe, expect, it } from "vitest";
import { createAgentToolsSandboxContext } from "../../test-helpers/agent-tools-sandbox-context.js";
import { resolveAttemptSpawnWorkspaceDir } from "./attempt.thread-helpers.js";

describe("runEmbeddedAttempt sessions_spawn workspace inheritance", () => {
  it("passes the real workspace to sessions_spawn when workspaceAccess is ro", () => {
    // Read-only sandbox copies should not become the child session workspace;
    // spawned sessions need the canonical real workspace.
    const realWorkspace = "/tmp/openclaw-real-workspace";
    const sandboxWorkspace = "/tmp/openclaw-sandbox-workspace";
    const sandbox = createAgentToolsSandboxContext({
      workspaceDir: sandboxWorkspace,
      agentWorkspaceDir: realWorkspace,
      workspaceAccess: "ro",
      tools: { allow: ["sessions_spawn"], deny: [] },
      sessionKey: "agent:main:main",
    });

    expect(
      resolveAttemptSpawnWorkspaceDir({
        sandbox,
        resolvedWorkspace: realWorkspace,
      }),
    ).toBe(realWorkspace);
  });

  it("does not override spawned workspace when sandbox workspace is rw", () => {
    const realWorkspace = "/tmp/openclaw-real-workspace";
    const sandbox = createAgentToolsSandboxContext({
      workspaceDir: realWorkspace,
      agentWorkspaceDir: realWorkspace,
      workspaceAccess: "rw",
      tools: { allow: ["sessions_spawn"], deny: [] },
      sessionKey: "agent:main:main",
    });

    expect(
      resolveAttemptSpawnWorkspaceDir({
        sandbox,
        resolvedWorkspace: realWorkspace,
      }),
    ).toBeUndefined();
  });
});
