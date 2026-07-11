// Browser tests cover browser request.profile from body plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  loadConfigMock,
  isNodeCommandAllowedMock,
  resolveNodeCommandAllowlistMock,
  startBrowserControlServiceFromConfigMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  isNodeCommandAllowedMock: vi.fn(),
  resolveNodeCommandAllowlistMock: vi.fn(),
  startBrowserControlServiceFromConfigMock: vi.fn(async () => false),
}));

vi.mock("../core-api.js", async () => {
  const actual = await vi.importActual<typeof import("../core-api.js")>("../core-api.js");
  return {
    ...actual,
    startBrowserControlServiceFromConfig: startBrowserControlServiceFromConfigMock,
  };
});

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
          commands: ["browser.proxy"],
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
) {
  const respond = vi.fn();
  const nodeRegistry = createContext(invokeResult, connectedNodes);
  await browserHandlers["browser.request"]({
    params,
    respond: respond as never,
    context: { nodeRegistry } as never,
    client: null,
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
    startBrowserControlServiceFromConfigMock.mockClear();
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
});
