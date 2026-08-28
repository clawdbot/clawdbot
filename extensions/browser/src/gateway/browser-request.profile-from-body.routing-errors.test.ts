// Browser tests cover browser request profile routing and bounded node errors.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("browser.request profile routing and errors", () => {
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
  it("sends Gateway-owned upload bytes without forwarding source paths", async () => {
    const upload = {
      envelope: "browser-upload-v1",
      files: [{ name: "report.txt", contentBase64: "aGVsbG8=" }],
    };
    uploadMocks.prepareBrowserProxyUploadRequest.mockResolvedValueOnce({
      body: { ref: "e12" },
      upload,
    });

    const { respond, nodeRegistry } = await runBrowserRequest({
      method: "POST",
      path: "/hooks/file-chooser",
      body: {
        paths: ["/tmp/openclaw/uploads/report.txt"],
        ref: "e12",
      },
    });

    expect(invokeParams(nodeRegistry).params).toMatchObject({
      body: { ref: "e12" },
      upload,
    });
    expect(invokeParams(nodeRegistry).command).toBe("browser.proxy.upload.v1");
    expect(invokeParams(nodeRegistry).params?.body).not.toHaveProperty("paths");
    expect(firstRespondCall(respond)[0]).toBe(true);
  });

  it("uses the original Gateway paths when an auto-selected old node lacks upload support", async () => {
    const originalBody = {
      paths: ["/tmp/openclaw/uploads/report.txt"],
      ref: "e12",
    };
    uploadMocks.prepareBrowserProxyUploadRequest.mockResolvedValueOnce({
      body: { ref: "e12" },
      upload: {
        envelope: "browser-upload-v1",
        files: [{ name: "report.txt", contentBase64: "aGVsbG8=" }],
      },
    });
    startBrowserControlServiceFromConfigMock.mockResolvedValueOnce(true);
    dispatchBrowserRouteMock.mockResolvedValueOnce({ status: 200, body: { ok: true } });

    const { respond, nodeRegistry } = await runBrowserRequest(
      {
        method: "POST",
        path: "/hooks/file-chooser",
        body: originalBody,
      },
      undefined,
      [
        {
          nodeId: "node-1",
          caps: ["browser"],
          commands: ["browser.proxy"],
          platform: "linux",
        },
      ],
    );

    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(dispatchBrowserRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/hooks/file-chooser",
        body: originalBody,
      }),
    );
    expect(firstRespondCall(respond)).toEqual([true, { ok: true }]);
    expect(uploadMocks.prepareBrowserProxyUploadRequest).not.toHaveBeenCalled();
  });

  it("rejects a configured old node upload before node dispatch", async () => {
    loadConfigMock.mockReturnValue({
      gateway: { nodes: { browser: { mode: "auto", node: "node-1" } } },
    });
    uploadMocks.prepareBrowserProxyUploadRequest.mockResolvedValueOnce({
      body: { ref: "e12" },
      upload: {
        envelope: "browser-upload-v1",
        files: [{ name: "report.txt", contentBase64: "aGVsbG8=" }],
      },
    });

    const { respond, nodeRegistry } = await runBrowserRequest(
      {
        method: "POST",
        path: "/hooks/file-chooser",
        body: { paths: ["/tmp/openclaw/uploads/report.txt"], ref: "e12" },
      },
      undefined,
      [
        {
          nodeId: "node-1",
          caps: ["browser"],
          commands: ["browser.proxy"],
          platform: "linux",
        },
      ],
    );

    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(startBrowserControlServiceFromConfigMock).not.toHaveBeenCalled();
    expect(firstRespondCall(respond)[2]?.message).toContain(
      "browser node does not support remote upload transfer",
    );
    expect(uploadMocks.prepareBrowserProxyUploadRequest).not.toHaveBeenCalled();
  });

  it("explains when configured-node upload support is awaiting approval", async () => {
    loadConfigMock.mockReturnValue({
      gateway: { nodes: { browser: { mode: "auto", node: "node-1" } } },
    });

    const { respond, nodeRegistry } = await runBrowserRequest(
      {
        method: "POST",
        path: "/hooks/file-chooser",
        body: { paths: ["/tmp/openclaw/uploads/report.txt"], ref: "e12" },
      },
      undefined,
      [
        {
          nodeId: "node-1",
          caps: ["browser"],
          commands: ["browser.proxy"],
          declaredCommands: ["browser.proxy", "browser.proxy.upload.v1"],
          platform: "linux",
        },
      ],
    );

    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(firstRespondCall(respond)[2]?.message).toContain(
      "remote upload transfer is pending approval",
    );
    expect(uploadMocks.prepareBrowserProxyUploadRequest).not.toHaveBeenCalled();
  });

  it("preserves a configured node failure instead of falling back to the host", async () => {
    loadConfigMock.mockReturnValue({
      gateway: { nodes: { browser: { mode: "auto", node: "node-1" } } },
    });
    const { respond } = await runBrowserRequest(
      { method: "GET", path: "/" },
      {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Browser control host is not reachable on 127.0.0.1:18791.",
        },
      },
    );

    expect(startBrowserControlServiceFromConfigMock).not.toHaveBeenCalled();
    expect(firstRespondCall(respond)[2]?.message).toContain(
      "Browser control host is not reachable",
    );
  });

  it("preserves ambiguous auto-selected node failures", async () => {
    const { respond } = await runBrowserRequest(
      { method: "GET", path: "/" },
      {
        ok: false,
        error: { code: "UNAVAILABLE", message: "node invoke timed out" },
      },
    );

    expect(startBrowserControlServiceFromConfigMock).not.toHaveBeenCalled();
    expect(firstRespondCall(respond)[2]?.message).toBe("UNAVAILABLE: node invoke timed out");
  });

  it("preserves status-coded node proxy errors for internal Browser tool callers", async () => {
    const { respond } = await runBrowserRequest(
      { method: "POST", path: "/act", includeRoute: true },
      { ok: false, error: { code: "INVALID_REQUEST", message: "404: tab not found" } },
    );

    expect(firstRespondCall(respond)).toEqual([
      true,
      { error: { status: 404, body: { error: "tab not found" } } },
      undefined,
    ]);
  });

  it("wraps unstructured node proxy errors for internal Browser tool callers", async () => {
    const { respond } = await runBrowserRequest(
      { method: "POST", path: "/act", includeRoute: true },
      { ok: false, error: { code: "UNAVAILABLE", message: "node disconnected" } },
    );

    expect(firstRespondCall(respond)).toEqual([
      true,
      { error: { status: 502, body: { error: "node disconnected" } } },
      undefined,
    ]);
  });

  it("maps validated node-proxy route failures like local route failures", async () => {
    const errorBody = {
      error: "headed mode needs a display",
      reason: "no_display_for_headed_profile",
      details: {
        profile: "openclaw",
        requestedHeadless: false,
        headlessSource: "config",
        displayPresent: false,
      },
    };
    const { respond } = await runBrowserRequest(
      { method: "POST", path: "/start" },
      { ok: true, payload: { error: { status: 409, body: errorBody } } },
    );

    const [ok, payload, error] = firstRespondCall(respond);
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "headed mode needs a display",
      details: errorBody,
    });
  });

  it.each([
    {
      name: "recognized action code",
      body: { error: "evaluation disabled", code: "ACT_EVALUATE_DISABLED" },
      details: { error: "evaluation disabled", code: "ACT_EVALUATE_DISABLED" },
    },
    {
      name: "unrecognized action code",
      body: { error: "evaluation disabled", code: "ACT_FUTURE_CODE" },
      details: { error: "evaluation disabled", unrecognizedCode: true },
    },
  ])("preserves bounded $name state through the node proxy", async ({ body, details }) => {
    const { respond } = await runBrowserRequest(
      { method: "POST", path: "/act" },
      { ok: true, payload: { error: { status: 403, body } } },
    );

    expect(firstRespondCall(respond)[2]).toEqual({
      code: "INVALID_REQUEST",
      message: "evaluation disabled",
      details,
    });
  });

  it("returns UNAVAILABLE for an incomplete node file envelope", async () => {
    const { respond } = await runBrowserRequest(
      { method: "POST", path: "/screenshot" },
      {
        ok: true,
        payload: { result: { path: "/node/browser/screenshot.png" } },
      },
    );

    const [ok, payload, error] = firstRespondCall(respond);
    expect(ok).toBe(false);
    expect(payload).toBeUndefined();
    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      message: "browser proxy file transfer failed",
    });
  });
});
