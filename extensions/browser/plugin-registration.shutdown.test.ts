import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserPlugin } from "./plugin-registration.js";

const runtimeMocks = vi.hoisted(() => ({
  handleGatewayExtensionUpgrade: vi.fn(async () => true),
  stopBrowserControlService: vi.fn(async () => undefined),
}));

vi.mock("./register.runtime.js", () => ({
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

function registerLifecycleCallbacks() {
  let route: Parameters<OpenClawPluginApi["registerHttpRoute"]>[0] | undefined;
  let service: OpenClawPluginService | undefined;
  registerBrowserPlugin(
    createTestPluginApi({
      runtime: {
        state: { openKeyedStore: vi.fn() },
      } as never,
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
  return { handleUpgrade: route.handleUpgrade, stop: service.stop };
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
});
