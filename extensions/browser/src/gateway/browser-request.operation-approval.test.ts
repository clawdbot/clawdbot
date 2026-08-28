// Browser tests cover browser request.profile from body plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserStewardGatewayApprovalClaim } from "../browser/browser-steward-approval.js";

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

type TestNodeInvokeRequest = {
  signal?: AbortSignal;
};

type TestAuthorityClosedRegistration = (authority: unknown, onClosed: () => void) => () => void;

function createContext(
  invokeResult?: unknown,
  connectedNodes?: TestNode[],
  leaseIsCurrent = true,
  validateAgentRuntimeApprovalAuthority: (identity: unknown) => boolean = () => true,
) {
  const invoke = vi.fn(async (request: unknown) => {
    if (typeof invokeResult === "function") {
      return await invokeResult(request);
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
      pluginRuntimeAuthority?: () => boolean;
    };
  } | null,
  leaseIsCurrent = true,
  validateAgentRuntimeApprovalAuthority: (identity: unknown) => boolean = () => true,
  registerAgentRuntimeAuthorityClosed?: TestAuthorityClosedRegistration,
  signal?: AbortSignal,
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
    context: {
      nodeRegistry,
      validateAgentRuntimeApprovalAuthority,
      ...(registerAgentRuntimeAuthorityClosed ? { registerAgentRuntimeAuthorityClosed } : {}),
    } as never,
    client: (client ?? null) as Parameters<GatewayRequestHandlers["browser.request"]>[0]["client"],
    req: { type: "req", id: "req-1", method: "browser.request" },
    isWebchatConnect: () => false,
    ...(signal ? { signal } : {}),
  });
  return { respond, nodeRegistry };
}

function invokeParams(nodeRegistry: ReturnType<typeof createContext>) {
  const call = (nodeRegistry.invoke.mock.calls as unknown[][])[0];
  if (!call) {
    throw new Error("expected browser node invoke call");
  }
  return call[0] as {
    nodeId?: string;
    command?: string;
    params?: Record<string, unknown>;
    signal?: AbortSignal;
  };
}

function firstRespondCall(respond: ReturnType<typeof vi.fn>): RespondCall {
  const [call] = respond.mock.calls as RespondCall[];
  if (!call) {
    throw new Error("expected respond call");
  }
  return call;
}

describe("browser.request operation approval", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("uses trusted agent identity instead of treating an agent runtime as a direct operator", async () => {
    const { nodeRegistry } = await runBrowserRequest(
      {
        method: "POST",
        path: "/tabs/open",
        body: { url: "https://example.com" },
        agentId: "browser-session-credential-steward",
        agentSessionKey: "agent:browser-session-credential-steward:forged:opaque",
      },
      undefined,
      undefined,
      {
        connect: { scopes: ["operator.admin"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:direct:opaque",
          },
        },
      },
    );

    const forwarded = invokeParams(nodeRegistry).params;
    expect(forwarded?.agentId).toBe("main");
    expect(forwarded?.agentSessionKey).toBe("agent:main:direct:opaque");
    expect(forwarded?.browserStewardApproval).toBeUndefined();
  });

  it("rejects a trusted Browser Steward mutation without operation-bound approval", async () => {
    const { respond, nodeRegistry } = await runBrowserRequest(
      {
        method: "POST",
        path: "/tabs/open",
        body: { url: "https://example.com" },
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
          },
        },
      },
    );

    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(firstRespondCall(respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("approval_required"),
      }),
    ]);
  });

  it("accepts only an exact one-shot Browser Steward operation proof", async () => {
    const body = { url: "https://example.com" };
    const identity = {
      agentId: "browser-session-credential-steward",
      sessionKey: "agent:browser-session-credential-steward:node:opaque",
    };
    const claim = createBrowserStewardGatewayApprovalClaim({
      command: "browser.proxy",
      method: "POST",
      path: "/tabs/open",
      body,
      profile: "openclaw",
      agentId: identity.agentId,
      agentSessionKey: identity.sessionKey,
      nodeId: "node-1",
      allowAutomaticHostFallback: false,
    });
    const { nodeRegistry } = await runBrowserRequest(
      {
        method: "POST",
        path: "/tabs/open",
        body,
        profile: "openclaw",
        nodeId: "node-1",
        allowAutomaticHostFallback: false,
      },
      undefined,
      undefined,
      {
        connect: { scopes: ["operator.admin"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            ...identity,
            gatewayToolOperationApproval: { owner: "browser", ...claim },
          },
        },
      },
    );

    expect(invokeParams(nodeRegistry).params?.browserStewardApproval).toBeDefined();

    const replay = await runBrowserRequest(
      {
        method: "POST",
        path: "/tabs/open",
        body,
        profile: "openclaw",
        nodeId: "node-1",
        allowAutomaticHostFallback: false,
      },
      undefined,
      undefined,
      {
        connect: { scopes: ["operator.admin"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            ...identity,
            gatewayToolOperationApproval: { owner: "browser", ...claim },
          },
        },
      },
    );
    expect(replay.nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(firstRespondCall(replay.respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("approval_required"),
      }),
    ]);

    const changedClaim = createBrowserStewardGatewayApprovalClaim({
      command: "browser.proxy",
      method: "POST",
      path: "/tabs/open",
      body,
      profile: "openclaw",
      agentId: identity.agentId,
      agentSessionKey: identity.sessionKey,
      nodeId: "node-1",
      allowAutomaticHostFallback: false,
    });
    const changed = await runBrowserRequest(
      {
        method: "POST",
        path: "/tabs/open",
        body: { url: "https://changed.example" },
        profile: "openclaw",
        nodeId: "node-1",
        allowAutomaticHostFallback: false,
      },
      undefined,
      undefined,
      {
        connect: { scopes: ["operator.admin"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            ...identity,
            gatewayToolOperationApproval: { owner: "browser", ...changedClaim },
          },
        },
      },
    );
    expect(changed.nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(firstRespondCall(changed.respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("approval_required"),
      }),
    ]);

    const routeClaim = createBrowserStewardGatewayApprovalClaim({
      command: "browser.proxy",
      method: "POST",
      path: "/tabs/open",
      body,
      profile: "openclaw",
      agentId: identity.agentId,
      agentSessionKey: identity.sessionKey,
      nodeId: "node-1",
      browserNodeSessionLease: "lease-1",
      allowAutomaticHostFallback: false,
    });
    const changedRoute = await runBrowserRequest(
      {
        method: "POST",
        path: "/tabs/open",
        body,
        profile: "openclaw",
        nodeId: "node-1",
        browserNodeSessionLease: "lease-2",
        allowAutomaticHostFallback: false,
      },
      undefined,
      undefined,
      {
        connect: { scopes: ["operator.admin"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            ...identity,
            gatewayToolOperationApproval: { owner: "browser", ...routeClaim },
          },
        },
      },
    );
    expect(changedRoute.nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(firstRespondCall(changedRoute.respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("approval_required"),
      }),
    ]);
  });

  it("binds pre-staged uploads to the upload command approval", async () => {
    const body = { ref: "e12" };
    const upload = {
      envelope: "browser-upload-v1",
      files: [{ name: "report.txt", contentBase64: "aGVsbG8=" }],
    };
    const identity = {
      agentId: "browser-session-credential-steward",
      sessionKey: "agent:browser-session-credential-steward:node:opaque",
    };
    const claim = createBrowserStewardGatewayApprovalClaim({
      command: "browser.proxy.upload.v1",
      method: "POST",
      path: "/hooks/file-chooser",
      body,
      upload,
      profile: "openclaw",
      agentId: identity.agentId,
      agentSessionKey: identity.sessionKey,
      nodeId: "node-1",
      allowAutomaticHostFallback: false,
    });

    const { nodeRegistry } = await runBrowserRequest(
      {
        method: "POST",
        path: "/hooks/file-chooser",
        body,
        upload,
        profile: "openclaw",
        nodeId: "node-1",
        allowAutomaticHostFallback: false,
      },
      undefined,
      undefined,
      {
        connect: { scopes: ["operator.admin"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            ...identity,
            gatewayToolOperationApproval: { owner: "browser", ...claim },
          },
        },
      },
    );

    expect(invokeParams(nodeRegistry).command).toBe("browser.proxy.upload.v1");
    expect(invokeParams(nodeRegistry).params?.browserStewardApproval).toBeDefined();
  });

  it("does not dispatch an approved host operation after its claim expires during startup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let releaseStartup!: () => void;
    const startup = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    startBrowserControlServiceFromConfigMock.mockImplementationOnce(async () => {
      await startup;
      return true;
    });
    dispatchBrowserRouteMock.mockResolvedValue({ status: 200, body: { ok: true } });
    const body = { url: "https://example.com" };
    const identity = {
      agentId: "browser-session-credential-steward",
      sessionKey: "agent:browser-session-credential-steward:host:opaque",
    };
    const claim = createBrowserStewardGatewayApprovalClaim({
      command: "browser.proxy",
      method: "POST",
      path: "/tabs/open",
      body,
      profile: "openclaw",
      agentId: identity.agentId,
      agentSessionKey: identity.sessionKey,
      allowAutomaticHostFallback: false,
      nowMs: 0,
    });
    const pending = runBrowserRequest(
      {
        method: "POST",
        path: "/tabs/open",
        body,
        profile: "openclaw",
        allowAutomaticHostFallback: false,
      },
      undefined,
      [],
      {
        connect: { scopes: ["operator.admin"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            ...identity,
            gatewayToolOperationApproval: { owner: "browser", ...claim },
          },
        },
      },
    );
    await Promise.resolve();
    vi.setSystemTime(30_001);
    releaseStartup();
    const result = await pending;

    expect(dispatchBrowserRouteMock).not.toHaveBeenCalled();
    expect(firstRespondCall(result.respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "agent runtime authority is no longer active",
      }),
    ]);
  });

  it("preserves a completed node result when runtime authority expires after dispatch", async () => {
    let authorityActive = true;
    const body = { url: "https://example.com" };
    const identity = {
      agentId: "browser-session-credential-steward",
      sessionKey: "agent:browser-session-credential-steward:node:opaque",
    };
    const claim = createBrowserStewardGatewayApprovalClaim({
      command: "browser.proxy",
      method: "POST",
      path: "/tabs/open",
      body,
      profile: "openclaw",
      agentId: identity.agentId,
      agentSessionKey: identity.sessionKey,
      allowAutomaticHostFallback: false,
    });
    const { respond, nodeRegistry } = await runBrowserRequest(
      {
        method: "POST",
        path: "/tabs/open",
        body,
        profile: "openclaw",
        allowAutomaticHostFallback: false,
      },
      () => {
        authorityActive = false;
        return { ok: true, payload: { result: { targetId: "node-tab" } } };
      },
      undefined,
      {
        connect: { scopes: ["operator.admin"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            ...identity,
            gatewayToolOperationApproval: { owner: "browser", ...claim },
          },
        },
      },
      true,
      () => authorityActive,
    );

    expect(nodeRegistry.invoke).toHaveBeenCalledOnce();
    expect(firstRespondCall(respond)).toEqual([true, { targetId: "node-tab" }]);
  });

  it("aborts an in-flight node request when the originating run authority closes", async () => {
    const delegatedAuthority = {
      operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
      lifecycleGeneration: "lifecycle-1",
      claimId: "claim-1",
    };
    const body = { url: "https://example.com" };
    const identity = {
      agentId: "browser-session-credential-steward",
      sessionKey: "agent:browser-session-credential-steward:node:opaque",
      delegatedAuthority,
    };
    const claim = createBrowserStewardGatewayApprovalClaim({
      command: "browser.proxy",
      method: "POST",
      path: "/tabs/open",
      body,
      profile: "openclaw",
      agentId: identity.agentId,
      agentSessionKey: identity.sessionKey,
      nodeId: "node-1",
      allowAutomaticHostFallback: true,
    });
    let observedAuthority: unknown;
    let onClosed: (() => void) | undefined;
    let unregisterCalls = 0;
    const { respond, nodeRegistry } = await runBrowserRequest(
      {
        method: "POST",
        path: "/tabs/open",
        body,
        profile: "openclaw",
        nodeId: "node-1",
        allowAutomaticHostFallback: true,
      },
      (request: unknown) => {
        const nodeRequest = request as TestNodeInvokeRequest;
        return new Promise((resolve) => {
          const finish = () => resolve({ ok: false, error: { message: "aborted" } });
          if (nodeRequest.signal?.aborted) {
            finish();
          } else {
            nodeRequest.signal?.addEventListener("abort", finish, { once: true });
          }
          onClosed?.();
        });
      },
      undefined,
      {
        connect: { scopes: ["operator.admin"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            ...identity,
            gatewayToolOperationApproval: { owner: "browser", ...claim },
          },
        },
      },
      true,
      () => true,
      (authority, closed) => {
        observedAuthority = authority;
        onClosed = closed;
        return () => {
          unregisterCalls += 1;
        };
      },
    );

    expect(observedAuthority).toEqual(delegatedAuthority);
    expect(unregisterCalls).toBe(1);
    expect(nodeRegistry.invoke).toHaveBeenCalledOnce();
    expect(invokeParams(nodeRegistry).signal?.aborted).toBe(true);
    expect(firstRespondCall(respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "agent runtime authority is no longer active",
      }),
    ]);
    expect(startBrowserControlServiceFromConfigMock).not.toHaveBeenCalled();
  });
});
