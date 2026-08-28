// Browser tests cover browser request.profile from body plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeBrowserStewardGatewayApprovalAuthority,
  createBrowserStewardGatewayApprovalClaim,
} from "../browser/browser-steward-approval.js";

const {
  loadConfigMock,
  isNodeCommandAllowedMock,
  resolveNodeCommandAllowlistMock,
  startBrowserControlServiceFromConfigMock,
  createBrowserControlContextMock,
  createBrowserRouteDispatcherMock,
  dispatchBrowserRouteMock,
} = vi.hoisted(() => {
  const dispatchMock = vi.fn();
  return {
    loadConfigMock: vi.fn(),
    isNodeCommandAllowedMock: vi.fn(),
    resolveNodeCommandAllowlistMock: vi.fn(),
    startBrowserControlServiceFromConfigMock: vi.fn(async () => false),
    createBrowserControlContextMock: vi.fn(() => ({ control: true })),
    dispatchBrowserRouteMock: dispatchMock,
    createBrowserRouteDispatcherMock: vi.fn(() => ({
      dispatch: dispatchMock,
    })),
  };
});

const uploadMocks = vi.hoisted(() => ({
  isBrowserProxyUploadRequest: vi.fn(
    (params: { method: string; path: string; body: unknown }) =>
      params.method === "POST" &&
      params.path === "/hooks/file-chooser" &&
      Array.isArray((params.body as { paths?: unknown } | undefined)?.paths) &&
      ((params.body as { paths: unknown[] }).paths.length ?? 0) > 0,
  ),
  prepareBrowserProxyUploadRequest: vi.fn(),
}));

vi.mock("../core-api.js", async () => {
  const actual = await vi.importActual<typeof import("../core-api.js")>("../core-api.js");
  return {
    ...actual,
    startBrowserControlServiceFromConfig: startBrowserControlServiceFromConfigMock,
    createBrowserControlContext: createBrowserControlContextMock,
    createBrowserRouteDispatcher: createBrowserRouteDispatcherMock,
  };
});

vi.mock("../browser-proxy-upload.js", () => uploadMocks);

vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/runtime-config-snapshot")
  >("openclaw/plugin-sdk/runtime-config-snapshot");
  return {
    ...actual,
    getRuntimeConfig: loadConfigMock,
    loadConfig: loadConfigMock,
  };
});

vi.mock("../sdk-node-runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("../sdk-node-runtime.js")>("../sdk-node-runtime.js");
  return {
    ...actual,
    isNodeCommandAllowed: isNodeCommandAllowedMock,
    resolveNodeCommandAllowlist: resolveNodeCommandAllowlistMock,
  };
});

import type { GatewayRequestHandlers } from "../sdk-node-runtime.js";
import { browserHandlers } from "./browser-request.js";

type RespondCall = [boolean, unknown?, { code: string; message: string; details?: unknown }?];

type TestNode = {
  nodeId: string;
  pairingGeneration?: string;
  displayName?: string;
  caps?: string[];
  commands?: string[];
  declaredCommands?: string[];
  platform?: string;
};

function createContext(
  invokeResult?: unknown,
  connectedNodes?: TestNode[],
  leaseIsCurrent = true,
  validateAgentRuntimeApprovalAuthority: (identity: unknown) => boolean = () => true,
) {
  const invoke = vi.fn(async (_request: unknown) => {
    if (typeof invokeResult === "function") {
      return await invokeResult();
    }
    return invokeResult === undefined
      ? { ok: true, payload: { result: { ok: true } } }
      : invokeResult;
  });
  const listConnected = vi.fn(
    () =>
      connectedNodes ?? [
        {
          nodeId: "node-1",
          pairingGeneration: "pairing-1",
          caps: ["browser"],
          commands: ["browser.proxy", "browser.proxy.upload.v1"],
          platform: "linux",
        },
      ],
  );
  const createBrowserNodeSessionLease = vi.fn(() => "lease-1");
  const renewBrowserNodeSessionLease = vi.fn(() => listConnected()[0]);
  const resolveBrowserNodeSessionLease = vi.fn(() =>
    leaseIsCurrent ? listConnected()[0] : undefined,
  );
  return {
    invoke,
    listConnected,
    createBrowserNodeSessionLease,
    renewBrowserNodeSessionLease,
    resolveBrowserNodeSessionLease,
    validateAgentRuntimeApprovalAuthority,
  };
}

async function runBrowserRequest(
  params: Record<string, unknown>,
  invokeResult?: unknown,
  connectedNodes?: TestNode[],
  client?: {
    connect?: { scopes?: string[] };
    internal?: {
      agentRuntimeIdentity?: unknown;
      pluginRuntimeOwnerId?: string;
      browserRequestCompatibility?: true;
      pluginRuntimeAuthority?: () => boolean;
    };
  } | null,
  leaseIsCurrent = true,
  validateAgentRuntimeApprovalAuthority: (identity: unknown) => boolean = () => true,
) {
  const respond = vi.fn();
  const nodeRegistry = createContext(
    invokeResult,
    connectedNodes,
    leaseIsCurrent,
    validateAgentRuntimeApprovalAuthority,
  );
  await expectDefined(
    browserHandlers["browser.request"],
    "browser request handler",
  )({
    params,
    respond: respond as never,
    context: { nodeRegistry, validateAgentRuntimeApprovalAuthority } as never,
    client: (client ?? null) as Parameters<GatewayRequestHandlers["browser.request"]>[0]["client"],
    req: { type: "req", id: "req-1", method: "browser.request" },
    isWebchatConnect: () => false,
  });
  return { respond, nodeRegistry };
}

function invokeParams(nodeRegistry: ReturnType<typeof createContext>) {
  const call = (nodeRegistry.invoke.mock.calls as unknown[][])[0];
  if (!call) {
    throw new Error("expected browser node invoke call");
  }
  return call[0] as { nodeId?: string; command?: string; params?: Record<string, unknown> };
}

function firstRespondCall(respond: ReturnType<typeof vi.fn>): RespondCall {
  const [call] = respond.mock.calls as RespondCall[];
  if (!call) {
    throw new Error("expected respond call");
  }
  return call;
}

describe("browser.request profile selection", () => {
  beforeEach(() => {
    loadConfigMock.mockReturnValue({
      gateway: { nodes: { browser: { mode: "auto" } } },
    });
    resolveNodeCommandAllowlistMock.mockReturnValue([]);
    isNodeCommandAllowedMock.mockReturnValue({ ok: true });
    startBrowserControlServiceFromConfigMock.mockReset().mockResolvedValue(false);
    createBrowserControlContextMock.mockClear();
    createBrowserRouteDispatcherMock.mockClear();
    dispatchBrowserRouteMock.mockReset();
    uploadMocks.isBrowserProxyUploadRequest.mockClear();
    uploadMocks.prepareBrowserProxyUploadRequest
      .mockReset()
      .mockImplementation(async ({ body }: { body: unknown }) => ({ body }));
  });

  it("issues an opaque route lease for an exact connected browser node", async () => {
    const { respond, nodeRegistry } = await runBrowserRequest(
      { routeOnly: true, nodeId: "node-1" },
      undefined,
      undefined,
      { connect: { scopes: ["operator.admin"] } },
    );

    expect(firstRespondCall(respond)).toEqual([
      true,
      { browserNodeSessionLease: "lease-1", nodeId: "node-1" },
      undefined,
    ]);
    expect(nodeRegistry.createBrowserNodeSessionLease).toHaveBeenCalledWith("node-1");
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it("renews the same route lease only for an exact approved node route", async () => {
    const { respond, nodeRegistry } = await runBrowserRequest(
      {
        routeOnly: true,
        nodeId: "node-1",
        browserNodeSessionLease: "lease-1",
        renewBrowserNodeSessionLease: true,
      },
      undefined,
      undefined,
      { connect: { scopes: ["operator.admin"] } },
    );

    expect(firstRespondCall(respond)).toEqual([
      true,
      { browserNodeSessionLease: "lease-1", nodeId: "node-1" },
      undefined,
    ]);
    expect(nodeRegistry.renewBrowserNodeSessionLease).toHaveBeenCalledWith("node-1", "lease-1");
    expect(nodeRegistry.createBrowserNodeSessionLease).not.toHaveBeenCalled();
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it("rejects a Browser Steward request after its node route lease becomes stale", async () => {
    const { respond, nodeRegistry } = await runBrowserRequest(
      {
        method: "POST",
        path: "/act",
        nodeId: "node-1",
        browserNodeSessionLease: "lease-1",
        body: { request: { kind: "click", ref: "button" } },
        agentSessionKey: "agent:browser-session-credential-steward:node:opaque",
        agentId: "browser-session-credential-steward",
      },
      undefined,
      undefined,
      { connect: { scopes: ["operator.admin"] } },
      false,
    );

    const [ok, payload, error] = firstRespondCall(respond);
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "browser node route lease is stale; request approval again",
    });
    expect(JSON.stringify(error)).not.toContain("opaque");
    expect(nodeRegistry.resolveBrowserNodeSessionLease).toHaveBeenCalledWith("node-1", "lease-1");
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it("forces system-profile import host-local even when a browser node is connected", async () => {
    const { respond, nodeRegistry } = await runBrowserRequest({
      method: "POST",
      path: "/profiles/import",
      body: { browser: "chrome", systemProfile: "Default", into: "imported" },
    });

    // Never routed to the browser node...
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    // ...and reached host-local dispatch instead of the node-proxy block.
    expect(startBrowserControlServiceFromConfigMock).toHaveBeenCalled();
    const [ok, payload, error] = firstRespondCall(respond);
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.message).toBe("browser control is disabled");
  });

  it("uses profile from request body when query profile is missing", async () => {
    const { respond, nodeRegistry } = await runBrowserRequest({
      method: "POST",
      path: "/act",
      body: { profile: "work", request: { action: "click", ref: "btn1" } },
    });

    const invoke = invokeParams(nodeRegistry);
    expect(invoke.command).toBe("browser.proxy");
    expect(invoke.params?.profile).toBe("work");
    expect(invoke.params?.errorEnvelope).toBe("browser-v1");
    expect(firstRespondCall(respond)[0]).toBe(true);
  });

  it("rejects generic plugin browser requests before node routing", async () => {
    const { respond, nodeRegistry } = await runBrowserRequest(
      {
        method: "GET",
        path: "/profiles",
        agentSessionKey: "agent:google-meet:direct:private-thread",
        legacyMeetingRuntime: true,
      },
      undefined,
      undefined,
      {
        connect: { scopes: ["operator.admin"] },
        internal: { pluginRuntimeOwnerId: "google-meet" },
      },
    );

    const [ok, payload, error] = firstRespondCall(respond);
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toEqual({
      code: "INVALID_REQUEST",
      message: "browser control requires a Browser-owned capability",
    });
    expect(JSON.stringify(error)).not.toContain("private-thread");
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
  });

  it("accepts only the host-issued legacy meeting compatibility authority", async () => {
    const { respond, nodeRegistry } = await runBrowserRequest(
      {
        method: "GET",
        path: "/profiles",
      },
      undefined,
      undefined,
      {
        connect: { scopes: ["operator.admin"] },
        internal: {
          pluginRuntimeOwnerId: "google-meet",
          browserRequestCompatibility: true,
        },
      },
    );

    expect(invokeParams(nodeRegistry).nodeId).toBe("node-1");
    expect(firstRespondCall(respond)[0]).toBe(true);
  });

  it("carries a redacted admin approval envelope to the browser node", async () => {
    const rawSecret = "raw-browser-secret-user-123";
    const { nodeRegistry } = await runBrowserRequest(
      {
        method: "POST",
        path: "/act",
        body: { profile: "work", request: { kind: "type", text: rawSecret } },
        agentSessionKey: "agent:browser-session-credential-steward:node:user-123",
        agentId: "browser-session-credential-steward",
      },
      undefined,
      undefined,
      { connect: { scopes: ["operator.admin"] } },
    );

    const approval = invokeParams(nodeRegistry).params?.browserStewardApproval;
    expect(approval).toMatchObject({
      issuer: "gateway.operator.admin",
      command: "browser.proxy",
      action: "act",
      profile: "work",
      sessionBoundary: {
        kind: "browser_steward",
        affectedSession: "agent:browser-session-credential-steward:REDACTED",
      },
    });
    expect(JSON.stringify(approval)).not.toContain(rawSecret);
    expect(JSON.stringify(approval)).not.toContain("user-123");
  });

  it("prefers query profile over body profile when both are present", async () => {
    const { nodeRegistry } = await runBrowserRequest({
      method: "POST",
      path: "/act",
      query: { profile: "chrome" },
      body: { profile: "work", request: { action: "click", ref: "btn1" } },
    });

    expect(invokeParams(nodeRegistry).params?.profile).toBe("chrome");
  });

  it("routes configured compact Unicode browser node names through the node proxy", async () => {
    loadConfigMock.mockReturnValue({
      gateway: { nodes: { browser: { mode: "auto", node: "Café01" } } },
    });

    const { respond, nodeRegistry } = await runBrowserRequest(
      {
        method: "GET",
        path: "/profiles",
      },
      undefined,
      [
        {
          nodeId: "cafe-node",
          displayName: "Cafe\u0301 01",
          caps: ["browser"],
          commands: ["browser.proxy"],
          platform: "linux",
        },
        {
          nodeId: "other-node",
          displayName: "Other Browser",
          caps: ["browser"],
          commands: ["browser.proxy"],
          platform: "linux",
        },
      ],
    );

    const invoke = invokeParams(nodeRegistry);
    expect(invoke.nodeId).toBe("cafe-node");
    expect(invoke.command).toBe("browser.proxy");
    expect(firstRespondCall(respond)[0]).toBe(true);
  });

  it("honors a configured browser node in manual routing mode", async () => {
    loadConfigMock.mockReturnValue({
      gateway: { nodes: { browser: { mode: "manual", node: "node-1" } } },
    });

    const { respond, nodeRegistry } = await runBrowserRequest({ method: "GET", path: "/" });

    expect(invokeParams(nodeRegistry).nodeId).toBe("node-1");
    expect(firstRespondCall(respond)[0]).toBe(true);
  });

  it.each([
    {
      method: "POST",
      path: "/profiles/create",
      body: { name: "poc", cdpUrl: "http://10.0.0.42:9222" },
    },
    {
      method: "DELETE",
      path: "/profiles/poc",
      body: undefined,
    },
    {
      method: "POST",
      path: "profiles/create",
      body: { name: "poc", cdpUrl: "http://10.0.0.42:9222" },
    },
    {
      method: "DELETE",
      path: "profiles/poc",
      body: undefined,
    },
    {
      method: "POST",
      path: "/reset-profile",
      body: { profile: "poc", name: "poc" },
    },
    {
      method: "POST",
      path: "reset-profile",
      body: { profile: "poc", name: "poc" },
    },
  ])("blocks persistent profile mutations for $method $path", async ({ method, path, body }) => {
    const { respond, nodeRegistry } = await runBrowserRequest({
      method,
      path,
      body,
    });

    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    const [ok, payload, error] = firstRespondCall(respond);
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error?.message).toBe(
      "browser.request cannot mutate persistent browser profiles over a node proxy",
    );
  });

  it.each([
    { method: "POST", path: "/profiles/create", body: { name: "poc" } },
    { method: "DELETE", path: "/profiles/poc", body: undefined },
    { method: "POST", path: "/reset-profile", body: { profile: "poc", name: "poc" } },
  ])(
    "dispatches host-local admin mutations for $method $path when no node handles the request",
    async ({ method, path, body }) => {
      const { respond, nodeRegistry } = await runBrowserRequest(
        { method, path, body },
        undefined,
        [],
      );

      expect(nodeRegistry.invoke).not.toHaveBeenCalled();
      expect(startBrowserControlServiceFromConfigMock).toHaveBeenCalledOnce();
      const [ok, payload, error] = firstRespondCall(respond);
      expect(ok).toBe(false);
      expect(payload).toBeUndefined();
      expect(error?.message).toBe("browser control is disabled");
    },
  );

  it("allows non-mutating profile reads", async () => {
    const { respond, nodeRegistry } = await runBrowserRequest({
      method: "GET",
      path: "/profiles",
    });

    const invoke = invokeParams(nodeRegistry);
    expect(invoke.command).toBe("browser.proxy");
    expect(invoke.params?.method).toBe("GET");
    expect(invoke.params?.path).toBe("/profiles");
    expect(firstRespondCall(respond)[0]).toBe(true);
  });

  it("uses one canonical empty profile for an approved normalized profile route", async () => {
    const { respond, nodeRegistry } = await runBrowserRequest(
      {
        method: "GET",
        path: "/profiles/",
        agentSessionKey: "agent:browser-session-credential-steward:profiles",
        agentId: "browser-session-credential-steward",
      },
      undefined,
      undefined,
      { connect: { scopes: ["operator.admin"] } },
    );

    const invocation = nodeRegistry.invoke.mock.calls[0]?.[0] as {
      nodeId: string;
      command: string;
      idempotencyKey: string;
      expectedPairingGeneration: string;
      params: Record<string, unknown>;
    };
    expect(invocation.params.profile).toBe("");
    expect(
      consumeBrowserStewardGatewayApprovalAuthority({
        approval: invocation.params.browserStewardApproval,
        command: invocation.command,
        method: invocation.params.method as string,
        path: invocation.params.path as string,
        query: invocation.params.query,
        body: invocation.params.body,
        upload: invocation.params.upload,
        profile: invocation.params.profile as string,
        agentSessionKey: invocation.params.agentSessionKey as string,
        agentId: invocation.params.agentId as string,
        nodeId: invocation.nodeId,
        pairingGeneration: invocation.expectedPairingGeneration,
        invocationId: invocation.idempotencyKey,
      }),
    ).toBeDefined();
    expect(firstRespondCall(respond)[0]).toBe(true);
  });

  it("falls back to host dispatch when an auto-selected node has no browser host", async () => {
    const { respond, nodeRegistry } = await runBrowserRequest(
      { method: "GET", path: "/" },
      {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Browser control host is not reachable on 127.0.0.1:18791.",
        },
      },
    );

    expect(nodeRegistry.invoke).toHaveBeenCalledOnce();
    expect(startBrowserControlServiceFromConfigMock).toHaveBeenCalledOnce();
    expect(firstRespondCall(respond)[2]?.message).toBe("browser control is disabled");
  });

  it("keeps automatic host fallback for direct operator requests", async () => {
    startBrowserControlServiceFromConfigMock.mockResolvedValueOnce(true);
    dispatchBrowserRouteMock.mockResolvedValueOnce({
      status: 200,
      body: { targetId: "gateway-host-tab" },
    });
    const { respond, nodeRegistry } = await runBrowserRequest(
      {
        method: "POST",
        path: "/tabs/open",
        body: { url: "https://example.com" },
        includeRoute: true,
      },
      {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Browser control host is not reachable on 127.0.0.1:18791.",
        },
      },
      undefined,
      { connect: { scopes: ["operator.admin"] } },
    );

    expect(nodeRegistry.invoke).toHaveBeenCalledOnce();
    expect(dispatchBrowserRouteMock).toHaveBeenCalledOnce();
    expect(firstRespondCall(respond)).toEqual([
      true,
      { result: { targetId: "gateway-host-tab" }, route: { status: "host-fallback" } },
    ]);
  });

  it("returns a host-fallback envelope for internal routed callers", async () => {
    startBrowserControlServiceFromConfigMock.mockResolvedValueOnce(true);
    dispatchBrowserRouteMock.mockResolvedValueOnce({
      status: 200,
      body: { targetId: "gateway-host-tab" },
    });
    const { respond } = await runBrowserRequest(
      { method: "POST", path: "/tabs/open", includeRoute: true },
      {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Browser control host is not reachable on 127.0.0.1:18791.",
        },
      },
    );

    expect(firstRespondCall(respond)).toEqual([
      true,
      { result: { targetId: "gateway-host-tab" }, route: { status: "host-fallback" } },
    ]);
  });

  it("falls back when an auto-selected node is passed through as an internal node id", async () => {
    startBrowserControlServiceFromConfigMock.mockResolvedValueOnce(true);
    dispatchBrowserRouteMock.mockResolvedValueOnce({
      status: 200,
      body: { targetId: "gateway-host-tab" },
    });
    const { respond, nodeRegistry } = await runBrowserRequest(
      {
        method: "POST",
        path: "/tabs/open",
        body: { url: "https://example.com" },
        nodeId: "node-1",
        allowAutomaticHostFallback: true,
        includeRoute: true,
      },
      {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Browser control host is not reachable on 127.0.0.1:18791.",
        },
      },
    );

    expect(nodeRegistry.invoke).toHaveBeenCalledOnce();
    expect(dispatchBrowserRouteMock).toHaveBeenCalledOnce();
    expect(firstRespondCall(respond)).toEqual([
      true,
      { result: { targetId: "gateway-host-tab" }, route: { status: "host-fallback" } },
    ]);
  });

  it("does not host-fallback an approved Browser-owned route", async () => {
    const { respond, nodeRegistry } = await runBrowserRequest(
      {
        method: "GET",
        path: "/",
        nodeId: "node-1",
        allowAutomaticHostFallback: true,
      },
      {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Browser control host is not reachable on 127.0.0.1:18791.",
        },
      },
      undefined,
      {
        connect: { scopes: ["operator.admin"] },
        internal: { pluginRuntimeOwnerId: "browser" },
      },
    );

    expect(nodeRegistry.invoke).toHaveBeenCalledOnce();
    expect(startBrowserControlServiceFromConfigMock).not.toHaveBeenCalled();
    expect(firstRespondCall(respond)[2]?.message).toContain(
      "Browser control host is not reachable",
    );
  });

  it("does not dispatch after Browser runtime authority is revoked during preparation", async () => {
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    uploadMocks.prepareBrowserProxyUploadRequest.mockImplementationOnce(async ({ body }) => {
      await preparation;
      return { body };
    });
    const operationClaim = createBrowserStewardGatewayApprovalClaim({
      command: "browser.proxy",
      method: "POST",
      path: "/tabs/open",
      body: { url: "https://example.com" },
      agentId: "browser-session-credential-steward",
      agentSessionKey: "agent:browser-session-credential-steward:node:opaque",
      nodeId: "node-1",
      allowAutomaticHostFallback: false,
    });
    let authorityActive = true;
    const request = runBrowserRequest(
      {
        method: "POST",
        path: "/tabs/open",
        body: { url: "https://example.com" },
        nodeId: "node-1",
        allowAutomaticHostFallback: false,
        agentSessionKey: "agent:browser-session-credential-steward:node:opaque",
        agentId: "browser-session-credential-steward",
      },
      undefined,
      undefined,
      {
        connect: { scopes: ["operator.admin"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "browser-session-credential-steward",
            sessionKey: "agent:browser-session-credential-steward:node:opaque",
            gatewayToolOperationApproval: { owner: "browser", ...operationClaim },
          },
        },
      } as never,
      true,
      () => authorityActive,
    );
    await vi.waitFor(() => expect(uploadMocks.prepareBrowserProxyUploadRequest).toHaveBeenCalled());
    authorityActive = false;
    releasePreparation();

    const { respond, nodeRegistry } = await request;
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(firstRespondCall(respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "agent runtime authority is no longer active",
      }),
    ]);
  });

  it("does not dispatch or fall back after Browser plugin lifecycle authority is revoked", async () => {
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    uploadMocks.prepareBrowserProxyUploadRequest.mockImplementationOnce(async ({ body }) => {
      await preparation;
      return { body };
    });
    let authorityActive = true;
    const request = runBrowserRequest(
      {
        method: "POST",
        path: "/tabs/open",
        body: { url: "https://example.com" },
      },
      {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Browser control host is not reachable on 127.0.0.1:18791.",
        },
      },
      undefined,
      {
        connect: { scopes: ["operator.admin"] },
        internal: {
          pluginRuntimeOwnerId: "browser",
          pluginRuntimeAuthority: () => authorityActive,
        },
      },
    );
    await vi.waitFor(() => expect(uploadMocks.prepareBrowserProxyUploadRequest).toHaveBeenCalled());
    authorityActive = false;
    releasePreparation();

    const { respond, nodeRegistry } = await request;
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(startBrowserControlServiceFromConfigMock).not.toHaveBeenCalled();
    expect(firstRespondCall(respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "agent runtime authority is no longer active",
      }),
    ]);
  });

  it("blocks host fallback when Browser plugin lifecycle authority is revoked after node I/O", async () => {
    let authorityActive = true;
    const { respond, nodeRegistry } = await runBrowserRequest(
      { method: "GET", path: "/" },
      () => {
        authorityActive = false;
        return {
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "Browser control host is not reachable on 127.0.0.1:18791.",
          },
        };
      },
      undefined,
      {
        connect: { scopes: ["operator.admin"] },
        internal: {
          pluginRuntimeOwnerId: "browser",
          pluginRuntimeAuthority: () => authorityActive,
        },
      },
    );

    expect(nodeRegistry.invoke).toHaveBeenCalledOnce();
    expect(startBrowserControlServiceFromConfigMock).not.toHaveBeenCalled();
    expect(firstRespondCall(respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "agent runtime authority is no longer active",
      }),
    ]);
  });
});
