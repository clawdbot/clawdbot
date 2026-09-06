/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { loadSettings } from "../../app/settings.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { deviceSystemInfo } from "../../test-helpers/devices-fixtures.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { settleLitElement } from "../../test-helpers/lit-settle.ts";
import { ConnectionPage, supportsSystemInfo } from "./connection-page.ts";

function source(client: GatewayBrowserClient) {
  return createApplicationGateway({
    client,
    phase: "connected",
    hello: gatewayHelloForMethods(["system.info"]),
    sessionKey: "main",
  } as ApplicationGatewaySnapshot);
}

async function mount(gateway: ApplicationGateway) {
  const page = new ConnectionPage();
  const context = {
    gateway,
    channels: { state: { channelsLastSuccess: null }, subscribe: () => () => undefined },
  } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  provider.append(page);
  document.body.append(provider);
  await settleLitElement(page);
  return { page, context, provider };
}

function control(page: ConnectionPage, selector: string) {
  const element = page.querySelector<HTMLInputElement | HTMLButtonElement>(selector);
  if (!element) {
    throw new Error(`Missing Connection control: ${selector}`);
  }
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("supportsSystemInfo", () => {
  it("requires the Gateway to advertise system.info", () => {
    const hello = {
      features: { methods: ["health", "system.info"] },
    } as ApplicationGatewaySnapshot["hello"];
    const unsupportedHello = {
      features: { methods: ["health"] },
    } as ApplicationGatewaySnapshot["hello"];

    expect(supportsSystemInfo(hello)).toBe(true);
    expect(supportsSystemInfo(unsupportedHello)).toBe(false);
    expect(supportsSystemInfo(null)).toBe(false);
  });
});

describe("ConnectionPage credentials", () => {
  it("re-scopes credentials when the Gateway URL changes", () => {
    const page = new ConnectionPage();
    const state = page as unknown as {
      settings: ReturnType<typeof loadSettings>;
      password: string;
      context: ApplicationContext;
      render: () => ReturnType<ConnectionPage["render"]>;
    };
    state.settings = {
      ...loadSettings(),
      gatewayUrl: "wss://gateway.example/openclaw",
      token: "old-token",
    };
    state.password = "old-password";
    state.context = {
      gateway: { snapshot: { phase: "stopped", hello: null, lastError: null } },
      channels: { state: { channelsLastSuccess: null } },
    } as unknown as ApplicationContext;
    const container = document.createElement("div");
    render(state.render(), container);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="WebSocket URL"]');
    if (!input) {
      throw new Error("expected Gateway URL input");
    }

    input.value = "wss://other-gateway.example/openclaw";
    input.dispatchEvent(new Event("input"));

    expect(state.settings.token).toBe("");
    expect(state.password).toBe("");
  });
});

describe("ConnectionPage Gateway lifecycle", () => {
  it("keeps an edited draft through reconnect and resets it for a replacement source", async () => {
    const request = vi.fn().mockResolvedValue(deviceSystemInfo);
    const client = { request } as unknown as GatewayBrowserClient;
    const first = source(client);
    const { page, context, provider } = await mount(first.gateway);
    const input = (label: string) => control(page, `input[aria-label="${label}"]`);
    const edit = (label: string, value: string) => {
      input(label).value = value;
      input(label).dispatchEvent(new Event("input"));
    };
    edit("Gateway Token", "draft-token");
    edit("Password (not stored)", "draft-password");
    edit("Default Session Key", "draft-session");
    control(page, 'button[aria-label="Toggle token visibility"]').click();
    control(page, 'button[aria-label="Toggle password visibility"]').click();
    await settleLitElement(page);
    expect(input("Gateway Token").type).toBe("text");
    expect(input("Password (not stored)").type).toBe("text");

    first.publish({ ...first.gateway.snapshot, phase: "reconnecting" });
    await settleLitElement(page);
    expect(input("Gateway Token").type).toBe("password");
    expect(input("Password (not stored)").type).toBe("password");
    expect(page.querySelector(".config-host__name")?.textContent?.trim()).toBe("—");
    first.publish({ ...first.gateway.snapshot, phase: "connected", sessionKey: "remote-session" });
    await settleLitElement(page);
    expect(input("Gateway Token").value).toBe("draft-token");
    expect(input("Password (not stored)").value).toBe("draft-password");
    expect(input("Default Session Key").value).toBe("draft-session");
    expect(request).toHaveBeenCalledTimes(2);

    const second = source(client);
    Object.assign(second.gateway.connection, {
      token: "replacement-token",
      password: "replacement-password",
    });
    provider.setContext({ ...context, gateway: second.gateway });
    await settleLitElement(page);
    expect(input("Gateway Token").value).toBe("replacement-token");
    expect(input("Password (not stored)").value).toBe("replacement-password");
    expect(input("Default Session Key").value).toBe("main");
    expect(input("Gateway Token").type).toBe("password");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it.each(["response", "error", "response before rebinding"] as const)(
    "rejects an old Gateway source %s when the replacement reuses its client",
    async (outcome) => {
      vi.useFakeTimers();
      const firstResponse = deferred<SystemInfoResult>();
      const secondResponse = deferred<SystemInfoResult>();
      const request = vi
        .fn()
        .mockReturnValueOnce(firstResponse.promise)
        .mockReturnValueOnce(secondResponse.promise);
      const client = { request } as unknown as GatewayBrowserClient;
      const first = source(client);
      const second = source(client);
      const { page, context, provider } = await mount(first.gateway);
      if (outcome === "response before rebinding") {
        // Queue completion before Lit's update, while context replacement itself is synchronous.
        firstResponse.resolve({ ...deviceSystemInfo, machineName: "Stale" });
      }
      provider.setContext({ ...context, gateway: second.gateway });
      await settleLitElement(page);
      expect(request).toHaveBeenCalledTimes(2);

      if (outcome === "response") {
        firstResponse.resolve({ ...deviceSystemInfo, machineName: "Stale" });
      } else if (outcome === "error") {
        firstResponse.reject(
          new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "unknown method: system.info",
          }),
        );
      }
      await settleLitElement(page);
      expect(page.querySelector(".config-host__name")?.textContent?.trim()).toBe("—");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(request).toHaveBeenCalledTimes(2);

      secondResponse.resolve({ ...deviceSystemInfo, machineName: "Current" });
      await settleLitElement(page);
      expect(page.querySelector(".config-host__name")?.textContent?.trim()).toBe("Current");
    },
  );

  it.each([
    ["transient", new Error("temporarily unavailable"), true],
    [
      "unknown method",
      new GatewayRequestError({ code: "INVALID_REQUEST", message: "unknown method: system.info" }),
      false,
    ],
    [
      "missing read scope",
      new GatewayRequestError({
        code: "FORBIDDEN",
        message: "permission denied",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.read",
          requiredScopes: ["operator.read"],
        },
      }),
      false,
    ],
  ] as const)("preserves the polling policy after a %s error", async (_kind, error, retry) => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(deviceSystemInfo)
      .mockRejectedValueOnce(error)
      .mockResolvedValue(deviceSystemInfo);
    const { page } = await mount(source({ request } as unknown as GatewayBrowserClient).gateway);
    await vi.advanceTimersByTimeAsync(10_000);
    await settleLitElement(page);
    expect(page.querySelector(".config-host__name")?.textContent?.trim() ?? null).toBe(
      retry ? "Gateway" : null,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(retry ? 3 : 2);
  });

  it("retires a pending host read when its method advertisement disappears", async () => {
    const response = deferred<SystemInfoResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(response.promise)
      .mockResolvedValue(deviceSystemInfo);
    const current = source({ request } as unknown as GatewayBrowserClient);
    const { page } = await mount(current.gateway);
    current.publish({
      ...current.gateway.snapshot,
      hello: gatewayHelloForMethods([]),
    });
    response.resolve(deviceSystemInfo);
    await settleLitElement(page);
    expect(page.querySelector(".config-host__name")).toBeNull();
    current.publish({
      ...current.gateway.snapshot,
      hello: gatewayHelloForMethods(["system.info"]),
    });
    await settleLitElement(page);
    expect(page.querySelector(".config-host__name")?.textContent?.trim()).toBe("Gateway");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
