import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  closeOpenClawStateDatabaseForTest,
  isOpenClawStateDatabaseOpen,
} from "../state/openclaw-state-db.js";
import {
  createOperatorIdentityFixture,
  REMOTE_BOOTSTRAP_HEADERS,
  startProxiedControlUiServer,
} from "./server.auth.control-ui.fixtures.test-support.js";
import {
  connectReq,
  ConnectErrorDetailCodes,
  openWs,
  restoreGatewayToken,
  rpcReq,
  startTestGatewayServer,
  testState,
} from "./server.auth.test-helpers.js";

const IOS_OPERATOR_SCOPES = [
  "operator.admin",
  "operator.approvals",
  "operator.questions",
  "operator.read",
  "operator.talk.secrets",
  "operator.write",
];

async function closeWs(ws: WebSocket | undefined): Promise<void> {
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

export function registerControlUiMobileReconnectSuite(): void {
  test("reconnects persisted mobile role tokens through shared and explicit fields after restart", async () => {
    type GatewayServer = Awaited<ReturnType<typeof startTestGatewayServer>>;
    const previousAuth = testState.gatewayAuth;
    const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    const previousPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
    let bootstrapServer: GatewayServer | undefined;
    let restartedServer: GatewayServer | undefined;
    let bootstrapWs: WebSocket | undefined;
    let unauthenticatedWs: WebSocket | undefined;

    try {
      testState.gatewayAuth = { mode: "password", password: "secret" };
      delete process.env.OPENCLAW_GATEWAY_TOKEN;

      const started = await startProxiedControlUiServer();
      bootstrapServer = started.server;
      const { port } = started;
      const { issueDeviceBootstrapToken } = await import("../infra/device-bootstrap.js");
      const { FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE } =
        await import("../shared/device-bootstrap-profile.js");
      const { getPairedDevice, listDevicePairing } = await import("../infra/device-pairing.js");
      const { identityPath, identity } = await createOperatorIdentityFixture(
        "openclaw-mobile-reconnect-",
      );
      const nodeClient = {
        id: "openclaw-ios",
        version: "2026.8.10",
        platform: "iOS 26.6.1",
        mode: "node" as const,
        deviceFamily: "iPhone",
      };

      const bootstrap = await issueDeviceBootstrapToken({
        profile: FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
      });
      bootstrapWs = await openWs(port, REMOTE_BOOTSTRAP_HEADERS);
      const initial = await connectReq(bootstrapWs, {
        skipDefaultAuth: true,
        bootstrapToken: bootstrap.token,
        role: "node",
        scopes: [],
        client: nodeClient,
        deviceIdentityPath: identityPath,
      });
      expect(initial.ok, JSON.stringify(initial.error)).toBe(true);
      expect(initial.payload?.type).toBe("hello-ok");

      const initialAuth = initial.payload?.auth;
      const nodeToken =
        isRecord(initialAuth) && typeof initialAuth.deviceToken === "string"
          ? initialAuth.deviceToken
          : undefined;
      const operatorHandoff =
        isRecord(initialAuth) && Array.isArray(initialAuth.deviceTokens)
          ? initialAuth.deviceTokens.find((entry) => isRecord(entry) && entry.role === "operator")
          : undefined;
      const operatorToken =
        isRecord(operatorHandoff) && typeof operatorHandoff.deviceToken === "string"
          ? operatorHandoff.deviceToken
          : undefined;
      if (!nodeToken || !operatorToken) {
        throw new Error("expected bootstrap to issue node and operator device tokens");
      }
      expect(isRecord(operatorHandoff) ? operatorHandoff.scopes : undefined).toEqual(
        IOS_OPERATOR_SCOPES,
      );

      const pairedBeforeRestart = await getPairedDevice(identity.deviceId);
      expect(pairedBeforeRestart?.tokens?.node?.token).toBe(nodeToken);
      expect(pairedBeforeRestart?.tokens?.operator?.token).toBe(operatorToken);

      bootstrapWs.close();
      bootstrapWs = undefined;
      await bootstrapServer.close();
      bootstrapServer = undefined;
      closeOpenClawStateDatabaseForTest();
      expect(isOpenClawStateDatabaseOpen()).toBe(false);

      restartedServer = await startTestGatewayServer(port, { controlUiEnabled: true });

      unauthenticatedWs = await openWs(port);
      const unauthenticated = await connectReq(unauthenticatedWs, {
        skipDefaultAuth: true,
        role: "operator",
        scopes: IOS_OPERATOR_SCOPES,
        client: { ...nodeClient, mode: "ui" as const },
        deviceIdentityPath: identityPath,
      });
      expect(unauthenticated.ok).toBe(false);
      const unauthenticatedDetails = unauthenticated.error?.details;
      expect(isRecord(unauthenticatedDetails) ? unauthenticatedDetails.code : undefined).toBe(
        ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
      );
      unauthenticatedWs.close();
      unauthenticatedWs = undefined;

      const reconnectRoles = async (
        pathName: string,
        credentialField: "token" | "deviceToken",
      ): Promise<void> => {
        let nodeWs: WebSocket | undefined;
        let operatorWs: WebSocket | undefined;
        try {
          nodeWs = await openWs(port);
          const nodeReconnect = await connectReq(nodeWs, {
            ...(credentialField === "token" ? { token: nodeToken } : { deviceToken: nodeToken }),
            skipDefaultAuth: true,
            role: "node",
            scopes: [],
            client: nodeClient,
            deviceIdentityPath: identityPath,
          });
          expect(nodeReconnect.ok, `${pathName}: ${JSON.stringify(nodeReconnect.error)}`).toBe(
            true,
          );
          expect(nodeReconnect.payload?.type).toBe("hello-ok");

          operatorWs = await openWs(port);
          const operatorReconnect = await connectReq(operatorWs, {
            ...(credentialField === "token"
              ? { token: operatorToken }
              : { deviceToken: operatorToken }),
            skipDefaultAuth: true,
            role: "operator",
            scopes: IOS_OPERATOR_SCOPES,
            client: { ...nodeClient, mode: "ui" as const },
            deviceIdentityPath: identityPath,
          });
          expect(
            operatorReconnect.ok,
            `${pathName}: ${JSON.stringify(operatorReconnect.error)}`,
          ).toBe(true);
          expect(operatorReconnect.payload?.type).toBe("hello-ok");

          expect((await rpcReq(operatorWs, "health")).ok).toBe(true);
          const nodes = await rpcReq<{
            nodes?: Array<{ connected?: boolean; nodeId?: string }>;
          }>(operatorWs, "node.list", {});
          expect(nodes.ok).toBe(true);
          expect(nodes.payload?.nodes).toContainEqual(
            expect.objectContaining({
              connected: true,
              nodeId: identity.deviceId,
            }),
          );
        } finally {
          await Promise.all([closeWs(operatorWs), closeWs(nodeWs)]);
        }
      };

      // iPhone and Android normal stored-token reconnects use auth.token; Watch/direct
      // and trusted retry paths use auth.deviceToken. Keep both mobile contracts covered.
      await reconnectRoles("normal stored-token fallback", "token");
      await reconnectRoles("explicit device-token path", "deviceToken");

      const pairingAfterReconnect = await listDevicePairing();
      expect(
        pairingAfterReconnect.pending.filter((entry) => entry.deviceId === identity.deviceId),
      ).toEqual([]);
      const pairedAfterReconnect = await getPairedDevice(identity.deviceId);
      expect(pairedAfterReconnect?.tokens?.node?.token).toBe(nodeToken);
      expect(pairedAfterReconnect?.tokens?.operator?.token).toBe(operatorToken);
    } finally {
      unauthenticatedWs?.close();
      bootstrapWs?.close();
      await restartedServer?.close();
      await bootstrapServer?.close();
      closeOpenClawStateDatabaseForTest();
      testState.gatewayAuth = previousAuth;
      restoreGatewayToken(previousToken);
      if (previousPassword === undefined) {
        delete process.env.OPENCLAW_GATEWAY_PASSWORD;
      } else {
        process.env.OPENCLAW_GATEWAY_PASSWORD = previousPassword;
      }
    }
  });
}
