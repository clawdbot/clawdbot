import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MoltbotConfig } from "../config/config.js";

// We need to test the internal defaultSandboxConfig function, but it's not exported.
// Instead, we test the behavior through resolveSandboxContext which uses it.

type SpawnCall = {
  command: string;
  args: string[];
};

const spawnCalls: SpawnCall[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[]) => {
      spawnCalls.push({ command, args });
      const child = new EventEmitter() as {
        stdout?: Readable;
        stderr?: Readable;
        on: (event: string, cb: (...args: unknown[]) => void) => void;
      };
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });

      const dockerArgs = command === "docker" ? args : [];
      const shouldFailContainerInspect =
        dockerArgs[0] === "inspect" &&
        dockerArgs[1] === "-f" &&
        dockerArgs[2] === "{{.State.Running}}";
      const shouldSucceedImageInspect = dockerArgs[0] === "image" && dockerArgs[1] === "inspect";

      const code = shouldFailContainerInspect ? 1 : 0;
      if (shouldSucceedImageInspect) {
        queueMicrotask(() => child.emit("close", 0));
      } else {
        queueMicrotask(() => child.emit("close", code));
      }
      return child;
    },
  };
});

vi.mock("../skills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../skills.js")>();
  return {
    ...actual,
    syncSkillsToWorkspace: vi.fn(async () => undefined),
  };
});
describe("Agent-specific sandbox config", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it("should allow agent-specific docker settings beyond setupCommand", async () => {
    const { resolveSandboxContext } = await import("./sandbox.js");

    const cfg: MoltbotConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "agent",
            docker: {
              image: "global-image",
              network: "none",
            },
          },
        },
        list: [
          {
            id: "work",
            workspace: "~/clawd-work",
            sandbox: {
              mode: "all",
              scope: "agent",
              docker: {
                image: "work-image",
                network: "bridge",
              },
            },
          },
        ],
      },
    };

    const context = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:work:main",
      workspaceDir: "/tmp/test-work",
    });

    expect(context).toBeDefined();
    expect(context?.docker.image).toBe("work-image");
    expect(context?.docker.network).toBe("bridge");
  });
  it("should override with agent-specific sandbox mode 'off'", async () => {
    const { resolveSandboxContext } = await import("./sandbox.js");

    const cfg: MoltbotConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all", // Global default
            scope: "agent",
          },
        },
        list: [
          {
            id: "main",
            workspace: "~/clawd",
            sandbox: {
              mode: "off", // Agent override
            },
          },
        ],
      },
    };

    const context = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/test",
    });

    // Should be null because mode is "off"
    expect(context).toBeNull();
  });
  it("should use agent-specific sandbox mode 'all'", async () => {
    const { resolveSandboxContext } = await import("./sandbox.js");

    const cfg: MoltbotConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "off", // Global default
          },
        },
        list: [
          {
            id: "family",
            workspace: "~/clawd-family",
            sandbox: {
              mode: "all", // Agent override
              scope: "agent",
            },
          },
        ],
      },
    };

    const context = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:family:whatsapp:group:123",
      workspaceDir: "/tmp/test-family",
    });

    expect(context).toBeDefined();
    expect(context?.enabled).toBe(true);
  });
  it("should use agent-specific scope", async () => {
    const { resolveSandboxContext } = await import("./sandbox.js");

    const cfg: MoltbotConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "session", // Global default
          },
        },
        list: [
          {
            id: "work",
            workspace: "~/clawd-work",
            sandbox: {
              mode: "all",
              scope: "agent", // Agent override
            },
          },
        ],
      },
    };

    const context = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:work:slack:channel:456",
      workspaceDir: "/tmp/test-work",
    });

    expect(context).toBeDefined();
    // The container name should use agent scope (agent:work)
    expect(context?.containerName).toContain("agent-work");
  });
});
