import { EventEmitter } from "node:events";
import path from "node:path";
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
    vi.resetModules();
  });

  it("should use agent-specific workspaceRoot", async () => {
    const { resolveSandboxContext } = await import("./sandbox.js");

    const cfg: MoltbotConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "agent",
            workspaceRoot: "~/.clawdbot/sandboxes", // Global default
          },
        },
        list: [
          {
            id: "isolated",
            workspace: "~/clawd-isolated",
            sandbox: {
              mode: "all",
              scope: "agent",
              workspaceRoot: "/tmp/isolated-sandboxes", // Agent override
            },
          },
        ],
      },
    };

    const context = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:isolated:main",
      workspaceDir: "/tmp/test-isolated",
    });

    expect(context).toBeDefined();
    expect(context?.workspaceDir).toContain(path.resolve("/tmp/isolated-sandboxes"));
  });
  it("should prefer agent config over global for multiple agents", async () => {
    const { resolveSandboxContext } = await import("./sandbox.js");

    const cfg: MoltbotConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "non-main",
            scope: "session",
          },
        },
        list: [
          {
            id: "main",
            workspace: "~/clawd",
            sandbox: {
              mode: "off", // main: no sandbox
            },
          },
          {
            id: "family",
            workspace: "~/clawd-family",
            sandbox: {
              mode: "all", // family: always sandbox
              scope: "agent",
            },
          },
        ],
      },
    };

    // main agent should not be sandboxed
    const mainContext = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:main:telegram:group:789",
      workspaceDir: "/tmp/test-main",
    });
    expect(mainContext).toBeNull();

    // family agent should be sandboxed
    const familyContext = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:family:whatsapp:group:123",
      workspaceDir: "/tmp/test-family",
    });
    expect(familyContext).toBeDefined();
    expect(familyContext?.enabled).toBe(true);
  });
  it("should prefer agent-specific sandbox tool policy", async () => {
    const { resolveSandboxContext } = await import("./sandbox.js");

    const cfg: MoltbotConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "agent",
          },
        },
        list: [
          {
            id: "restricted",
            workspace: "~/clawd-restricted",
            sandbox: {
              mode: "all",
              scope: "agent",
            },
            tools: {
              sandbox: {
                tools: {
                  allow: ["read", "write"],
                  deny: ["edit"],
                },
              },
            },
          },
        ],
      },
      tools: {
        sandbox: {
          tools: {
            allow: ["read"],
            deny: ["exec"],
          },
        },
      },
    };

    const context = await resolveSandboxContext({
      config: cfg,
      sessionKey: "agent:restricted:main",
      workspaceDir: "/tmp/test-restricted",
    });

    expect(context).toBeDefined();
    expect(context?.tools).toEqual({
      allow: ["read", "write", "image"],
      deny: ["edit"],
    });
  });
});
