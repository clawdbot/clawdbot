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

describe("Agent-specific sandbox config", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
  });

  it(
    "should use global sandbox config when no agent-specific config exists",
    { timeout: 60_000 },
    async () => {
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
              id: "main",
              workspace: "~/clawd",
            },
          ],
        },
      };

      const context = await resolveSandboxContext({
        config: cfg,
        sessionKey: "agent:main:main",
        workspaceDir: "/tmp/test",
      });

      expect(context).toBeDefined();
      expect(context?.enabled).toBe(true);
    },
  );
  it("should allow agent-specific docker setupCommand overrides", async () => {
    const { resolveSandboxContext } = await import("./sandbox.js");

    const cfg: MoltbotConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "agent",
            docker: {
              setupCommand: "echo global",
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
                setupCommand: "echo work",
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
    expect(context?.docker.setupCommand).toBe("echo work");
    expect(
      spawnCalls.some(
        (call) =>
          call.command === "docker" &&
          call.args[0] === "exec" &&
          call.args.includes("-lc") &&
          call.args.includes("echo work"),
      ),
    ).toBe(true);
  });
  it("should ignore agent-specific docker overrides when scope is shared", async () => {
    const { resolveSandboxContext } = await import("./sandbox.js");

    const cfg: MoltbotConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "shared",
            docker: {
              setupCommand: "echo global",
            },
          },
        },
        list: [
          {
            id: "work",
            workspace: "~/clawd-work",
            sandbox: {
              mode: "all",
              scope: "shared",
              docker: {
                setupCommand: "echo work",
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
    expect(context?.docker.setupCommand).toBe("echo global");
    expect(context?.containerName).toContain("shared");
    expect(
      spawnCalls.some(
        (call) =>
          call.command === "docker" &&
          call.args[0] === "exec" &&
          call.args.includes("-lc") &&
          call.args.includes("echo global"),
      ),
    ).toBe(true);
  });
});
