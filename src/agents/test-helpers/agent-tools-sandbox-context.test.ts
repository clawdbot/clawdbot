import { describe, expect, it } from "vitest";
import { createAgentToolsSandboxContext } from "./agent-tools-sandbox-context.js";

describe("createAgentToolsSandboxContext", () => {
  it("provides stable defaults for agent-tools sandbox tests", () => {
    const sandbox = createAgentToolsSandboxContext({
      workspaceDir: "/tmp/sandbox",
    });

    expect(sandbox.enabled).toBe(true);
    expect(sandbox.sessionKey).toBe("sandbox:test");
    expect(sandbox.workspaceDir).toBe("/tmp/sandbox");
    expect(sandbox.agentWorkspaceDir).toBe("/tmp/sandbox");
    expect(sandbox.workspaceAccess).toBe("rw");
    expect(sandbox.containerName).toBe("openclaw-sbx-test");
    expect(sandbox.containerWorkdir).toBe("/workspace");
    expect(sandbox.docker.image).toBe("openclaw-sandbox:bookworm-slim");
    expect(sandbox.docker.containerPrefix).toBe("openclaw-sbx-");
    expect(sandbox.tools).toEqual({ allow: [], deny: [] });
    expect(sandbox.browserAllowHostControl).toBe(false);
  });

  it("applies provided overrides", () => {
    const sandbox = createAgentToolsSandboxContext({
      workspaceDir: "/tmp/sandbox",
      agentWorkspaceDir: "/tmp/workspace",
      workspaceAccess: "ro",
      tools: { allow: ["read"], deny: ["exec"] },
      browserAllowHostControl: true,
      dockerOverrides: {
        readOnlyRoot: false,
        tmpfs: ["/tmp"],
      },
    });

    expect(sandbox.agentWorkspaceDir).toBe("/tmp/workspace");
    expect(sandbox.workspaceAccess).toBe("ro");
    expect(sandbox.tools).toEqual({ allow: ["read"], deny: ["exec"] });
    expect(sandbox.browserAllowHostControl).toBe(true);
    expect(sandbox.docker.readOnlyRoot).toBe(false);
    expect(sandbox.docker.tmpfs).toEqual(["/tmp"]);
  });
});
