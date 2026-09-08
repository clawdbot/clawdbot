// Browser tests cover browser request.profile from body plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlers } from "../core-api.js";

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

import { browserHandlers } from "./browser-request.js";

type RespondCall = [boolean, unknown?, { code: string; message: string; details?: unknown }?];

type TestNode = {
  nodeId: string;
  displayName?: string;
  caps?: string[];
  commands?: string[];
  declaredCommands?: string[];
  platform?: string;
};

function createContext(invokeResult?: unknown, connectedNodes?: TestNode[]) {
  const invoke = vi.fn(async () =>
    invokeResult === undefined ? { ok: true, payload: { result: { ok: true } } } : invokeResult,
  );
  const listConnected = vi.fn(
    () =>
      connectedNodes ?? [
        {
          nodeId: "node-1",
          caps: ["browser"],
          commands: ["browser.proxy", "browser.proxy.upload.v1"],
          platform: "linux",
        },
      ],
  );
  return {
    invoke,
    listConnected,
  };
}

async function runBrowserRequest(
  params: Record<string, unknown>,
  invokeResult?: unknown,
  connectedNodes?: TestNode[],
  requester: Partial<
    Pick<Parameters<GatewayRequestHandlers[string]>[0], "client" | "hasCurrentClientAuthority">
  > = {},
) {
  const respond = vi.fn();
  const nodeRegistry = createContext(invokeResult, connectedNodes);
  await expectDefined(
    browserHandlers["browser.request"],
    "browser request handler",
  )({
    params,
    respond: respond as never,
    context: { nodeRegistry } as never,
    client: null,
    req: { type: "req", id: "req-1", method: "browser.request" },
    isWebchatConnect: () => false,
    ...requester,
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

  function requesterClient(
    connectionSignal: AbortSignal,
  ): NonNullable<Parameters<GatewayRequestHandlers[string]>[0]["client"]> {
    return {
      connId: "requester-1",
      connectionSignal,
      connect: {
        minProtocol: 3,
        maxProtocol: 3,
        client: { id: "test", version: "1", platform: "test", mode: "test" },
      },
    };
  }

  it("invalidates dispatched requester authority immediately before the Gateway close handshake finishes", async () => {
    const connection = new AbortController();
    const client = requesterClient(connection.signal);
    startBrowserControlServiceFromConfigMock.mockResolvedValueOnce(true);
    dispatchBrowserRouteMock.mockResolvedValueOnce({ status: 200, body: {} });
    await runBrowserRequest(
      { method: "POST", path: "/screencast", target: "host" },
      undefined,
      [],
      {
        client,
      },
    );
    const dispatched = dispatchBrowserRouteMock.mock.calls[0]?.[0];
    expect(dispatched.requester).toMatchObject({
      connId: "requester-1",
      signal: connection.signal,
    });
    expect(dispatched.requester.signal.aborted).toBe(false);
    expect(dispatched.requester.isCurrent()).toBe(true);
    client.invalidated = true;
    expect(dispatched.requester.isCurrent()).toBe(false);
    expect(dispatched.requester.signal.aborted).toBe(false);
    connection.abort();
    expect(dispatched.requester.signal.aborted).toBe(true);
  });

  it.each(["connection closed", "authority revoked"])(
    "dispatches a requester without current authority when %s",
    async (reason) => {
      const connection = new AbortController();
      if (reason === "connection closed") {
        connection.abort();
      }
      startBrowserControlServiceFromConfigMock.mockResolvedValueOnce(true);
      dispatchBrowserRouteMock.mockResolvedValueOnce({ status: 200, body: {} });
      await runBrowserRequest(
        { method: "POST", path: "/screencast", target: "host", timeoutMs: 1000 },
        undefined,
        [],
        {
          client: requesterClient(connection.signal),
          hasCurrentClientAuthority: () => reason !== "authority revoked",
        },
      );
      const requester = dispatchBrowserRouteMock.mock.calls[0]?.[0].requester;
      expect(requester.signal).toBe(connection.signal);
      expect(requester.isCurrent()).toBe(false);
    },
  );

  it.each([undefined, "node"] as const)(
    "rejects screencast on the %s node route before invoking the node",
    async (target) => {
      const { respond, nodeRegistry } = await runBrowserRequest({
        method: "POST",
        path: "/screencast",
        target,
        ...(target === "node" ? { node: "node-1" } : {}),
      });

      expect(firstRespondCall(respond)).toEqual([
        false,
        undefined,
        {
          code: "INVALID_REQUEST",
          message: "browser screencast is not available over a node proxy",
          details: { code: "SCREENCAST_UNSUPPORTED", reason: "node" },
        },
      ]);
      expect(nodeRegistry.invoke).not.toHaveBeenCalled();
      expect(uploadMocks.prepareBrowserProxyUploadRequest).not.toHaveBeenCalled();
      expect(startBrowserControlServiceFromConfigMock).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "host", "node"] as const)(
    "dispatches the requested %s execution host while preserving the profile",
    async (target) => {
      startBrowserControlServiceFromConfigMock.mockResolvedValueOnce(true);
      dispatchBrowserRouteMock.mockResolvedValueOnce({
        status: 200,
        body: { targetId: "host-tab" },
      });
      const { respond, nodeRegistry } = await runBrowserRequest(
        {
          method: "POST",
          path: "/tabs/focus",
          target,
          query: { profile: "work" },
          body: { targetId: "same-tab" },
        },
        { ok: true, payload: { result: { targetId: "node-tab" } } },
      );
      expect(firstRespondCall(respond)).toEqual([
        true,
        { targetId: target === "host" ? "host-tab" : "node-tab" },
      ]);
      if (target === "host") {
        expect(nodeRegistry.invoke).not.toHaveBeenCalled();
        expect(nodeRegistry.listConnected).not.toHaveBeenCalled();
        expect(dispatchBrowserRouteMock).toHaveBeenCalledWith({
          method: "POST",
          path: "/tabs/focus",
          query: { profile: "work" },
          body: { targetId: "same-tab" },
        });
      } else {
        expect(invokeParams(nodeRegistry)).toMatchObject({
          nodeId: "node-1",
          params: { profile: "work" },
        });
        expect(startBrowserControlServiceFromConfigMock).not.toHaveBeenCalled();
      }
    },
  );

  it("resolves an explicit node selector instead of the configured node", async () => {
    loadConfigMock.mockReturnValue({
      gateway: { nodes: { browser: { mode: "manual", node: "other" } } },
    });
    const { respond, nodeRegistry } = await runBrowserRequest(
      { method: "GET", path: "/tabs", target: "node", node: "Selected Node" },
      undefined,
      ["other", "selected"].map((nodeId) => ({
        nodeId,
        displayName: nodeId === "selected" ? "Selected Node" : "Other",
        caps: ["browser"],
        commands: ["browser.proxy"],
      })),
    );
    expect(invokeParams(nodeRegistry).nodeId).toBe("selected");
    expect(firstRespondCall(respond)[0]).toBe(true);
  });

  it.each([
    { target: "sandbox" },
    { target: 1 },
    { target: "host", node: "node-1" },
    { node: "node-1" },
    { target: "node", node: " " },
    { target: "node", node: 1 },
    { target: "node", node: "n".repeat(257) },
  ])("rejects invalid route identity %j before dispatch", async (route) => {
    const { respond, nodeRegistry } = await runBrowserRequest({
      method: "GET",
      path: "/tabs",
      ...route,
    });
    expect(firstRespondCall(respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    ]);
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(startBrowserControlServiceFromConfigMock).not.toHaveBeenCalled();
  });

  it.each([
    { method: "GET", path: "/system-profiles" },
    { method: "POST", path: "/profiles/import" },
  ])("rejects explicit node routing for host-only $path", async (request) => {
    const { respond, nodeRegistry } = await runBrowserRequest({ ...request, target: "node" });
    expect(firstRespondCall(respond)).toEqual([
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    ]);
    expect(nodeRegistry.invoke).not.toHaveBeenCalled();
    expect(startBrowserControlServiceFromConfigMock).not.toHaveBeenCalled();
  });

  it.each([
    "unavailable host",
    "missing node",
    "unsupported upload",
    "disabled policy",
    "denied command",
  ])("never retargets explicit node requests after %s", async (failure) => {
    if (failure === "disabled policy") {
      loadConfigMock.mockReturnValue({ gateway: { nodes: { browser: { mode: "off" } } } });
    }
    if (failure === "denied command") {
      isNodeCommandAllowedMock.mockReturnValueOnce({ ok: false, reason: "not in allowlist" });
    }
    const { respond } = await runBrowserRequest(
      failure === "unsupported upload"
        ? {
            method: "POST",
            path: "/hooks/file-chooser",
            target: "node",
            body: { paths: ["/tmp/openclaw/uploads/report.txt"] },
          }
        : { method: "GET", path: "/tabs", target: "node" },
      {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Browser control host is not reachable on 127.0.0.1:18791.",
        },
      },
      failure === "missing node"
        ? []
        : [{ nodeId: "node-1", caps: ["browser"], commands: ["browser.proxy"] }],
    );
    expect(firstRespondCall(respond)[0]).toBe(false);
    expect(startBrowserControlServiceFromConfigMock).not.toHaveBeenCalled();
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
