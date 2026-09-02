import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { NodeHostClient } from "./client.js";
import { startNodeHostConnection } from "./connection.js";
import { startNodeHostMcpManager } from "./mcp.js";
import { resetNodeHostPluginRegistry } from "./plugin-node-host.test-support.js";
import { prepareNodeHostRuntime } from "./runtime.js";
import { scanNodeHostedSkills } from "./skills.js";

vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));
vi.mock("./mcp.js", () => ({ startNodeHostMcpManager: vi.fn() }));
vi.mock("./skills.js", () => ({ scanNodeHostedSkills: vi.fn() }));
vi.mock("../plugins/loader.js", () => ({
  loadPluginRegistryHandle: () => getActivePluginRegistry(),
}));

const hiddenPrepare = vi.fn();
const hiddenWatch = vi.fn();
const read = vi.fn(async () => JSON.stringify({ items: [] }));

beforeEach(() => {
  vi.clearAllMocks();
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "fixture", enabled: true, status: "loaded" }));
  registry.nodeHostCommands = [
    ...["fixture.list", "fixture.read"].map((command) => ({
      pluginId: "fixture",
      source: "test",
      command: {
        command,
        cap: "fixture-catalog",
        handle: read,
        agentTool: { name: "fixture_read", description: "Read fixture catalog" },
      },
    })),
    {
      pluginId: "fixture",
      source: "test",
      command: {
        command: "computer.act",
        cap: "computer",
        handle: read,
        prepare: hiddenPrepare,
        watchAvailability: hiddenWatch,
        computerUse: () => ({
          contractVersion: 2,
          provider: { id: "fixture", label: "Fixture", generation: "1" },
          actions: ["type"],
          targets: ["screen"],
          deliveryModes: ["foreground"],
          observations: ["image"],
          features: { recording: false, agentCursor: false, multiDisplay: false },
        }),
      },
    },
  ];
  setActivePluginRegistry(registry);
});

afterEach(() => {
  resetNodeHostPluginRegistry();
  resetPluginRuntimeStateForTest();
});

describe("restricted node command surface", () => {
  it("publishes only selected commands and rejects hidden invokes without starting ancillary services", async () => {
    const prepared = await prepareNodeHostRuntime({
      config: { nodeHost: { workerRuns: { enabled: true } }, desktop: { host: { enabled: true } } },
      env: { PATH: "/private/host/bin" },
      enableAgentRuns: true,
      enableWorkerRuns: true,
      forceWorkerRuns: true,
      installedAppsSharingEnabled: true,
      platform: "darwin",
      commands: ["fixture.read", "fixture.list", "missing.command"],
    });
    expect(prepared.manifest).toEqual({
      caps: ["fixture-catalog"],
      commands: ["fixture.list", "fixture.read"],
    });
    expect(prepared.workerHostingEnabled).toBe(false);
    expect(prepared.initialInventory).toEqual({ skills: null, pluginTools: [] });
    const request = vi.fn(async () => ({}));
    const connection = startNodeHostConnection({
      prepared,
      client: { request } as unknown as NodeHostClient,
      onManifestChanged: vi.fn(),
      writeStderrLine: vi.fn(),
    });
    try {
      connection.connect({ url: "ws://127.0.0.1:19999", protocol: 4, capabilities: [] });
      expect(request).not.toHaveBeenCalled();
      expect(startNodeHostMcpManager).not.toHaveBeenCalled();
      expect(scanNodeHostedSkills).not.toHaveBeenCalled();
      expect(hiddenPrepare).not.toHaveBeenCalled();
      expect(hiddenWatch).not.toHaveBeenCalled();
      for (const command of [
        "system.run",
        "fs.listDir",
        "terminal.upload",
        "mcp.tools.call.v1",
        "computer.act",
        "worker.launch.v1",
        "fixture.read",
      ]) {
        await connection.invoke({ id: command, nodeId: "node", command });
        expect(request).toHaveBeenLastCalledWith(
          "node.invoke.result",
          expect.objectContaining({
            id: command,
            ok: command === "fixture.read",
            ...(command === "fixture.read"
              ? { payloadJSON: '{"items":[]}' }
              : { error: { code: "UNAVAILABLE", message: "command not advertised by this node" } }),
          }),
        );
      }
      expect(read).toHaveBeenCalledOnce();
    } finally {
      await connection.close();
    }
  });

  it("recomputes builtin capabilities without retaining unrelated families", async () => {
    const prepared = await prepareNodeHostRuntime({
      config: {},
      commands: ["system.which", "fixture.read"],
    });
    expect(prepared.manifest).toEqual({
      commands: ["fixture.read", "system.which"],
      caps: ["fixture-catalog", "system"],
    });
  });

  it.each([{ commands: [] }, { commands: ["missing.command"] }])(
    "fails startup when no requested command is available: $commands",
    async ({ commands }) => {
      await expect(prepareNodeHostRuntime({ config: {}, commands })).rejects.toThrow(
        commands.length ? "missing.command" : "empty allowlist",
      );
    },
  );
});
