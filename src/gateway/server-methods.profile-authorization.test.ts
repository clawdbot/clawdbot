import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

function createPendingProfileClient() {
  return {
    connId: "conn-pending-profile",
    authenticatedUserId: "mutable-login@github",
    connect: {
      role: "operator" as const,
      scopes: ["operator.admin"],
      client: { id: "test", version: "1", platform: "test", mode: "test" },
      minProtocol: 1,
      maxProtocol: 1,
    },
  } as NonNullable<Parameters<typeof handleGatewayRequest>[0]["client"]>;
}

async function dispatchPendingProfileMethod(params: {
  client: NonNullable<Parameters<typeof handleGatewayRequest>[0]["client"]>;
  handler: GatewayRequestHandler;
  method: string;
  requestParams?: unknown;
  methodRegistry?: ReturnType<typeof createGatewayMethodRegistry>;
}) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: `req-${params.method}`,
      method: params.method,
      params: params.requestParams ?? {},
    },
    respond,
    client: params.client,
    isWebchatConnect: () => false,
    context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
      typeof handleGatewayRequest
    >[0]["context"],
    ...(params.methodRegistry
      ? { methodRegistry: params.methodRegistry }
      : { extraHandlers: { [params.method]: params.handler } }),
  });
  return respond;
}

describe("Gateway pending-profile authorization", () => {
  it("waits for immutable profile attachment before profile-dependent dispatch", async () => {
    const deferred = createDeferredCore<{ profileId: string; updatedAt: number }>();
    const client = createPendingProfileClient();
    client.authenticatedGitHubIdentitySync = vi.fn(async () => await deferred.promise);
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));

    const request = dispatchPendingProfileMethod({ client, handler, method: "chat.send" });
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();

    client.authenticatedUserProfile = {
      profileId: "profile-canonical",
      displayName: "Canonical",
      hasAvatar: false,
      updatedAt: 1,
    };
    deferred.resolve({ profileId: "profile-canonical", updatedAt: 1 });

    await expect(request).resolves.toHaveBeenCalledWith(true, { ok: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("returns retryable unavailability without dispatch and retries on the next request", async () => {
    const client = createPendingProfileClient();
    client.authenticatedGitHubIdentitySync = vi
      .fn()
      .mockRejectedValueOnce(new Error("private provider detail"))
      .mockImplementationOnce(async () => {
        client.authenticatedUserProfile = {
          profileId: "profile-retried",
          displayName: "Retried",
          hasAvatar: false,
          updatedAt: 2,
        };
        return { profileId: "profile-retried", updatedAt: 2 };
      });
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));

    const failed = await dispatchPendingProfileMethod({ client, handler, method: "agent" });
    expect(handler).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.not.stringContaining("private provider detail"),
        retryable: true,
        details: { code: "AUTHENTICATED_PROFILE_UNAVAILABLE" },
      }),
    );

    const retried = await dispatchPendingProfileMethod({ client, handler, method: "agent" });
    expect(handler).toHaveBeenCalledOnce();
    expect(retried).toHaveBeenCalledWith(true, { ok: true });
    expect(client.authenticatedGitHubIdentitySync).toHaveBeenCalledTimes(2);
  });

  it("classifies profile-owned core families and plugin or auxiliary methods fail-closed", async () => {
    const methods = [
      "agent",
      "approval.resolve",
      "artifacts.list",
      "board.event",
      "chat.history",
      "controlUi.sessionPreview",
      "exec.approval.resolve",
      "mcp.app.view",
      "message.action",
      "openclaw.chat",
      "plugin.approval.resolve",
      "projects.list",
      "secrets.store.set",
      "send",
      "sessions.list",
      "taskSuggestions.list",
      "tasks.list",
    ];
    for (const method of methods) {
      const client = createPendingProfileClient();
      client.authenticatedGitHubIdentitySync = vi.fn().mockRejectedValue(new Error("offline"));
      const handler = vi.fn<GatewayRequestHandler>();
      const respond = await dispatchPendingProfileMethod({ client, handler, method });
      expect(handler, method).not.toHaveBeenCalled();
      expect(respond, method).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
      );
    }

    for (const owner of [
      { kind: "plugin" as const, pluginId: "identity-reader" },
      { kind: "aux" as const, area: "identity-reader" },
    ]) {
      const client = createPendingProfileClient();
      client.authenticatedGitHubIdentitySync = vi.fn().mockRejectedValue(new Error("offline"));
      const handler = vi.fn<GatewayRequestHandler>();
      const method = `${owner.kind}.identity.read`;
      const methodRegistry = createGatewayMethodRegistry([
        { name: method, handler, owner, scope: "operator.admin" },
      ]);
      await dispatchPendingProfileMethod({ client, handler, method, methodRegistry });
      expect(handler, owner.kind).not.toHaveBeenCalled();
    }
  });

  it("dispatches explicitly independent plugin status while profile sync is unavailable", async () => {
    const client = createPendingProfileClient();
    client.authenticatedGitHubIdentitySync = vi.fn().mockRejectedValue(new Error("offline"));
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
    const method = "logbook.status";
    const methodRegistry = createGatewayMethodRegistry([
      {
        name: method,
        handler,
        owner: { kind: "plugin", pluginId: "logbook" },
        profileAccess: "independent",
        scope: "operator.read",
      },
    ]);

    const respond = await dispatchPendingProfileMethod({
      client,
      handler,
      method,
      methodRegistry,
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
    expect(client.authenticatedGitHubIdentitySync).not.toHaveBeenCalled();
  });

  it("gates parameter-dependent incognito access without blocking ordinary independent requests", async () => {
    const client = createPendingProfileClient();
    client.authenticatedGitHubIdentitySync = vi.fn().mockRejectedValue(new Error("offline"));
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));

    const blocked = await dispatchPendingProfileMethod({
      client,
      handler,
      method: "question.request",
      requestParams: { sessionKey: "agent:main:dashboard:incognito-profile-gate" },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    );

    const allowed = await dispatchPendingProfileMethod({
      client,
      handler,
      method: "question.request",
      requestParams: { sessionKey: "agent:main:main" },
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(allowed).toHaveBeenCalledWith(true, { ok: true });
    expect(client.authenticatedGitHubIdentitySync).toHaveBeenCalledOnce();
  });

  it("keeps profile bootstrap and identity-independent status available while sync is pending", async () => {
    for (const method of ["users.self", "status"]) {
      const client = createPendingProfileClient();
      client.authenticatedGitHubIdentitySync = vi.fn(
        () => new Promise<{ profileId: string; updatedAt: number }>(() => {}),
      );
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { ok: true }));
      const methodRegistry = createGatewayMethodRegistry([
        {
          name: method,
          handler,
          owner: { kind: "core", area: "gateway" },
          profileAccess: "independent",
          scope: "operator.admin",
        },
      ]);

      const respond = await dispatchPendingProfileMethod({
        client,
        handler,
        method,
        methodRegistry,
      });

      expect(handler, method).toHaveBeenCalledOnce();
      expect(respond, method).toHaveBeenCalledWith(true, { ok: true });
      expect(client.authenticatedGitHubIdentitySync, method).not.toHaveBeenCalled();
    }
  });
});
