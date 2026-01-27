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

  it("includes session_status in default sandbox allowlist", async () => {
    const { resolveSandboxConfigForAgent } = await import("./sandbox.js");

    const cfg: MoltbotConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "agent",
          },
        },
      },
    };

    const sandbox = resolveSandboxConfigForAgent(cfg, "main");
    expect(sandbox.tools.allow).toContain("session_status");
  });
  it("includes image in default sandbox allowlist", async () => {
    const { resolveSandboxConfigForAgent } = await import("./sandbox.js");

    const cfg: MoltbotConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "agent",
          },
        },
      },
    };

    const sandbox = resolveSandboxConfigForAgent(cfg, "main");
    expect(sandbox.tools.allow).toContain("image");
  });
  it("injects image into explicit sandbox allowlists", async () => {
    const { resolveSandboxConfigForAgent } = await import("./sandbox.js");

    const cfg: MoltbotConfig = {
      tools: {
        sandbox: {
          tools: {
            allow: ["bash", "read"],
            deny: [],
          },
        },
      },
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "agent",
          },
        },
      },
    };

    const sandbox = resolveSandboxConfigForAgent(cfg, "main");
    expect(sandbox.tools.allow).toContain("image");
  });
});
