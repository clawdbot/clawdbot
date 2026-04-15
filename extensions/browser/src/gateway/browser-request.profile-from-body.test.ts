import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfigMock, isNodeCommandAllowedMock, resolveNodeCommandAllowlistMock } = vi.hoisted(
  () => ({
    loadConfigMock: vi.fn(),
    isNodeCommandAllowedMock: vi.fn(),
    resolveNodeCommandAllowlistMock: vi.fn(),
  }),
);

vi.mock("openclaw/plugin-sdk/config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/config-runtime")>(
    "openclaw/plugin-sdk/config-runtime",
  );
  return {
    ...actual,
    loadConfig: loadConfigMock,
  };
});

vi.mock("../../../../src/gateway/node-command-policy.js", () => ({
  isNodeCommandAllowed: isNodeCommandAllowedMock,
  resolveNodeCommandAllowlist: resolveNodeCommandAllowlistMock,
}));

import { browserHandlers } from "./browser-request.js";

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createContext() {
  const invoke = vi.fn(async () => ({
    ok: true,
    payload: {
      result: { ok: true },
    },
  }));
  const listConnected = vi.fn(() => [
    {
      nodeId: "node-1",
      caps: ["browser"],
      commands: ["browser.proxy"],
      platform: "linux",
    },
  ]);
  return {
    invoke,
    listConnected,
  };
}

async function runBrowserRequest(params: Record<string, unknown>) {
  const respond = vi.fn();
  const nodeRegistry = createContext();
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

describe("browser.request profile selection", () => {
  beforeEach(() => {
    loadConfigMock.mockReturnValue({
      gateway: { nodes: { browser: { mode: "auto" } } },
    });
    resolveNodeCommandAllowlistMock.mockReturnValue([]);
    isNodeCommandAllowedMock.mockReturnValue({ ok: true });
  });

  it("uses profile from request body when query profile is missing", async () => {
    const { respond, nodeRegistry } = await runBrowserRequest({
      method: "POST",
      path: "/act",
      body: { profile: "work", request: { action: "click", ref: "btn1" } },
    });

    expect(nodeRegistry.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "browser.proxy",
        params: expect.objectContaining({
          profile: "work",
        }),
      }),
    );
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
  });

  it("prefers query profile over body profile when both are present", async () => {
    const { nodeRegistry } = await runBrowserRequest({
      method: "POST",
      path: "/act",
      query: { profile: "chrome" },
      body: { profile: "work", request: { action: "click", ref: "btn1" } },
    });

    expect(nodeRegistry.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          profile: "chrome",
        }),
      }),
    );
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
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "browser.request cannot mutate persistent browser profiles",
      }),
    );
  });

  it("allows non-mutating profile reads", async () => {
    const { respond, nodeRegistry } = await runBrowserRequest({
      method: "GET",
      path: "/profiles",
    });

    expect(nodeRegistry.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "browser.proxy",
        params: expect.objectContaining({
          method: "GET",
          path: "/profiles",
        }),
      }),
    );
    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(true);
  });
});
