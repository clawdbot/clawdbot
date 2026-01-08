import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../config/config.js";
import { createClawdbotCodingTools } from "./pi-tools.js";
import type { SandboxDockerConfig } from "./sandbox.js";

describe("Agent-specific tool filtering", () => {
  it("should apply global tool policy when no agent-specific policy exists", () => {
    const cfg: ClawdbotConfig = {
      agent: {
        tools: {
          allow: ["read", "write"],
          deny: ["bash"],
        },
      },
      routing: {
        agents: {
          main: {
            workspace: "~/clawd",
          },
        },
      },
    };

    const tools = createClawdbotCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
      agentDir: "/tmp/agent",
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("write");
    expect(toolNames).not.toContain("bash");
  });

  it("should apply agent-specific tool policy", () => {
    const cfg: ClawdbotConfig = {
      agent: {
        tools: {
          allow: ["read", "write", "bash"],
          deny: [],
        },
      },
      routing: {
        agents: {
          restricted: {
            workspace: "~/clawd-restricted",
            tools: {
              allow: ["read"], // Agent override: only read
              deny: ["bash", "write", "edit"],
            },
          },
        },
      },
    };

    const tools = createClawdbotCodingTools({
      config: cfg,
      sessionKey: "agent:restricted:main",
      workspaceDir: "/tmp/test-restricted",
      agentDir: "/tmp/agent-restricted",
    });

    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).not.toContain("bash");
    expect(toolNames).not.toContain("write");
    expect(toolNames).not.toContain("edit");
  });

  it("should allow different tool policies for different agents", () => {
    const cfg: ClawdbotConfig = {
      routing: {
        agents: {
          main: {
            workspace: "~/clawd",
            // No tools restriction - all tools available
          },
          family: {
            workspace: "~/clawd-family",
            tools: {
              allow: ["read"],
              deny: ["bash", "write", "edit", "process"],
            },
          },
        },
      },
    };

    // main agent: all tools
    const mainTools = createClawdbotCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main",
      agentDir: "/tmp/agent-main",
    });
    const mainToolNames = mainTools.map((t) => t.name);
    expect(mainToolNames).toContain("bash");
    expect(mainToolNames).toContain("write");
    expect(mainToolNames).toContain("edit");

    // family agent: restricted
    const familyTools = createClawdbotCodingTools({
      config: cfg,
      sessionKey: "agent:family:whatsapp:group:123",
      workspaceDir: "/tmp/test-family",
      agentDir: "/tmp/agent-family",
    });
    const familyToolNames = familyTools.map((t) => t.name);
    expect(familyToolNames).toContain("read");
    expect(familyToolNames).not.toContain("bash");
    expect(familyToolNames).not.toContain("write");
    expect(familyToolNames).not.toContain("edit");
  });

  it("should prefer agent-specific tool policy over global", () => {
    const cfg: ClawdbotConfig = {
      agent: {
        tools: {
          deny: ["browser"], // Global deny
        },
      },
      routing: {
        agents: {
          work: {
            workspace: "~/clawd-work",
            tools: {
              deny: ["bash", "process"], // Agent deny (override)
            },
          },
        },
      },
    };

    const tools = createClawdbotCodingTools({
      config: cfg,
      sessionKey: "agent:work:slack:dm:user123",
      workspaceDir: "/tmp/test-work",
      agentDir: "/tmp/agent-work",
    });

    const toolNames = tools.map((t) => t.name);
    // Agent policy overrides global: browser is allowed again
    expect(toolNames).toContain("browser");
    expect(toolNames).not.toContain("bash");
    expect(toolNames).not.toContain("process");
  });

  it("should work with sandbox tools filtering", () => {
    const cfg: ClawdbotConfig = {
      agent: {
        sandbox: {
          mode: "all",
          scope: "agent",
          tools: {
            allow: ["read", "write", "bash"], // Sandbox allows these
            deny: [],
          },
        },
      },
      routing: {
        agents: {
          restricted: {
            workspace: "~/clawd-restricted",
            sandbox: {
              mode: "all",
              scope: "agent",
            },
            tools: {
              allow: ["read"], // Agent further restricts to only read
              deny: ["bash", "write"],
            },
          },
        },
      },
    };

    const tools = createClawdbotCodingTools({
      config: cfg,
      sessionKey: "agent:restricted:main",
      workspaceDir: "/tmp/test-restricted",
      agentDir: "/tmp/agent-restricted",
      sandbox: {
        enabled: true,
        sessionKey: "agent:restricted:main",
        workspaceDir: "/tmp/sandbox",
        agentWorkspaceDir: "/tmp/test-restricted",
        workspaceAccess: "none",
        containerName: "test-container",
        containerWorkdir: "/workspace",
        docker: {
          image: "test-image",
          containerPrefix: "test-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: [],
          network: "none",
          capDrop: [],
        } satisfies SandboxDockerConfig,
        tools: {
          allow: ["read", "write", "bash"],
          deny: [],
        },
      },
    });

    const toolNames = tools.map((t) => t.name);
    // Agent policy should be applied first, then sandbox
    // Agent allows only "read", sandbox allows ["read", "write", "bash"]
    // Result: only "read" (most restrictive wins)
    expect(toolNames).toContain("read");
    expect(toolNames).not.toContain("bash");
    expect(toolNames).not.toContain("write");
  });

  it("should run bash synchronously when process is denied", async () => {
    const cfg: ClawdbotConfig = {
      agent: {
        tools: {
          deny: ["process"],
        },
      },
    };

    const tools = createClawdbotCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test-main",
      agentDir: "/tmp/agent-main",
    });
    const bash = tools.find((tool) => tool.name === "bash");
    expect(bash).toBeDefined();

    const result = await bash?.execute("call1", {
      command: "echo done",
      yieldMs: 10,
    });

    expect(result?.details.status).toBe("completed");
  });
});
