import { expect } from "vitest";
import { resetConfigRuntimeState, type GatewayAuthConfig } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { GatewayServer } from "./server.js";
import { agentCommandMock, getGatewayTestPort, testState } from "./test-helpers.js";

type OwnerIdentityRequests = {
  post: (stream: boolean | undefined, headers: Record<string, string>) => Promise<Response>;
  consume: (response: Response, stream: boolean) => Promise<unknown>;
  senderIsOwner: () => unknown;
};

export async function expectDeclaredHttpOwnerIdentity(params: OwnerIdentityRequests) {
  for (const stream of [false, true]) {
    for (const { scopes, senderIsOwner } of [
      { scopes: "operator.write", senderIsOwner: false },
      { scopes: "operator.admin, operator.write", senderIsOwner: true },
    ]) {
      agentCommandMock.mockClear();
      agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);
      const response = await params.post(stream, {
        "x-openclaw-scopes": scopes,
        "x-openclaw-sender-is-owner": "true",
      });
      expect(response.status).toBe(200);
      await params.consume(response, stream);
      expect(agentCommandMock).toHaveBeenCalledTimes(1);
      expect(params.senderIsOwner()).toBe(senderIsOwner);
    }
  }
}

export async function expectSharedSecretHttpOwnerIdentity(params: OwnerIdentityRequests) {
  for (const stream of [false, true]) {
    agentCommandMock.mockClear();
    agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);
    const response = await params.post(stream, {
      authorization: "Bearer secret",
      "x-openclaw-scopes": "operator.approvals",
      "x-openclaw-sender-is-owner": "false",
    });
    expect(response.status).toBe(200);
    await params.consume(response, stream);
    expect(agentCommandMock).toHaveBeenCalledTimes(1);
    expect(params.senderIsOwner()).toBe(true);
  }
  agentCommandMock.mockClear();
  const unauthorized = await params.post(undefined, {
    authorization: "Bearer wrong",
    "x-openclaw-sender-is-owner": "true",
  });
  expect(unauthorized.status).toBe(401);
  await params.consume(unauthorized, false);
  expect(agentCommandMock).not.toHaveBeenCalled();
}

export async function expectHttpForeignSessionAuthority(params: {
  authMethod: "trusted-proxy" | "token";
  ownerEmail: string;
  sessionKey: string;
  sessionId: string;
  closeReason: string;
  startServer: (port: number, auth: GatewayAuthConfig) => Promise<GatewayServer>;
  writeGatewayConfig: (config: Record<string, unknown>) => Promise<void>;
  post: (port: number, headers: Record<string, string>) => Promise<Response>;
}) {
  const sharedSecretOwner = params.authMethod === "token";
  await withEnvAsync(
    { OPENCLAW_GATEWAY_TOKEN: undefined, OPENCLAW_GATEWAY_PASSWORD: undefined },
    async () => {
      const port = await getGatewayTestPort();
      let server: GatewayServer | undefined;
      const previousGatewayAuth = testState.gatewayAuth;
      const trustedProxyAuth = {
        mode: "trusted-proxy" as const,
        trustedProxy: {
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowLoopback: true,
        },
      };
      const requestAuth = sharedSecretOwner
        ? { mode: "token" as const, token: "owner-secret" }
        : trustedProxyAuth;
      testState.gatewayAuth = requestAuth;
      try {
        await params.writeGatewayConfig({
          gateway: {
            auth: requestAuth,
            trustedProxies: ["127.0.0.1"],
            roles: {
              default: "guest",
              definitions: {
                guest: {
                  agents: sharedSecretOwner ? [] : "*",
                  scopes: ["operator.write"],
                  sessions: { others: "view" },
                },
              },
            },
          },
        });
        resetConfigRuntimeState();
        server = await params.startServer(port, requestAuth);

        const owner = ensureProfileForEmail(params.ownerEmail);
        const sessionKey = params.sessionKey;
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: params.sessionId,
            updatedAt: 1,
            visibility: "shared",
            createdVia: "operator",
            createdActor: { type: "human", source: "profile", id: owner.id },
          },
        );

        agentCommandMock.mockClear();
        agentCommandMock.mockResolvedValueOnce({ payloads: [{ text: "hello" }] } as never);
        const response = await params.post(port, {
          ...(sharedSecretOwner
            ? { authorization: "Bearer owner-secret" }
            : {
                "x-forwarded-for": "198.51.100.42",
                "x-forwarded-proto": "https",
                "x-forwarded-user": "guest@example.test",
              }),
          "x-openclaw-session-key": sessionKey,
        });

        expect(response.status).toBe(sharedSecretOwner ? 200 : 403);
        if (sharedSecretOwner) {
          expect(agentCommandMock).toHaveBeenCalledOnce();
        } else {
          expect(await response.json()).toMatchObject({
            error: { type: "forbidden", message: expect.stringContaining("session is shared") },
          });
          expect(agentCommandMock).not.toHaveBeenCalled();
        }
      } finally {
        await server?.close({ reason: params.closeReason });
        testState.gatewayAuth = previousGatewayAuth;
        await params.writeGatewayConfig({});
        resetConfigRuntimeState();
      }
    },
  );
}
