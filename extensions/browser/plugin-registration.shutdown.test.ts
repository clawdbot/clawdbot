import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserPlugin } from "./plugin-registration.js";

type BrowserToolFactoryOptions = {
  browserOwnedGatewayRequest?: (params: Record<string, unknown>) => Promise<unknown>;
};

const runtimeMocks = vi.hoisted(() => ({
  createBrowserTool: vi.fn((_: BrowserToolFactoryOptions = {}) => ({
    execute: vi.fn(async () => ({ type: "json", value: { ok: true } })),
  })),
  handleGatewayExtensionUpgrade: vi.fn(async () => true),
  stopBrowserControlService: vi.fn(async () => undefined),
}));

vi.mock("./register.runtime.js", () => ({
  createBrowserTool: runtimeMocks.createBrowserTool,
  stopBrowserControlService: runtimeMocks.stopBrowserControlService,
}));

vi.mock("./src/browser/extension-relay/gateway-relay-route.js", () => ({
  handleGatewayExtensionUpgrade: runtimeMocks.handleGatewayExtensionUpgrade,
}));

vi.mock("./src/browser/session-tab-store.js", () => ({
  initializeBrowserSessionTabStore: vi.fn(),
}));

vi.mock("./src/browser/system-profile-import-state.js", () => ({
  configureSystemProfileImportStateStore: vi.fn(),
}));

function registerLifecycleCallbacks(gatewayRequest = vi.fn(async () => ({ status: "closed" }))) {
  let route: Parameters<OpenClawPluginApi["registerHttpRoute"]>[0] | undefined;
  let service: OpenClawPluginService | undefined;
  let toolFactory: Parameters<OpenClawPluginApi["registerTool"]>[0] | undefined;
  registerBrowserPlugin(
    createTestPluginApi({
      runtime: {
        state: { openKeyedStore: vi.fn() },
        gateway: { request: gatewayRequest },
      } as never,
      registerTool(value) {
        toolFactory = value;
      },
      registerHttpRoute(value) {
        route = value;
      },
      registerService(value) {
        service = value;
      },
    }),
  );
  if (!route?.handleUpgrade || !service?.stop) {
    throw new Error("expected browser relay route and service lifecycle");
  }
  if (!toolFactory) {
    throw new Error("expected Browser tool factory");
  }
  return { handleUpgrade: route.handleUpgrade, stop: service.stop, toolFactory };
}

describe("browser relay shutdown registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps shutdown lazy until direct relay activity prepares teardown", async () => {
    const coldLifecycle = registerLifecycleCallbacks();

    await coldLifecycle.stop({} as never);

    expect(runtimeMocks.stopBrowserControlService).not.toHaveBeenCalled();

    const { handleUpgrade, stop } = registerLifecycleCallbacks();
    const req = {} as IncomingMessage;
    const socket = {} as Duplex;
    const head = Buffer.alloc(0);

    await expect(handleUpgrade(req, socket, head)).resolves.toBe(true);
    await stop({} as never);

    expect(runtimeMocks.handleGatewayExtensionUpgrade).toHaveBeenCalledWith(req, socket, head);
    expect(runtimeMocks.stopBrowserControlService).toHaveBeenCalledOnce();
  });

  it("does not issue retained cleanup requests after the Browser provider retires", async () => {
    const gatewayRequest = vi.fn(async () => ({ status: "closed" }));
    const callbacks = registerLifecycleCallbacks(gatewayRequest);
    if (typeof callbacks.toolFactory !== "function") {
      throw new Error("expected Browser tool factory function");
    }
    const createdTool = callbacks.toolFactory({} as never);
    const tool = Array.isArray(createdTool) ? createdTool[0] : createdTool;
    if (!tool) {
      throw new Error("expected Browser tool");
    }
    await tool.execute?.("call-1", { action: "tabs" }, new AbortController().signal);
    const request = runtimeMocks.createBrowserTool.mock.calls.at(-1)?.[0]
      ?.browserOwnedGatewayRequest as
      | ((params: Record<string, unknown>) => Promise<unknown>)
      | undefined;
    if (!request) {
      throw new Error("expected Browser-owned Gateway request callback");
    }

    await expect(
      request({
        method: "DELETE",
        path: "/tabs/tab-1",
        nodeId: "node-1",
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ status: "closed" });
    await callbacks.stop({} as never);

    await expect(
      request({
        method: "DELETE",
        path: "/tabs/tab-2",
        nodeId: "node-1",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("Browser plugin lifecycle is no longer active");
    expect(gatewayRequest).toHaveBeenCalledOnce();
  });
});
