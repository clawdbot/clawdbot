/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ApplicationContext,
  ApplicationGateway,
  ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { deviceSystemInfo } from "../../test-helpers/devices-fixtures.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { settleLitElement } from "../../test-helpers/lit-settle.ts";
import { ConnectionPage } from "./connection-page.ts";
import { supportsSystemInfo } from "./system-info.ts";

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

function editInput(page: ConnectionPage, label: string, value: string) {
  const input = control(page, `input[aria-label="${label}"]`);
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

describe("ConnectionPage credentials", () => {
  it("re-scopes credentials when the Gateway URL changes", async () => {
    const current = source({
      request: vi.fn().mockResolvedValue(deviceSystemInfo),
    } as unknown as GatewayBrowserClient);
    Object.assign(current.gateway.connection, {
      gatewayUrl: "wss://gateway.example/openclaw",
      token: "old-token",
      password: "old-password",
    });
    const connect = vi.spyOn(current.gateway, "connect");
    const { page } = await mount(current.gateway);

    editInput(page, "Gateway URL", "wss://other-gateway.example/openclaw");
    await settleLitElement(page);
    expect(control(page, 'input[aria-label="Gateway secret"]').value).toBe("");
    control(page, "button.btn.primary").click();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayUrl: "wss://other-gateway.example/openclaw",
        token: "",
        password: "",
      }),
    );
  });

  it.each([
    { token: "saved-token", password: "saved-password", displayed: "saved-token" },
    { token: "", password: "injected-password", displayed: "injected-password" },
  ])(
    "replaces the displayed secret without retaining a hidden credential: $displayed",
    async ({ token, password, displayed }) => {
      const current = source({
        request: vi.fn().mockResolvedValue(deviceSystemInfo),
      } as unknown as GatewayBrowserClient);
      Object.assign(current.gateway.connection, { token, password });
      const connect = vi.spyOn(current.gateway, "connect");
      const { page } = await mount(current.gateway);
      const secret = () => control(page, 'input[aria-label="Gateway secret"]');
      expect(page.querySelectorAll(".settings-secret input")).toHaveLength(1);
      expect(secret().value).toBe(displayed);
      expect(page.querySelector('[role="radiogroup"]')).toBeNull();
      control(page, ".settings-row__control > button.btn").click();
      expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({ token, password }));

      editInput(page, "Gateway secret", "");
      await settleLitElement(page);
      expect(secret().value).toBe("");
      editInput(page, "Gateway secret", "edited-secret");
      await settleLitElement(page);
      control(page, "button.btn.primary").click();
      expect(connect).toHaveBeenLastCalledWith(
        expect.objectContaining({ token: "edited-secret", password: "" }),
      );
    },
  );

  it("highlights Connect and shows the unsaved hint only while the draft differs", async () => {
    const current = source({
      request: vi.fn().mockResolvedValue(deviceSystemInfo),
    } as unknown as GatewayBrowserClient);
    const { page } = await mount(current.gateway);
    const actions = () => [
      ...page.querySelectorAll<HTMLButtonElement>(".settings-row__control > button.btn"),
    ];
    const connectButton = () => control(page, ".settings-row__control > button.btn");
    const hint = "Unsaved changes apply when you connect.";
    expect(actions().map((button) => button.textContent?.trim())).toEqual(["Connect"]);
    expect(connectButton().className).toBe("btn");
    expect(page.textContent).not.toContain(hint);
    editInput(page, "Gateway secret", "draft-token");
    await settleLitElement(page);
    expect(connectButton().className).toBe("btn primary");
    expect(page.textContent).toContain(hint);
    editInput(page, "Gateway secret", "");
    await settleLitElement(page);
    expect(connectButton().className).toBe("btn");
    expect(page.textContent).not.toContain(hint);
    editInput(page, "Default session", "draft-session");
    await settleLitElement(page);
    expect(connectButton().className).toBe("btn primary");
    expect(page.textContent).toContain(hint);
  });
});

describe("ConnectionPage Gateway lifecycle", () => {
  it("keeps an edited draft through reconnect and resets it for a replacement source", async () => {
    const request = vi.fn().mockResolvedValue(deviceSystemInfo);
    const client = { request } as unknown as GatewayBrowserClient;
    const first = source(client);
    const { page, context, provider } = await mount(first.gateway);
    const input = (label: string) => control(page, `input[aria-label="${label}"]`);
    editInput(page, "Gateway secret", "draft-secret");
    editInput(page, "Default session", "draft-session");
    control(page, 'button[aria-label="Toggle secret visibility"]').click();
    await settleLitElement(page);
    expect(input("Gateway secret").type).toBe("text");

    first.publish({ ...first.gateway.snapshot, phase: "reconnecting" });
    await settleLitElement(page);
    expect(input("Gateway secret").type).toBe("password");
    expect(page.querySelector(".config-host__name")?.textContent?.trim()).toBe("—");
    first.publish({ ...first.gateway.snapshot, phase: "connected", sessionKey: "remote-session" });
    await settleLitElement(page);
    expect(input("Gateway secret").value).toBe("draft-secret");
    expect(input("Default session").value).toBe("draft-session");
    expect(input("Gateway secret").type).toBe("password");
    expect(request).toHaveBeenCalledTimes(2);

    const second = source(client);
    Object.assign(second.gateway.connection, {
      token: "replacement-token",
      password: "replacement-password",
    });
    provider.setContext({ ...context, gateway: second.gateway });
    await settleLitElement(page);
    expect(input("Gateway secret").value).toBe("replacement-token");
    expect(input("Default session").value).toBe("main");
    expect(input("Gateway secret").type).toBe("password");
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
