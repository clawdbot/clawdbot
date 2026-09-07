import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { buildDeviceAuthPayloadV3 } from "../../../../packages/gateway-client/src/device-auth.js";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import {
  PROTOCOL_VERSION,
  type ConnectParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { DevicePairSetupCodeResult } from "../../../../packages/gateway-protocol/src/schema/devices.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../../../../src/infra/device-identity.js";
import { coerceNodeInvokePayload } from "../../../../src/node-host/invoke-payload.js";
import { decodePairingSetupCode } from "../../../../src/pairing/setup-code.js";
import type { NodeListNode, PairingList } from "../../../../src/shared/node-list-types.js";
import { waitForHotReloadFact } from "./gateway-config-hot-reload-fixtures.js";

const PREFIX = "gateway.nodes.commands.watch";
const APPROVED_COMMAND = "device.info";
const UNAPPROVED_COMMAND = "device.status";

type WatchConnection = {
  ok: boolean;
  sessionToken: string;
  deviceToken: string;
  nodeId: string;
};

export async function proveHotReloadWatchPolicy({
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
  await proveGroup(PREFIX, async () => {
    assert(gateway.baseUrl && gateway.wsUrl, "Live Gateway URLs are required");
    const baseUrl = `${gateway.baseUrl}/api/nodes/watch`;
    const original = (await rpc<{ config: OpenClawConfig }>("config.get")).config.gateway?.nodes
      ?.commands;
    const allow = [...new Set([...(original?.allow ?? []), APPROVED_COMMAND, UNAPPROVED_COMMAND])];
    const deny = (original?.deny ?? []).filter(
      (command) => command !== APPROVED_COMMAND && command !== UNAPPROVED_COMMAND,
    );
    const identity = loadOrCreateDeviceIdentity({
      path: path.join(temporaryRoot, "state/openclaw.sqlite"),
      identityKey: "runtime-policy-watch",
    });
    let connection: WatchConnection | undefined;
    let connects = 0;
    const commandPolicy = (commands: { allow: string[]; deny: string[] }) =>
      patch({ gateway: { nodes: { commands } } }, [
        "gateway.nodes.commands.allow",
        "gateway.nodes.commands.deny",
      ]);
    const request = (route: string, token?: string, body?: unknown) =>
      fetch(`${baseUrl}/${route}`, {
        method: route === "challenge" ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(25_000),
      });
    const connect = async (
      auth: { bootstrapToken: string } | { deviceToken: string },
      commands: string[],
    ) => {
      const challengeResponse = await request("challenge");
      assert.equal(challengeResponse.status, 200, "Watch challenge must succeed");
      const challenge: { nonce: string; ts: number } = await challengeResponse.json();
      assert.equal(typeof challenge.nonce, "string");
      assert.equal(typeof challenge.ts, "number");
      const client: ConnectParams["client"] = {
        id: GATEWAY_CLIENT_IDS.WATCHOS_APP,
        displayName: "Hot reload synthetic Watch",
        version: "1.0.0",
        platform: "watchOS 11.5.0",
        deviceFamily: "Apple Watch",
        mode: GATEWAY_CLIENT_MODES.NODE,
        instanceId: "hot-reload-watch",
      };
      const signed = buildDeviceAuthPayloadV3({
        deviceId: identity.deviceId,
        clientId: client.id,
        clientMode: client.mode,
        role: "node",
        scopes: [],
        signedAtMs: challenge.ts,
        token: "deviceToken" in auth ? auth.deviceToken : auth.bootstrapToken,
        nonce: challenge.nonce,
        platform: client.platform,
        deviceFamily: client.deviceFamily,
      });
      const params: ConnectParams = {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client,
        role: "node",
        scopes: [],
        caps: [],
        commands,
        permissions: { notifications: true },
        auth,
        device: {
          id: identity.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
          signature: signDevicePayload(identity.privateKeyPem, signed),
          signedAt: challenge.ts,
          nonce: challenge.nonce,
        },
      };
      const response = await request("connect", undefined, params);
      assert.equal(response.status, 200, "Signed Watch connect must succeed");
      const connected: WatchConnection = await response.json();
      assert.equal(connected.ok, true);
      assert.equal(connected.nodeId, identity.deviceId);
      assert.equal(typeof connected.sessionToken, "string");
      assert.equal(typeof connected.deviceToken, "string");
      connects += 1;
      connection = connected;
      return connected;
    };
    const describe = () => rpc<NodeListNode>("node.describe", { nodeId: identity.deviceId });
    const expectCommands = (commands: string[]) =>
      waitForHotReloadFact(`Watch commands ${JSON.stringify(commands)}`, async () => {
        const node = await describe();
        return node.connected &&
          JSON.stringify(node.commands?.toSorted()) === JSON.stringify(commands)
          ? node
          : undefined;
      });
    const invoke = (command: string, marker = randomUUID()) =>
      rpc<{ payload: { marker: string } }>("node.invoke", {
        nodeId: identity.deviceId,
        command,
        params: { marker },
        timeoutMs: 10_000,
        idempotencyKey: randomUUID(),
      });

    try {
      await commandPolicy({ allow, deny });
      const setup = await rpc<DevicePairSetupCodeResult>("device.pair.setupCode", {
        bootstrapProfile: "node",
        includeQr: false,
        publicUrl: gateway.wsUrl,
      });
      assert.equal(setup.access, "node");
      const { bootstrapToken } = decodePairingSetupCode(setup.setupCode);
      const first = await connect({ bootstrapToken }, [APPROVED_COMMAND]);
      const approved = await expectCommands([APPROVED_COMMAND]);
      assert.equal(approved.approvalState, "approved");

      await commandPolicy({ allow, deny: [...deny, APPROVED_COMMAND] });
      await expectCommands([]);
      await assert.rejects(invoke(APPROVED_COMMAND), /node command not allowed/);

      const reconnected = await connect({ deviceToken: first.deviceToken }, [
        APPROVED_COMMAND,
        UNAPPROVED_COMMAND,
      ]);
      assert.equal(reconnected.deviceToken === first.deviceToken, true, "Device token is retained");
      assert.equal(
        reconnected.sessionToken !== first.sessionToken,
        true,
        "Watch session is replaced",
      );
      const denied = await expectCommands([]);
      const pending = (await rpc<PairingList>("node.pair.list")).pending.find(
        (entry) => entry.nodeId === identity.deviceId,
      );
      assert(
        pending?.commands?.includes(UNAPPROVED_COMMAND),
        "Wider declaration requires approval",
      );

      await commandPolicy({ allow, deny });
      const restored = await expectCommands([APPROVED_COMMAND]);
      assert.equal(
        restored.connectedAtMs,
        denied.connectedAtMs,
        "Reallow must retain the Watch session",
      );
      assert.equal(connects, 2, "Reallow must not need another Watch connect");
      await assert.rejects(invoke(UNAPPROVED_COMMAND), /node command not allowed/);

      const marker = randomUUID();
      const result = invoke(APPROVED_COMMAND, marker);
      void result.catch(() => {});
      const poll = await request("poll", reconnected.sessionToken);
      assert.equal(poll.status, 200, "Reallowed Watch session must remain usable for polling");
      const polled: { event: { event: string; payload?: unknown } | null } = await poll.json();
      assert.equal(polled.event?.event, "node.invoke.request");
      const invocation = coerceNodeInvokePayload(polled.event?.payload);
      assert(invocation, "Watch must receive the actual node invocation");
      assert.equal(invocation.nodeId, identity.deviceId);
      assert.equal(invocation.command, APPROVED_COMMAND);
      assert.deepEqual(JSON.parse(invocation.paramsJSON ?? "null"), { marker });
      const completed = await request("result", reconnected.sessionToken, {
        id: invocation.id,
        ok: true,
        payloadJSON: JSON.stringify({ marker }),
      });
      assert.equal(completed.status, 200);
      assert.deepEqual(await completed.json(), { ok: true });
      assert.equal((await result).payload.marker, marker);
      await verifyContinuity(
        PREFIX,
        "Signed Watch HTTP setup approved device.info; denied reconnect retained its ceiling, reallow restored polling/invoke/result on the same session, and unapproved device.status stayed denied",
      );
    } finally {
      try {
        if (connection) {
          await (await request("disconnect", connection.sessionToken)).arrayBuffer();
          await rpc("device.pair.remove", { deviceId: identity.deviceId });
        }
      } finally {
        await commandPolicy({ allow: original?.allow ?? [], deny: original?.deny ?? [] });
      }
    }
  });
}
