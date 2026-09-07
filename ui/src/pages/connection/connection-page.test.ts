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

async function selectCredentialMode(page: ConnectionPage, mode: "Token" | "Password") {
  const button = [...page.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (candidate) => candidate.textContent?.trim() === mode,
  );
  if (!button) {
    throw new Error(`Missing credential mode: ${mode}`);
  }
  button.click();
  await settleLitElement(page);
  expect(button.getAttribute("aria-checked")).toBe("true");
}

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
    expect(control(page, 'input[aria-label="Credential"]').value).toBe("");
    await selectCredentialMode(page, "Password");
    expect(control(page, 'input[aria-label="Credential"]').value).toBe("");
    control(page, "button.btn.primary").click();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayUrl: "wss://other-gateway.example/openclaw",
        token: "",
        password: "",
      }),
    );
  });

  it("switches which credential the single input edits and pins the mode when cleared", async () => {
    const current = source({
      request: vi.fn().mockResolvedValue(deviceSystemInfo),
    } as unknown as GatewayBrowserClient);
    Object.assign(current.gateway.connection, { token: "saved-token", password: "saved-password" });
    const connect = vi.spyOn(current.gateway, "connect");
    const { page } = await mount(current.gateway);
    const credential = () => control(page, 'input[aria-label="Credential"]');
    expect(page.querySelectorAll(".connection-credential input")).toHaveLength(1);
    expect(credential().value).toBe("saved-token");
    editInput(page, "Credential", "");
    await settleLitElement(page);
    expect(page.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.trim()).toBe(
      "Token",
    );
    expect(credential().value).toBe("");
    editInput(page, "Credential", "edited-token");
    await selectCredentialMode(page, "Password");
    expect(credential().value).toBe("saved-password");
    editInput(page, "Credential", "edited-password");
    await selectCredentialMode(page, "Token");
    expect(credential().value).toBe("edited-token");
    await selectCredentialMode(page, "Password");
    expect(credential().value).toBe("edited-password");
    control(page, "button.btn.primary").click();
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ token: "edited-token", password: "edited-password" }),
    );
  });

  it.each(["AUTH_PASSWORD_MISSING", "AUTH_PASSWORD_MISMATCH", "AUTH_PASSWORD_NOT_CONFIGURED"])(
    "selects Password for %s unless the operator chooses Token",
    async (lastErrorCode) => {
      const current = source({
        request: vi.fn().mockResolvedValue(deviceSystemInfo),
      } as unknown as GatewayBrowserClient);
      Object.assign(current.gateway.connection, {
        token: "saved-token",
        password: "saved-password",
      });
      current.publish({ ...current.gateway.snapshot, phase: "stopped", lastErrorCode });
      const { page } = await mount(current.gateway);
      expect(page.querySelector('[role="radio"][aria-checked="true"]')?.textContent?.trim()).toBe(
        "Password",
      );
      expect(control(page, 'input[aria-label="Credential"]').value).toBe("saved-password");
      await selectCredentialMode(page, "Token");
      expect(control(page, 'input[aria-label="Credential"]').value).toBe("saved-token");
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
    editInput(page, "Credential", "draft-token");
    await settleLitElement(page);
    expect(connectButton().className).toBe("btn primary");
    expect(page.textContent).toContain(hint);
    editInput(page, "Credential", "");
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
    editInput(page, "Credential", "draft-token");
    control(page, 'button[aria-label="Toggle token visibility"]').click();
    await settleLitElement(page);
    expect(input("Credential").type).toBe("text");
    await selectCredentialMode(page, "Password");
    editInput(page, "Credential", "draft-password");
    editInput(page, "Default session", "draft-session");
    control(page, 'button[aria-label="Toggle password visibility"]').click();
    await settleLitElement(page);
    expect(input("Credential").type).toBe("text");

    first.publish({ ...first.gateway.snapshot, phase: "reconnecting" });
    await settleLitElement(page);
    expect(input("Credential").type).toBe("password");
    expect(page.querySelector(".config-host__name")?.textContent?.trim()).toBe("—");
    first.publish({ ...first.gateway.snapshot, phase: "connected", sessionKey: "remote-session" });
    await settleLitElement(page);
    expect(input("Credential").value).toBe("draft-password");
    expect(input("Default session").value).toBe("draft-session");
    await selectCredentialMode(page, "Token");
    expect(input("Credential").value).toBe("draft-token");
    expect(input("Credential").type).toBe("password");
    await selectCredentialMode(page, "Password");
    expect(request).toHaveBeenCalledTimes(2);

    const second = source(client);
    Object.assign(second.gateway.connection, {
      token: "replacement-token",
      password: "replacement-password",
    });
    provider.setContext({ ...context, gateway: second.gateway });
    await settleLitElement(page);
    expect(input("Credential").value).toBe("replacement-token");
    expect(input("Default session").value).toBe("main");
    expect(input("Credential").type).toBe("password");
    await selectCredentialMode(page, "Password");
    expect(input("Credential").value).toBe("replacement-password");
    expect(input("Credential").type).toBe("password");
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
