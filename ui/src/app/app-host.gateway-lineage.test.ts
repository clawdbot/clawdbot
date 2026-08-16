/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GatewayBrowserClient,
  GatewayBrowserClientOptions,
  GatewayHelloOk,
} from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import "./app-host.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext, ApplicationGateway } from "./context.ts";
import { createApplicationGateway } from "./gateway-store.ts";
import { loadSettings } from "./settings.ts";

const HELLO: GatewayHelloOk = {
  type: "hello-ok",
  protocol: 1,
  auth: { role: "operator", scopes: [] },
};

function createGatewayHarness() {
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  const clients: Array<{ opts: GatewayBrowserClientOptions }> = [];
  const gateway = createApplicationGateway(loadSettings(), "", "", (opts) => {
    const client = {
      opts,
      instanceId: opts.instanceId,
      start: vi.fn(),
      stop: vi.fn(),
      request: vi.fn(),
    };
    clients.push(client);
    return client as unknown as GatewayBrowserClient;
  });
  return { gateway, clients };
}

function renderGatewaySurface(gateway: ApplicationGateway): string {
  const app = document.createElement("openclaw-app") as unknown as {
    runtime: Pick<ApplicationRuntime, "context" | "documentMode">;
    render: () => { strings: readonly string[] };
    synchronizeGateway: (gateway: ApplicationGateway) => void;
  };
  app.runtime = {
    documentMode: null,
    context: {
      gateway,
      basePath: "",
      config: { current: { terminalEnabled: false } },
    } as unknown as ApplicationContext,
  };
  app.synchronizeGateway(gateway);
  const container = document.createElement("div");
  render(app.render(), container);
  return container.innerHTML;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Control UI Gateway target lineage", () => {
  it("returns to the login gate when a newly selected Gateway's first attempt fails", () => {
    const { gateway, clients } = createGatewayHarness();
    gateway.start();
    clients[0]?.opts.onHello?.(HELLO);
    gateway.connect({ gatewayUrl: "wss://other-gateway.example.test" });
    clients[1]?.opts.onClose?.({ code: 1006, reason: "remote refused", willRetry: true });

    const surface = renderGatewaySurface(gateway);

    expect(surface).toContain("<openclaw-login-gate");
    expect(surface).not.toContain("<openclaw-app-shell");
  });

  it("keeps retryable Gateway startup on the initial progress surface", () => {
    const { gateway, clients } = createGatewayHarness();
    gateway.start();
    clients[0]?.opts.onClose?.({
      code: 4013,
      reason: "gateway starting",
      willRetry: true,
      error: {
        code: "UNAVAILABLE",
        message: "gateway starting; retry shortly",
        details: { reason: "startup-sidecars" },
        retryable: true,
        retryAfterMs: 250,
      },
    });

    const surface = renderGatewaySurface(gateway);

    expect(gateway.snapshot.phase).toBe("starting");
    expect(surface).toContain('class="connect-splash"');
    expect(surface).toContain("Gateway starting…");
    expect(surface).not.toContain("<openclaw-login-gate");
  });

  it("keeps an established Gateway's dashboard mounted during its own retry", () => {
    const { gateway, clients } = createGatewayHarness();
    gateway.start();
    clients[0]?.opts.onHello?.(HELLO);
    clients[0]?.opts.onClose?.({ code: 1006, reason: "same gateway blip", willRetry: true });

    const surface = renderGatewaySurface(gateway);

    expect(surface).toContain("<openclaw-app-shell");
    expect(surface).not.toContain("<openclaw-login-gate");
  });

  it("retains a replacement Gateway's dashboard after its own successful hello", () => {
    const { gateway, clients } = createGatewayHarness();
    gateway.start();
    clients[0]?.opts.onHello?.(HELLO);
    gateway.connect({ gatewayUrl: "wss://other-gateway.example.test" });
    clients[1]?.opts.onHello?.(HELLO);
    clients[1]?.opts.onClose?.({ code: 1006, reason: "replacement blip", willRetry: true });

    const surface = renderGatewaySurface(gateway);

    expect(surface).toContain("<openclaw-app-shell");
    expect(surface).not.toContain("<openclaw-login-gate");
  });
});
