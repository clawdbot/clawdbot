import { describe, expect, it } from "vitest";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import { buildCronAgentDefaultsConfig } from "./run-config.js";

function makeCfg() {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all" as const,
          workspaceAccess: "rw" as const,
          docker: {
            network: "none",
            dangerouslyAllowContainerNamespaceJoin: true,
            dangerouslyAllowExternalBindSources: true,
          },
          browser: {
            enabled: true,
            autoStart: false,
          },
          prune: {
            maxAgeDays: 7,
          },
        },
      },
    },
  };
}

function buildRunCfg(agentId: string, agentConfigOverride?: Record<string, unknown>) {
  const cfg = makeCfg();
  const agentDefaults = buildCronAgentDefaultsConfig({
    defaults: cfg.agents.defaults,
    agentConfigOverride: agentConfigOverride as never,
  });
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: agentDefaults,
      list: [{ id: agentId, ...agentConfigOverride }],
    },
  };
}

function expectDefaultSandboxPreserved(
  runCfg:
    | {
        agents?: { defaults?: { sandbox?: unknown } };
      }
    | undefined,
) {
  expect(runCfg?.agents?.defaults?.sandbox).toEqual({
    mode: "all",
    workspaceAccess: "rw",
    docker: {
      network: "none",
      dangerouslyAllowContainerNamespaceJoin: true,
      dangerouslyAllowExternalBindSources: true,
    },
    browser: {
      enabled: true,
      autoStart: false,
    },
    prune: {
      maxAgeDays: 7,
    },
  });
}

describe("runCronIsolatedAgentTurn sandbox config preserved", () => {
  it("preserves default sandbox config when agent entry omits sandbox", () => {
    const runCfg = buildRunCfg("worker", {
      name: "worker",
      workspace: "/tmp/custom-workspace",
      sandbox: undefined,
      heartbeat: undefined,
      tools: undefined,
    });
    expectDefaultSandboxPreserved(runCfg);
    const resolvedSandbox = resolveSandboxConfigForAgent(runCfg, "worker");
    expect(resolvedSandbox.mode).toBe("all");
    expect(resolvedSandbox.workspaceAccess).toBe("rw");
  });

  it("keeps global sandbox defaults when agent override is partial", () => {
    const runCfg = buildRunCfg("specialist", {
      sandbox: {
        docker: {
          image: "ghcr.io/openclaw/sandbox:custom",
        },
        browser: {
          image: "ghcr.io/openclaw/browser:custom",
        },
        prune: {
          idleHours: 1,
        },
      },
    });
    const resolvedSandbox = resolveSandboxConfigForAgent(runCfg, "specialist");

    expectDefaultSandboxPreserved(runCfg);
    expect(resolvedSandbox.mode).toBe("all");
    expect(resolvedSandbox.workspaceAccess).toBe("rw");
    expect(resolvedSandbox.docker.image).toBe("ghcr.io/openclaw/sandbox:custom");
    expect(resolvedSandbox.docker.network).toBe("none");
    expect(resolvedSandbox.docker.dangerouslyAllowContainerNamespaceJoin).toBe(true);
    expect(resolvedSandbox.docker.dangerouslyAllowExternalBindSources).toBe(true);
    expect(resolvedSandbox.browser.enabled).toBe(true);
    expect(resolvedSandbox.browser.image).toBe("ghcr.io/openclaw/browser:custom");
    expect(resolvedSandbox.browser.autoStart).toBe(false);
    expect(resolvedSandbox.prune.idleHours).toBe(1);
    expect(resolvedSandbox.prune.maxAgeDays).toBe(7);
  });
});
