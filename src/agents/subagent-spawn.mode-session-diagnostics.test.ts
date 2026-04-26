import os from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
import {
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";

type SubagentSpawningEvent = Parameters<SubagentLifecycleHookRunner["runSubagentSpawning"]>[0];

describe('spawnSubagentDirect mode="session" diagnostics (#67400)', () => {
  const callGatewayMock = vi.fn();
  let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
  let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;

  beforeEach(async () => {
    callGatewayMock.mockReset();
    ({ spawnSubagentDirect, resetSubagentRegistryForTests } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      loadConfig: () => createSubagentSpawnTestConfig(os.tmpdir()),
      workspaceDir: os.tmpdir(),
    }));
    resetSubagentRegistryForTests();
  });

  it("names usable alternatives before a thread retry", async () => {
    const result = await spawnSubagentDirect(
      {
        task: "persistent planning session",
        mode: "session",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "webchat",
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("thread: true");
      expect(result.error).toContain('mode="run"');
      expect(result.error).toContain("sessions_send");
    }
  });

  it("rejects thread=true with actionable guidance when no hook is registered", async () => {
    const result = await spawnSubagentDirect(
      {
        task: "persistent planning session",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "webchat",
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("not running on a channel");
      expect(result.error).toContain('mode="run"');
      expect(result.error).toContain("sessions_send");
    }
  });
});

describe('spawnSubagentDirect mode="session" with registered thread hooks (#67400)', () => {
  const callGatewayMock = vi.fn();
  let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
  let resetSubagentRegistryForTests: typeof import("./subagent-registry.js").resetSubagentRegistryForTests;

  beforeEach(async () => {
    callGatewayMock.mockReset();
    ({ spawnSubagentDirect, resetSubagentRegistryForTests } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      loadConfig: () => createSubagentSpawnTestConfig(os.tmpdir()),
      workspaceDir: os.tmpdir(),
      hookRunner: {
        hasHooks: () => true,
        runSubagentSpawning: async (event: SubagentSpawningEvent) => {
          const requesterChannel = event.requester?.channel;
          if (requesterChannel !== "discord") {
            return undefined;
          }
          return {
            status: "ok" as const,
            threadBindingReady: true,
          };
        },
      },
    }));
    resetSubagentRegistryForTests();
  });

  it("names thread=true and the non-thread alternatives when hooks are registered", async () => {
    const result = await spawnSubagentDirect(
      {
        task: "persistent planning session",
        mode: "session",
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "discord",
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("thread: true");
      expect(result.error).toContain('mode="run"');
      expect(result.error).toContain("sessions_send");
    }
  });

  it("rejects thread=true with actionable guidance when hooks do not bind the requester channel", async () => {
    const result = await spawnSubagentDirect(
      {
        task: "persistent planning session",
        mode: "session",
        thread: true,
      },
      {
        agentSessionKey: "agent:main:main",
        agentChannel: "webchat",
      },
    );

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("not running on a channel");
      expect(result.error).toContain('mode="run"');
      expect(result.error).toContain("sessions_send");
    }
  });
});
