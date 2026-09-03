import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { WebSocket } from "ws";
import type { QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { rawDataToString } from "../../../../packages/gateway-client/src/websocket-data.js";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type { NodePluginToolsUpdateParams } from "../../../../packages/gateway-protocol/src/schema/nodes.js";
import type { EffectiveToolInventoryResult } from "../../../../src/agents/tools-effective-inventory.types.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { GatewayClient, GatewayClientRequestError } from "../../../../src/gateway/client.js";
import { RfbPreauthBuffer } from "../../../../src/gateway/desktop/rfb-preauth.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import { invokeNodeDesktopStream } from "../../../../src/node-host/desktop-stream-command.js";
import { resolveNodeHostGatewayPlatformIdentity } from "../../../../src/node-host/gateway-platform-identity.js";
import {
  coerceNodeInvokeCancelPayload,
  coerceNodeInvokePayload,
} from "../../../../src/node-host/invoke-payload.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../../../../src/shared/node-desktop-stream.js";
import type { NodeListNode } from "../../../../src/shared/node-list-types.js";
import type { SkillStatusReport } from "../../../../src/skills/discovery/status.js";
import { waitForHotReloadFact } from "./gateway-config-hot-reload-fixtures.js";

const ECHO_COMMAND = "qa.hotReload.echo";
const TALK_COMMAND = "talk.ptt.start";
const TOOL_NAME = "qa_hot_reload_echo";
const SKILL_NAME = "qa-hot-reload-node";
const RFB_VERSION = Buffer.from("RFB 003.008\n", "ascii");
const RFB_MARKER = "synthetic-node-desktop-bytes";

// This peer implements only the RFB negotiation needed to prove the real node
// stream and observer transports. It never captures a desktop or accepts input.
async function startSyntheticRfbPeer(errors: unknown[]) {
  const peers = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    peers.add(socket);
    const reader = new RfbPreauthBuffer();
    socket.on("data", (chunk) => reader.push(Buffer.from(chunk)));
    socket.once("close", () => peers.delete(socket));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET" && error.code !== "EPIPE") {
        errors.push(error);
      }
    });
    void (async () => {
      const signal = AbortSignal.timeout(10_000);
      socket.write(RFB_VERSION);
      assert.deepEqual(await reader.readExactly(RFB_VERSION.length, signal), RFB_VERSION);
      socket.write(Buffer.from([1, 2]));
      assert.deepEqual(await reader.readExactly(1, signal), Buffer.from([2]));
      socket.write(Buffer.alloc(16, 7));
      await reader.readExactly(16, signal);
      socket.write(Buffer.alloc(4));
      await reader.readExactly(1, signal);
      socket.write(Buffer.from(RFB_MARKER));
    })().catch((error: unknown) => {
      if (!socket.destroyed) {
        errors.push(error);
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    port: address.port,
    peers,
    async close() {
      for (const peer of peers) {
        peer.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function openSyntheticObserver(gatewayUrl: string, wsPath: string) {
  const ws = new WebSocket(new URL(wsPath, gatewayUrl));
  let output = "";
  let greeted = false;
  const errors: unknown[] = [];
  ws.on("error", (error) => errors.push(error));
  ws.on("message", (data) => {
    output += rawDataToString(data);
    if (!greeted && output.includes(RFB_VERSION.toString("ascii"))) {
      greeted = true;
      ws.send(Buffer.concat([RFB_VERSION, Buffer.from([1, 0])]));
    }
  });
  try {
    await waitForHotReloadFact("synthetic RFB bytes through the real observer", () => {
      if (errors.length) {
        throw errors[0];
      }
      return output.includes(RFB_MARKER) ? true : undefined;
    });
    return ws;
  } catch (error) {
    ws.terminate();
    throw error;
  }
}

export async function proveHotReloadNodePolicies({
  gateway,
  rpc,
  patch,
  verifyContinuity,
  proveGroup,
  temporaryRoot,
}: {
  gateway: QaGatewayChild;
  rpc: <T>(method: string, params?: unknown) => Promise<T>;
  patch: (change: unknown, replacePaths?: string[]) => Promise<unknown>;
  verifyContinuity: (prefix: string, observation: string) => Promise<void>;
  proveGroup: (prefix: string, run: () => Promise<void>) => Promise<void>;
  temporaryRoot: string;
}) {
  assert(gateway.wsUrl, "Live Gateway must provide its WebSocket URL");
  const gatewayUrl = gateway.wsUrl;
  const originalConfig = (await rpc<{ config: OpenClawConfig }>("config.get")).config;
  const original = originalConfig.gateway?.nodes;
  const originalToolAllow = originalConfig.agents?.entries?.qa?.tools?.alsoAllow ?? [];
  const originalAllow = original?.commands?.allow ?? [];
  const originalDeny = original?.commands?.deny ?? [];
  const baseAllow = [...new Set([...originalAllow, ECHO_COMMAND])];
  const identity = loadOrCreateDeviceIdentity({
    path: path.join(temporaryRoot, "state/openclaw.sqlite"),
    identityKey: "runtime-policy-node",
  });
  let node: GatewayClient | undefined;
  let hellos = 0;
  let closes = 0;
  let bootId = "";
  const errors: unknown[] = [];
  const invocations: string[] = [];
  const cancelledInvokes = new Set<string>();
  let delayedEchoInvokeId: string | undefined;
  const streams = new Map<string, AbortController>();
  const observers = new Set<WebSocket>();
  const rfb = await startSyntheticRfbPeer(errors);
  let stopping = false;

  const commandPolicy = (allow = baseAllow, deny: string[] = []) =>
    patch(
      {
        gateway: { nodes: { commands: { allow, deny } } },
      },
      ["gateway.nodes.commands.allow", "gateway.nodes.commands.deny"],
    );
  const describe = () => rpc<NodeListNode>("node.describe", { nodeId: identity.deviceId });
  const nodeContinuity = async (prefix: string, observation: string) => {
    assert.equal(hellos, 1, "Policy changes must keep the node's original connection");
    assert.equal(closes, 0, "Policy changes must not disconnect the node");
    assert.equal((await describe()).connected, true);
    assert.equal(errors.length, 0, errors.map(String).join("\n"));
    await verifyContinuity(prefix, observation);
  };
  const echo = async () => {
    const marker = randomUUID();
    const result = await rpc<{ payload: { echo: string } }>("node.invoke", {
      nodeId: identity.deviceId,
      command: ECHO_COMMAND,
      params: { echo: marker },
      idempotencyKey: randomUUID(),
    });
    assert.equal(result.payload.echo, marker);
  };
  const toolVisible = async (sessionKey: string) => {
    const inventory = await rpc<EffectiveToolInventoryResult>("tools.effective", {
      sessionKey,
    });
    return inventory.groups.some((group) =>
      group.tools.some((tool) => tool.rawDescription.includes("QA hot reload echo")),
    );
  };
  const skillVisible = async () => {
    const report = await rpc<SkillStatusReport>("skills.status", { agentId: "qa" });
    return report.skills.some(
      (skill) => skill.name === SKILL_NAME && skill.source === "openclaw-node",
    );
  };

  try {
    await proveGroup("gateway.nodes.commands", async () => {
      await patch(
        {
          gateway: {
            nodes: {
              pairing: { autoApproveLocal: true, autoApproveCidrs: [], sshVerify: false },
              pluginTools: { enabled: false },
              allowSkills: false,
            },
          },
        },
        ["gateway.nodes.pairing.autoApproveCidrs", "gateway.nodes.pairing.sshVerify.cidrs"],
      );
      await commandPolicy(
        [...baseAllow, NODE_DESKTOP_STREAM_COMMAND],
        [NODE_DESKTOP_STREAM_COMMAND],
      );
      node = await new Promise<GatewayClient>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Synthetic policy node did not connect")),
          20_000,
        );
        const client = new GatewayClient({
          url: gatewayUrl,
          token: gateway.token,
          env: gateway.runtimeEnv,
          deviceIdentity: identity,
          role: "node",
          scopes: [],
          clientName: GATEWAY_CLIENT_IDS.NODE_HOST,
          clientDisplayName: "Hot reload policy node",
          clientVersion: "1.0.0",
          ...resolveNodeHostGatewayPlatformIdentity("linux"),
          mode: GATEWAY_CLIENT_MODES.NODE,
          caps: ["screen"],
          commands: [
            ECHO_COMMAND,
            TALK_COMMAND,
            "system.run",
            "system.which",
            NODE_DESKTOP_STREAM_COMMAND,
          ],
          onHelloOk: (hello) => {
            hellos += 1;
            bootId = hello.server.bootId ?? "";
            clearTimeout(timeout);
            resolve(client);
          },
          onConnectError: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
          onClose: () => {
            closes += 1;
          },
          onEvent: (event) => {
            if (event.event === "node.invoke.cancel") {
              const cancel = coerceNodeInvokeCancelPayload(event.payload);
              if (cancel) {
                cancelledInvokes.add(cancel.invokeId);
                streams.get(cancel.invokeId)?.abort();
              }
              return;
            }
            if (event.event !== "node.invoke.request") {
              return;
            }
            const request = coerceNodeInvokePayload(event.payload);
            if (!request) {
              errors.push(new Error("Gateway sent an invalid node invocation"));
              return;
            }
            invocations.push(request.command);
            void (async () => {
              let payload: unknown = {};
              if (request.command === NODE_DESKTOP_STREAM_COMMAND) {
                const controller = new AbortController();
                streams.set(request.id, controller);
                try {
                  await invokeNodeDesktopStream({
                    paramsJSON: request.paramsJSON,
                    gatewayUrl,
                    config: { enabled: true, port: rfb.port },
                    signal: controller.signal,
                  });
                } catch (error) {
                  if (!controller.signal.aborted) {
                    throw error;
                  }
                } finally {
                  streams.delete(request.id);
                }
              } else if (request.command === ECHO_COMMAND) {
                payload = JSON.parse(request.paramsJSON ?? "{}");
                if (
                  payload &&
                  typeof payload === "object" &&
                  "holdReply" in payload &&
                  payload.holdReply === true
                ) {
                  delayedEchoInvokeId = request.id;
                  return;
                }
              } else if (request.command === "system.which") {
                payload = { bins: {} };
              } else {
                throw new Error(`Unexpected synthetic node command: ${request.command}`);
              }
              await client.request("node.invoke.result", {
                id: request.id,
                nodeId: identity.deviceId,
                ok: true,
                payloadJSON: JSON.stringify(payload),
              });
            })().catch((error: unknown) => {
              if (!stopping) {
                errors.push(error);
              }
            });
          },
        });
        node = client;
        client.start();
      });
      assert(bootId, "Node hello must include Gateway boot identity");
      const pending = await waitForHotReloadFact("node capability pairing request", async () => {
        const pairing = await rpc<{
          pending: Array<{ nodeId: string; requestId: string; commands?: string[] }>;
        }>("node.pair.list");
        return pairing.pending.find((request) => request.nodeId === identity.deviceId);
      });
      assert(pending.commands?.includes(NODE_DESKTOP_STREAM_COMMAND));
      await rpc("node.pair.approve", { requestId: pending.requestId });
      assert((await describe()).commands?.includes(ECHO_COMMAND));
      for (const allowed of [true, false, true]) {
        await commandPolicy(allowed ? baseAllow : originalAllow);
        assert.equal((await describe()).commands?.includes(ECHO_COMMAND) ?? false, allowed);
        const before = invocations.filter((command) => command === ECHO_COMMAND).length;
        if (allowed) {
          await echo();
        } else {
          await assert.rejects(echo(), /not allowed|allowlist/);
          assert.equal(invocations.filter((command) => command === ECHO_COMMAND).length, before);
        }
      }
      for (const denied of [true, false]) {
        await commandPolicy(baseAllow, denied ? [ECHO_COMMAND] : []);
        assert.equal((await describe()).commands?.includes(ECHO_COMMAND) ?? false, !denied);
        if (denied) {
          await assert.rejects(echo(), /not allowed|allowlist/);
        } else {
          await echo();
        }
      }
      assert((await describe()).commands?.includes(TALK_COMMAND));
      await commandPolicy(baseAllow, [TALK_COMMAND]);
      assert.equal((await describe()).commands?.includes(TALK_COMMAND) ?? false, false);
      await commandPolicy();
      assert((await describe()).commands?.includes(TALK_COMMAND));
      const delayed = rpc("node.invoke", {
        nodeId: identity.deviceId,
        command: ECHO_COMMAND,
        params: { holdReply: true },
        timeoutMs: 20_000,
        idempotencyKey: randomUUID(),
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      const pendingInvokeId = await waitForHotReloadFact(
        "pending echo delivered to the real node connection",
        () => delayedEchoInvokeId,
      );
      await commandPolicy(baseAllow, [ECHO_COMMAND]);
      const revoked = await delayed;
      assert(revoked instanceof GatewayClientRequestError);
      assert.match(revoked.message, /^POLICY_CHANGED:/);
      await waitForHotReloadFact(
        "command revocation reached the node cancellation transport",
        () => (cancelledInvokes.has(pendingInvokeId) ? true : undefined),
      );
      await commandPolicy();
      const lateResult = await node.request<{ ignored?: boolean }>("node.invoke.result", {
        id: pendingInvokeId,
        nodeId: identity.deviceId,
        ok: true,
        payloadJSON: JSON.stringify({ echo: "late-after-restoration" }),
      });
      assert.equal(lateResult.ignored, true);
      await echo();
      await nodeContinuity(
        "gateway.nodes.commands",
        "The same approved synthetic node lost and regained echo and Talk commands; deny cancelled an actual pending echo invocation and kept its late result retired after restoration",
      );
    });

    await proveGroup("gateway.nodes.pluginTools.enabled", async () => {
      assert(node, "Synthetic policy node must be connected");
      await patch({
        agents: {
          entries: {
            qa: { tools: { alsoAllow: [...new Set([...originalToolAllow, TOOL_NAME])] } },
          },
        },
      });
      const session = await rpc<{ key: string }>("sessions.create", {
        key: `agent:qa:node-policy-${randomUUID()}`,
        agentId: "qa",
      });
      await commandPolicy();
      await patch({ gateway: { nodes: { pluginTools: { enabled: false } } } });
      const publication: NodePluginToolsUpdateParams = {
        tools: [
          {
            pluginId: "qa-policy",
            name: TOOL_NAME,
            description: "QA hot reload echo through the paired node",
            command: ECHO_COMMAND,
          },
        ],
      };
      await node.request("node.pluginTools.update", publication);
      for (const enabled of [false, true, false, true]) {
        await patch({ gateway: { nodes: { pluginTools: { enabled } } } });
        assert.equal(
          (await describe()).nodePluginTools?.some((tool) => tool.name === TOOL_NAME) ?? false,
          enabled,
        );
        await waitForHotReloadFact(
          "agent tool inventory follows node publication policy",
          async () => ((await toolVisible(session.key)) === enabled ? true : undefined),
        );
      }
      await node.request("node.pluginTools.update", { tools: [] });
      assert.equal((await describe()).nodePluginTools?.length ?? 0, 0);
      await nodeContinuity(
        "gateway.nodes.pluginTools.enabled",
        "A tool published while disabled appeared in the real node and agent inventories after enablement, withdrew, restored, then honored an empty publication",
      );
    });

    await proveGroup("gateway.nodes.allowSkills", async () => {
      assert(node, "Synthetic policy node must be connected");
      await commandPolicy();
      await patch({ gateway: { nodes: { allowSkills: false } } });
      await node.request("node.skills.update", {
        skills: [
          {
            name: SKILL_NAME,
            description: "QA skill on the synthetic policy node",
            content: `---\nname: ${SKILL_NAME}\ndescription: QA skill on the synthetic policy node\n---\nThis skill belongs to the synthetic node.\n`,
          },
        ],
      });
      for (const enabled of [false, true, false, true]) {
        await patch({ gateway: { nodes: { allowSkills: enabled } } });
        assert.equal(await skillVisible(), enabled);
      }
      await commandPolicy(baseAllow, ["system.run"]);
      assert.equal(await skillVisible(), false);
      await commandPolicy();
      assert.equal(await skillVisible(), true);
      await node.request("node.skills.update", { skills: [] });
      assert.equal(await skillVisible(), false);
      await nodeContinuity(
        "gateway.nodes.allowSkills",
        "A skill published while disabled appeared, withdrew and restored in skills.status without republication; system.run denial also removed it",
      );
    });

    await proveGroup("gateway.nodes.commands.desktop", async () => {
      assert(node, "Synthetic policy node must be connected");
      const observe = () =>
        rpc<{ wsPath: string }>("desktop.observe", {
          source: { kind: "node", nodeId: identity.deviceId },
          control: false,
          credentials: { password: randomUUID().slice(0, 8) },
        });
      await commandPolicy();
      await assert.rejects(observe(), /not enabled|not allowed|unavailable/);
      for (let iteration = 0; iteration < 2; iteration += 1) {
        await commandPolicy([...baseAllow, NODE_DESKTOP_STREAM_COMMAND]);
        const observed = await observe();
        const ws = await openSyntheticObserver(gatewayUrl, observed.wsPath);
        observers.add(ws);
        assert.equal(ws.readyState, WebSocket.OPEN);
        await commandPolicy(baseAllow);
        await waitForHotReloadFact("revoked desktop observer and node transport closed", () =>
          ws.readyState === WebSocket.CLOSED && rfb.peers.size === 0 && streams.size === 0
            ? true
            : undefined,
        );
        await assert.rejects(observe(), /not enabled|not allowed|unavailable/);
      }
      await nodeContinuity(
        "gateway.nodes.commands.desktop",
        "Desktop streaming enabled after Gateway startup, carried synthetic RFB bytes over real node/observer WebSockets, and closed both transports on each policy revocation",
      );
    });
  } finally {
    stopping = true;
    for (const controller of streams.values()) {
      controller.abort();
    }
    for (const observer of observers) {
      observer.terminate();
    }
    await node?.stopAndWait({ timeoutMs: 2_000 });
    await rfb.close();
    await commandPolicy(originalAllow, originalDeny);
    await patch(
      {
        agents: { entries: { qa: { tools: { alsoAllow: originalToolAllow } } } },
        gateway: {
          nodes: {
            pluginTools: { enabled: original?.pluginTools?.enabled ?? true },
            allowSkills: original?.allowSkills ?? true,
          },
        },
      },
      ["agents.entries.qa.tools.alsoAllow"],
    );
  }
}
