import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { NodeRegistry } from "../node-registry.js";
import { createTerminalLaunchPolicy } from "../terminal/launch.js";
import { TerminalSessionManager } from "../terminal/session-manager.js";
import { openTerminalSession } from "./terminal.js";

beforeEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));
afterEach(() => resetPluginRuntimeStateForTest());

describe.each([
  "codex.terminal.start.v1",
  "anthropic.claude.terminal.start.v1",
  "codex.terminal.resume.v1",
  "anthropic.claude.terminal.resume.v1",
])("final node dispatch authority for %s", (command) => {
  it.each([
    "unchanged",
    "terminal disabled",
    "CLI starts disabled",
    "connection closed",
    "command removed",
    "agent sandboxed",
  ])("revalidates %s after pairing resolution", async (change) => {
    const pairing = createDeferred<{ identity: string; generation: string }>();
    const resolveCurrentPairingState = vi.fn(() => pairing.promise);
    const registry = new NodeRegistry({ resolveCurrentPairingState });
    const frames: string[] = [];
    const node = registry.register(
      {
        connId: "conn-node",
        usesSharedGatewayAuth: false,
        socket: {
          readyState: WebSocket.OPEN,
          send(frame: string) {
            frames.push(frame);
          },
        },
        connect: {
          client: { id: "openclaw-node-host", mode: "node" },
          device: { id: "node-1" },
          commands: [command],
        },
      } as never,
      { pairingIdentity: "identity-a", pairingGeneration: "generation-a" },
    );
    const config: OpenClawConfig = {
      agents: { entries: { main: {} } },
      gateway: {
        terminal: { enabled: true },
        cliAgents: { enabled: true },
        nodes: { commands: { allow: [command] } },
      },
    };
    const policy = createTerminalLaunchPolicy(config);
    const manager = new TerminalSessionManager({ emit: vi.fn() });
    const respond = vi.fn();
    const isConnectionActive = vi.fn(() => true);
    const opts = {
      client: { connId: "conn-1", connect: {} },
      respond,
      context: {
        getRuntimeConfig: () => config,
        resolveTerminalLaunchPolicy: policy.resolve,
        isTerminalEnabled: policy.isEnabled,
        nodeRegistry: registry,
        terminalSessions: manager,
        isConnectionActive,
        logGateway: { info: vi.fn() },
      },
    } as unknown as Parameters<typeof openTerminalSession>[0];
    const requireCliAgents = command.includes(".start.");
    const opening = openTerminalSession(opts, {
      agentId: "main",
      cols: 80,
      rows: 24,
      requireCliAgents,
      resolveCatalogPlan: async () => ({
        kind: "node",
        nodeId: "node-1",
        command,
        cwd: "/node/worktree",
        paramsJSON: JSON.stringify({ cwd: "/node/worktree" }),
      }),
    });
    try {
      await vi.waitFor(() => expect(resolveCurrentPairingState).toHaveBeenCalledOnce(), {
        interval: 1,
      });
      expect(frames).toEqual([]);
      if (change === "terminal disabled") {
        policy.prepareConfig(
          { ...config, gateway: { ...config.gateway, terminal: { enabled: false } } },
          { restartPending: true },
        );
      } else if (change === "CLI starts disabled") {
        config.gateway!.cliAgents!.enabled = false;
      } else if (change === "connection closed") {
        isConnectionActive.mockReturnValue(false);
      } else if (change === "command removed") {
        node.commands = [];
      } else if (change === "agent sandboxed") {
        policy.prepareConfig(
          { ...config, agents: { entries: { main: { sandbox: { mode: "all" } } } } },
          { restartPending: true },
        );
      }
      pairing.resolve({ identity: "identity-a", generation: "generation-a" });
      await opening;
      if (change === "unchanged" || (change === "CLI starts disabled" && !requireCliAgents)) {
        expect(respond).toHaveBeenCalledWith(true, expect.any(Object));
        expect(JSON.parse(frames[0] ?? "{}")).toMatchObject({
          event: "node.invoke.request",
          payload: { nodeId: "node-1", command },
        });
        expect(manager.size).toBe(1);
      } else {
        expect(frames).toEqual([]);
        expect(manager.size).toBe(0);
        expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      }
    } finally {
      pairing.resolve({ identity: "identity-a", generation: "generation-a" });
      await opening;
      manager.disposeAll();
      registry.unregister("conn-node");
    }
  });
});
