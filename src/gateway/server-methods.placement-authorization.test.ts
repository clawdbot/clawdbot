import { describe, expect, it, vi } from "vitest";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const placementCases = [
  [
    "writer device dispatch",
    "sessions.dispatch",
    { key: "agent:main:test", deviceId: "device-1" },
    ["operator.write"],
    true,
  ],
  [
    "writer profile dispatch",
    "sessions.dispatch",
    { key: "agent:main:test", profileId: "development" },
    ["operator.write"],
    false,
  ],
  [
    "admin profile dispatch",
    "sessions.dispatch",
    { key: "agent:main:test", profileId: "development" },
    ["operator.admin"],
    true,
  ],
  [
    "writer gateway move",
    "sessions.move",
    {
      key: "agent:main:test",
      expected: { generation: 1, environmentId: "environment-1", ownerEpoch: 1 },
      target: { kind: "gateway" },
    },
    ["operator.write"],
    true,
  ],
  [
    "writer device move",
    "sessions.move",
    {
      key: "agent:main:test",
      expected: { generation: 1, environmentId: "environment-1", ownerEpoch: 1 },
      target: { kind: "device", deviceId: "device-1" },
    },
    ["operator.write"],
    true,
  ],
  [
    "writer profile move",
    "sessions.move",
    {
      key: "agent:main:test",
      expected: { generation: 1, environmentId: "environment-1", ownerEpoch: 1 },
      target: { kind: "profile", profileId: "development" },
    },
    ["operator.write"],
    false,
  ],
  [
    "admin profile move",
    "sessions.move",
    {
      key: "agent:main:test",
      expected: { generation: 1, environmentId: "environment-1", ownerEpoch: 1 },
      target: { kind: "profile", profileId: "development" },
    },
    ["operator.admin"],
    true,
  ],
] as const;

function operatorClient(id: string, scopes: readonly string[]) {
  return {
    connId: `conn-${id}`,
    connect: {
      role: "operator",
      scopes: [...scopes],
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  } as Parameters<typeof handleGatewayRequest>[0]["client"];
}

function requestContext() {
  return {
    getRuntimeConfig: () => ({}),
    logGateway: { warn: vi.fn() },
  } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
}

describe("session placement target authorization", () => {
  it.each(placementCases)(
    "authorizes %s before the handler",
    async (name, method, params, scopes, allowed) => {
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) =>
        respond(true, { reached: true }),
      );
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: `req-${name}`, method, params },
        respond,
        client: operatorClient(name, scopes),
        isWebchatConnect: () => false,
        context: requestContext(),
        extraHandlers: { [method]: handler },
      });

      if (allowed) {
        expect(handler).toHaveBeenCalledOnce();
        expect(respond).toHaveBeenCalledWith(true, { reached: true });
        return;
      }
      expect(handler).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "FORBIDDEN",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.admin",
            requiredScopes: ["operator.admin"],
          },
        }),
      );
    },
  );

  it.each([
    ["sessions.dispatch", { key: "agent:main:test", profileId: "profile", deviceId: "device" }],
    ["sessions.move", { key: "agent:main:test", target: { kind: "profile" } }],
  ] as const)("lets malformed %s params reach schema validation", async (method, params) => {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: { type: "req", id: `req-malformed-${method}`, method, params },
      respond,
      client: operatorClient(method, ["operator.write"]),
      isWebchatConnect: () => false,
      context: requestContext(),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining(`invalid ${method} params`),
      }),
    );
  });
});
