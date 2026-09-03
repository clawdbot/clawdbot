import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  mergeRemoteNodeSkillEntries,
  removeRemoteNodeSkills,
} from "../skills/runtime/remote-skills.js";
import {
  resolveNodeCommandAllowlist,
  resolveRequiredNodeCommandAuthority,
  TALK_PTT_COMMANDS,
} from "./node-command-policy.js";
import { listConnectedNodePluginTools } from "./node-plugin-tool-snapshot.js";
import { NodeRegistry, readNodeSessionWithheldCommands } from "./node-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const registries: NodeRegistry[] = [];

afterEach(() => {
  for (const registry of registries.splice(0)) {
    for (const session of registry.listConnected()) {
      registry.unregister(session.connId);
      removeRemoteNodeSkills(session.nodeId);
    }
  }
});

function createFixture(
  initial: OpenClawConfig = {},
  pairingOptions: Pick<
    NonNullable<ConstructorParameters<typeof NodeRegistry>[0]>,
    "resolveCurrentPairingState"
  > = {},
) {
  let config = initial;
  const options = {
    ...pairingOptions,
    getConfig: () => config,
  };
  const registry = new NodeRegistry(options);
  registries.push(registry);
  const socket = { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
  const client = {
    connId: "policy-conn",
    socket,
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: GATEWAY_CLIENT_IDS.NODE_HOST,
        version: "test",
        platform: "linux",
        deviceFamily: "Linux",
        mode: "node",
      },
      device: { id: "policy-node" },
      caps: ["computer"],
      commands: ["computer.act", "system.run"],
      declaredCaps: ["computer", "screen"],
      declaredCommands: ["computer.act", "system.run", "screen.snapshot"],
    },
  } as unknown as GatewayWsClient;
  const node = registry.register(client, {
    pairingIdentity: "policy-identity",
    pairingGeneration: "policy-generation",
  });
  return {
    registry,
    node,
    client,
    socket,
    publishConfig: (next: OpenClawConfig) => {
      config = next;
    },
    reload: (next: OpenClawConfig) => {
      config = next;
      registry.refreshRuntimePolicy(next);
    },
  };
}

describe("connected node runtime policy", () => {
  it.each([
    { name: "command-only advertisement", caps: [], initiallyDenied: false },
    { name: "initially denied approved declaration", caps: [], initiallyDenied: true },
    { name: "Talk capability advertisement", caps: ["talk"], initiallyDenied: true },
  ])("restores approved Talk commands for a $name", ({ caps, initiallyDenied }) => {
    const denied: OpenClawConfig = {
      gateway: { nodes: { commands: { deny: TALK_PTT_COMMANDS } } },
    };
    const approvedCommands = ["talk.ptt.start", "talk.ptt.stop"];
    const { registry, client, socket, reload } = createFixture(initiallyDenied ? denied : {});
    Object.assign(client.connect, {
      caps: initiallyDenied ? [] : caps,
      commands: initiallyDenied ? [] : approvedCommands,
      declaredCaps: caps,
      declaredCommands: TALK_PTT_COMMANDS,
      sessionCapsCeiling: caps,
      sessionCommandsCeiling: TALK_PTT_COMMANDS,
    });
    const node = registry.register(client, {
      pairingIdentity: "policy-identity",
      pairingGeneration: "policy-generation",
      approvedSurface: { caps, commands: approvedCommands },
    });
    if (!initiallyDenied) {
      expect(node.commands).toEqual(approvedCommands);
      reload(denied);
    }
    expect(node.commands).toEqual([]);

    reload({});

    expect(node.commands).toEqual(approvedCommands);
    expect(node.caps).toEqual(caps);
    expect(node.pairingGeneration).toBe("policy-generation");
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("keeps publications and pending frames on committed policy until reconciliation", async () => {
    const { registry, node, publishConfig } = createFixture();
    let invokeId = "";
    const onProgress = vi.fn();
    const result = registry.invoke({
      nodeId: node.nodeId,
      command: "system.run",
      timeoutMs: 0,
      onProgress,
      onDispatchReady: (id) => {
        invokeId = id;
      },
    });
    expect(invokeId).not.toBe("");
    const candidate: OpenClawConfig = {
      gateway: {
        nodes: {
          commands: { deny: ["system.run"] },
          pluginTools: { enabled: false },
          allowSkills: false,
        },
      },
    };
    publishConfig(candidate);
    registry.refreshRuntimePolicy();
    registry.updateNodePluginTools(node.nodeId, node.connId, [
      {
        pluginId: "qa-policy",
        name: "node_exec",
        description: "Run on the paired node",
        command: "system.run",
      },
    ]);
    registry.updateNodeSkills(node.nodeId, node.connId, [
      {
        name: "node-work",
        description: "Work on the paired node",
        content:
          "---\nname: node-work\ndescription: Work on the paired node\n---\nUse this node.\n",
      },
    ]);

    expect(node.nodePluginTools.map((tool) => tool.name)).toEqual(["node_exec"]);
    expect(node.nodeSkills.map((skill) => skill.name)).toEqual(["node-work"]);
    registry.sendInvokeInput(invokeId, { input: "before-commit" });
    expect(
      registry.handleInvokeProgress({
        invokeId,
        nodeId: node.nodeId,
        connId: node.connId,
        seq: 0,
        chunk: "before-commit",
      }),
    ).toBe(true);
    expect(onProgress).toHaveBeenCalledWith("before-commit");

    registry.refreshRuntimePolicy(candidate);

    expect(node.nodePluginTools).toEqual([]);
    expect(node.nodeSkills).toEqual([]);
    expect(await result).toMatchObject({ ok: false, error: { code: "POLICY_CHANGED" } });
    expect(() => registry.sendInvokeInput(invokeId, { input: "after-commit" })).toThrow(
      /not pending/,
    );
  });

  it.each([false, true])(
    "cancels a revoked active command and rejects retained input (streamed=%s)",
    async (streamed) => {
      const { registry, node, reload, socket } = createFixture();
      let invokeId = "";
      const onProgress = vi.fn();
      const result = registry.invoke({
        nodeId: node.nodeId,
        command: "system.run",
        timeoutMs: 0,
        ...(streamed ? { onProgress } : {}),
        onDispatchReady: (id) => {
          invokeId = id;
        },
      });
      expect(invokeId).not.toBe("");
      registry.sendInvokeInput(invokeId, { input: "before-revocation" });

      reload({ gateway: { nodes: { commands: { deny: ["system.run"] } } } });

      expect(() => registry.sendInvokeInput(invokeId, { input: "after-revocation" })).toThrow(
        /not pending|not authorized|unavailable/,
      );
      expect(await result).toMatchObject({ ok: false, error: { code: "POLICY_CHANGED" } });
      expect(socket.send).toHaveBeenCalledWith(
        expect.stringContaining('"event":"node.invoke.cancel"'),
      );
      expect(
        registry.handleInvokeProgress({
          invokeId,
          nodeId: node.nodeId,
          connId: node.connId,
          seq: 0,
          chunk: "after-revocation",
        }),
      ).toBe(false);
      expect(onProgress).not.toHaveBeenCalled();
      expect(
        registry.handleInvokeResult({
          id: invokeId,
          nodeId: node.nodeId,
          connId: node.connId,
          ok: true,
        }),
      ).toBe(false);
      reload({});
      expect(() => registry.sendInvokeInput(invokeId, { input: "after-restoration" })).toThrow(
        /not pending/,
      );
      expect(socket.close).not.toHaveBeenCalled();
    },
  );

  it("rechecks command policy after awaited pairing work before creating a pending invocation", async () => {
    const entered = createDeferred();
    const pairing = createDeferred<{ identity: string; generation: string }>();
    const { registry, node, reload } = createFixture(
      {},
      {
        resolveCurrentPairingState: async () => {
          entered.resolve();
          return await pairing.promise;
        },
      },
    );
    const onDispatchReady = vi.fn((id: string) => {
      registry.handleInvokeResult({
        id,
        nodeId: node.nodeId,
        connId: node.connId,
        ok: false,
        error: { code: "UNEXPECTED_DISPATCH" },
      });
    });
    const result = registry.invoke({
      nodeId: node.nodeId,
      command: "system.run",
      timeoutMs: 0,
      onDispatchReady,
    });
    await entered.promise;
    reload({ gateway: { nodes: { commands: { deny: ["system.run"] } } } });
    pairing.resolve({ identity: "policy-identity", generation: "policy-generation" });

    expect(await result).toMatchObject({ ok: false, error: { code: "POLICY_CHANGED" } });
    expect(onDispatchReady).not.toHaveBeenCalled();
  });

  it("uses the authenticated approval and restores policy-withheld commands within the protocol ceiling", () => {
    const { registry, client, reload } = createFixture({
      gateway: { nodes: { commands: { deny: ["computer.act"] } } },
    });
    Object.assign(client.connect, {
      caps: [],
      commands: [],
      declaredCaps: [],
      declaredCommands: [],
      sessionCapsCeiling: ["computer"],
      sessionCommandsCeiling: ["computer.act"],
      declaredPermissions: { accessibility: true },
      permissions: { accessibility: true },
    });
    const node = registry.register(client, {
      pairingIdentity: "policy-identity",
      pairingGeneration: "policy-generation",
      approvedSurface: {
        caps: ["computer", "screen"],
        commands: ["computer.act", "screen.snapshot"],
        permissions: { accessibility: false },
      },
    });
    expect(node.commands).toEqual([]);
    expect(node.permissions).toEqual({ accessibility: false });

    reload({});
    expect(node.commands).toEqual(["computer.act"]);
    expect(node.caps).toEqual(["computer"]);
    expect(client.connect.permissions).toEqual({ accessibility: false });
  });

  it("withdraws and restores approved commands without granting an unapproved declaration", () => {
    const { node, client, socket, reload } = createFixture();
    const commandAuthority = (config: OpenClawConfig, command: string) =>
      resolveRequiredNodeCommandAuthority({
        requiredCommands: [command],
        declaredCommands: node.declaredCommands,
        effectiveCommands: node.commands,
        withheldCommands: readNodeSessionWithheldCommands(node),
        allowlist: resolveNodeCommandAllowlist(config, node),
      });
    const deniedConfig = { gateway: { nodes: { commands: { deny: ["computer.act"] } } } };
    reload(deniedConfig);

    expect(node.commands).toEqual(["system.run"]);
    expect(node.caps).toEqual([]);
    expect(client.connect.commands).toEqual(["system.run"]);
    expect(readNodeSessionWithheldCommands(node)).toContain("computer.act");
    expect(commandAuthority(deniedConfig, "computer.act")).toEqual({
      command: "computer.act",
      state: "unauthorized",
    });

    const restoredConfig = { gateway: { nodes: { commands: { allow: ["screen.snapshot"] } } } };
    reload(restoredConfig);

    expect(node.commands).toEqual(["computer.act", "system.run"]);
    expect(node.caps).toEqual(["computer"]);
    expect(readNodeSessionWithheldCommands(node)).not.toContain("computer.act");
    expect(commandAuthority(restoredConfig, "computer.act")).toEqual({
      command: "computer.act",
      state: "invocable",
    });
    expect(commandAuthority(restoredConfig, "screen.snapshot")).toEqual({
      command: "screen.snapshot",
      state: "pending-approval",
    });
    expect(node.connId).toBe("policy-conn");
    expect(node.pairingGeneration).toBe("policy-generation");
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("retains tool publication while disabled and restores only currently approved commands", () => {
    const { registry, node, reload } = createFixture({
      gateway: { nodes: { pluginTools: { enabled: false } } },
    });
    registry.updateNodePluginTools(node.nodeId, node.connId, [
      {
        pluginId: "qa-policy",
        name: "node_exec",
        description: "Run on the paired node",
        command: "system.run",
      },
      {
        pluginId: "qa-policy",
        name: "node_screen",
        description: "Unapproved screen command",
        command: "screen.snapshot",
      },
    ]);
    expect(listConnectedNodePluginTools()).toEqual([]);

    reload({});
    expect(listConnectedNodePluginTools().map((tool) => tool.descriptor.name)).toEqual([
      "node_exec",
    ]);

    reload({ gateway: { nodes: { commands: { deny: ["system.run"] } } } });
    expect(listConnectedNodePluginTools()).toEqual([]);
    reload({});
    expect(node.nodePluginTools.map((tool) => tool.name)).toEqual(["node_exec"]);

    registry.updateNodePluginTools(node.nodeId, node.connId, []);
    reload({});
    expect(listConnectedNodePluginTools()).toEqual([]);
  });

  it("restores the last bounded skill publication and withdraws it when execution is denied", () => {
    const { registry, node, reload } = createFixture({
      gateway: { nodes: { allowSkills: false } },
    });
    registry.updateNodeSkills(node.nodeId, node.connId, [
      {
        name: "node-work",
        description: "Work on the paired node",
        content:
          "---\nname: node-work\ndescription: Work on the paired node\n---\nUse this node.\n",
      },
    ]);
    expect(node.nodeSkills).toEqual([]);

    reload({});
    expect(
      mergeRemoteNodeSkillEntries([], { canExec: true }).map((entry) => entry.skill.name),
    ).toEqual(["node-work"]);

    reload({ gateway: { nodes: { commands: { deny: ["system.run"] } } } });
    expect(mergeRemoteNodeSkillEntries([], { canExec: true })).toEqual([]);
    reload({});
    expect(node.nodeSkills.map((skill) => skill.name)).toEqual(["node-work"]);

    reload({ gateway: { nodes: { allowSkills: false } } });
    expect(mergeRemoteNodeSkillEntries([], { canExec: true })).toEqual([]);
    registry.updateNodeSkills(node.nodeId, node.connId, []);
    reload({});
    expect(node.nodeSkills).toEqual([]);
  });
});
