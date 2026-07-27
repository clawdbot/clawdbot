// Verifies agent-specific sandbox config, workspace roots, and Docker setup commands.
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createRestrictedAgentSandboxConfig } from "./test-helpers/sandbox-agent-config-fixtures.js";

type SpawnCall = {
  command: string;
  args: string[];
};

const spawnCalls = vi.hoisted(() => [] as SpawnCall[]);

async function spawnDockerProcess(commandAndArgs: string[]) {
  const [command = "", ...args] = commandAndArgs;
  spawnCalls.push({ command, args });
  const shouldFailContainerInspect =
    command === "docker" &&
    args[0] === "inspect" &&
    args[1] === "-f" &&
    args[2] === "{{.State.Running}}";
  const code = command === "docker" && !shouldFailContainerInspect ? 0 : 1;
  return {
    failed: code !== 0,
    isCanceled: false,
    exitCode: code,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(code === 0 ? "" : "No such container"),
  };
}

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  spawnCommand: spawnDockerProcess,
}));

vi.mock("../skills/loading/workspace.js", () => ({
  syncSkillsToWorkspace: vi.fn(async () => undefined),
}));

let resolveSandboxContext: typeof import("./sandbox/context.js").resolveSandboxContext;
let resolveSandboxConfigForAgent: typeof import("./sandbox/config.js").resolveSandboxConfigForAgent;
let resolveSandboxRuntimeStatus: typeof import("./sandbox/runtime-status.js").resolveSandboxRuntimeStatus;

async function resolveContext(config: OpenClawConfig, sessionKey: string, workspaceDir: string) {
  // Convenience wrapper keeps session-key specific sandbox context assertions compact.
  return resolveSandboxContext({
    config,
    sessionKey,
    workspaceDir,
  });
}

function expectDockerSetupCommand(command: string) {
  // Setup commands are executed through docker exec in the resolved container.
  const matched = spawnCalls.some(
    (call) =>
      call.command === "docker" &&
      call.args[0] === "exec" &&
      call.args.includes("-lc") &&
      call.args.includes(command),
  );
  expect(matched, `expected docker setup command; calls=${JSON.stringify(spawnCalls)}`).toBe(true);
}

function createDefaultsSandboxConfig(
  scope: "agent" | "shared" | "session" = "agent",
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          scope,
        },
      },
    },
  };
}

function createWorkSetupCommandConfig(scope: "agent" | "shared"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          scope,
          docker: {
            setupCommand: "echo global",
          },
        },
      },
      list: [
        {
          id: "work",
          workspace: "~/openclaw-work",
          sandbox: {
            mode: "all",
            scope,
            docker: {
              setupCommand: "echo work",
            },
          },
        },
      ],
    },
  };
}

describe("Agent-specific sandbox config", () => {
  beforeEach(async () => {
    vi.resetModules();
    const [configModule, contextModule, runtimeModule] = await Promise.all([
      import("./sandbox/config.js"),
      import("./sandbox/context.js"),
      import("./sandbox/runtime-status.js"),
    ]);
    ({ resolveSandboxConfigForAgent } = configModule);
    ({ resolveSandboxContext } = contextModule);
    ({ resolveSandboxRuntimeStatus } = runtimeModule);
    spawnCalls.length = 0;
  });

  it("should use agent-specific workspaceRoot", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "agent",
            workspaceRoot: "~/.openclaw/sandboxes",
          },
        },
        list: [
          {
            id: "isolated",
            workspace: "~/openclaw-isolated",
            sandbox: {
              mode: "all",
              scope: "agent",
              workspaceRoot: "/tmp/isolated-sandboxes",
            },
          },
        ],
      },
    };

    const context = await resolveContext(cfg, "agent:isolated:main", "/tmp/test-isolated");

    if (!context) {
      throw new Error("Expected sandbox context for isolated agent");
    }
    expect(context.workspaceDir).toContain(path.resolve("/tmp/isolated-sandboxes"));
  });

  it("should prefer agent config over global for multiple agents", () => {
    const cfg: OpenClawConfig = {
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
            workspace: "~/openclaw",
            sandbox: {
              mode: "off",
            },
          },
          {
            id: "family",
            workspace: "~/openclaw-family",
            sandbox: {
              mode: "all",
              scope: "agent",
            },
          },
        ],
      },
    };

    const mainRuntime = resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: "agent:main:telegram:group:789",
    });
    expect(mainRuntime.mode).toBe("off");
    expect(mainRuntime.sandboxed).toBe(false);

    const familyRuntime = resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: "agent:family:whatsapp:group:123",
    });
    expect(familyRuntime.mode).toBe("all");
    expect(familyRuntime.sandboxed).toBe(true);
  });

  it("should prefer agent-specific sandbox tool policy", () => {
    const cfg = createRestrictedAgentSandboxConfig({
      agentTools: {
        sandbox: {
          tools: {
            allow: ["read", "write"],
            deny: ["edit"],
          },
        },
      },
      globalSandboxTools: {
        allow: ["read"],
        deny: ["exec"],
      },
    });

    const sandbox = resolveSandboxConfigForAgent(cfg, "restricted");
    expect(sandbox.tools).toEqual({
      allow: ["read", "write", "image"],
      deny: ["edit"],
    });
  });

  it("should use global sandbox config when no agent-specific config exists", () => {
    const cfg: OpenClawConfig = {
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
            workspace: "~/openclaw",
          },
        ],
      },
    };

    const sandbox = resolveSandboxConfigForAgent(cfg, "main");
    expect(sandbox.mode).toBe("all");
  });

  it.each([
    {
      scope: "agent" as const,
      expectedSetup: "echo work",
      expectedContainerFragment: "agent-work",
    },
    {
      scope: "shared" as const,
      expectedSetup: "echo global",
      expectedContainerFragment: "shared",
    },
  ])(
    "should resolve $scope setupCommand overrides",
    async ({ scope, expectedSetup, expectedContainerFragment }) => {
      const cfg = createWorkSetupCommandConfig(scope);
      const context = await resolveContext(cfg, "agent:work:main", "/tmp/test-work");

      if (!context) {
        throw new Error(`Expected sandbox context for ${scope} scoped setup`);
      }
      expect(context.docker?.setupCommand).toBe(expectedSetup);
      expect(context.containerName).toContain(expectedContainerFragment);
      expectDockerSetupCommand(expectedSetup);
    },
  );

  it("should allow agent-specific docker settings beyond setupCommand", () => {
    const cfg: OpenClawConfig = {
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
            workspace: "~/openclaw-work",
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

    const sandbox = resolveSandboxConfigForAgent(cfg, "work");
    expect(sandbox.docker.image).toBe("work-image");
    expect(sandbox.docker.network).toBe("bridge");
  });

  it("should honor agent-specific sandbox mode overrides", () => {
    for (const scenario of [
      {
        cfg: {
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
                workspace: "~/openclaw",
                sandbox: {
                  mode: "off",
                },
              },
            ],
          },
        } satisfies OpenClawConfig,
        sessionKey: "agent:main:main",
        assert: (runtime: ReturnType<typeof resolveSandboxRuntimeStatus>) => {
          expect(runtime.mode).toBe("off");
          expect(runtime.sandboxed).toBe(false);
        },
      },
      {
        cfg: {
          agents: {
            defaults: {
              sandbox: {
                mode: "off",
              },
            },
            list: [
              {
                id: "family",
                workspace: "~/openclaw-family",
                sandbox: {
                  mode: "all",
                  scope: "agent",
                },
              },
            ],
          },
        } satisfies OpenClawConfig,
        sessionKey: "agent:family:whatsapp:group:123",
        assert: (runtime: ReturnType<typeof resolveSandboxRuntimeStatus>) => {
          expect(runtime.mode).toBe("all");
          expect(runtime.sandboxed).toBe(true);
        },
      },
    ]) {
      const runtime = resolveSandboxRuntimeStatus({
        cfg: scenario.cfg,
        sessionKey: scenario.sessionKey,
      });
      scenario.assert(runtime);
    }
  });

  it("should use agent-specific scope", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "session",
          },
        },
        list: [
          {
            id: "work",
            workspace: "~/openclaw-work",
            sandbox: {
              mode: "all",
              scope: "agent",
            },
          },
        ],
      },
    };

    const sandbox = resolveSandboxConfigForAgent(cfg, "work");
    expect(sandbox.scope).toBe("agent");
  });

  it("enforces required allowlist tools in default and explicit sandbox configs", () => {
    for (const scenario of [
      {
        cfg: createDefaultsSandboxConfig(),
        expected: ["session_status", "image"],
      },
      {
        cfg: {
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
        } satisfies OpenClawConfig,
        expected: ["image"],
      },
    ]) {
      const sandbox = resolveSandboxConfigForAgent(scenario.cfg, "main");
      for (const tool of scenario.expected) {
        expect(sandbox.tools.allow).toContain(tool);
      }
    }
  });
});
