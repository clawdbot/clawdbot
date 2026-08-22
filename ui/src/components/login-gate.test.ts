/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import "./login-gate.ts";

type LoginGateElement = HTMLElement & {
  props: Record<string, unknown>;
  updateComplete: Promise<boolean>;
};

async function mountFailure(lastError: string, lastErrorCode: string | null) {
  const element = document.createElement("openclaw-login-gate") as LoginGateElement;
  element.props = {
    resourceBasePath: "",
    connected: false,
    lastError,
    lastErrorCode,
    hasToken: false,
    hasPassword: false,
    gatewayUrl: "ws://127.0.0.1:18789",
    token: "",
    password: "",
    showGatewayToken: false,
    showGatewayPassword: false,
    onGatewayUrlChange: vi.fn(),
    onTokenChange: vi.fn(),
    onPasswordChange: vi.fn(),
    onToggleGatewayToken: vi.fn(),
    onToggleGatewayPassword: vi.fn(),
    onConnect: vi.fn(),
  };
  document.body.append(element);
  await element.updateComplete;
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "execCommand");
});

describe("login gate failure recovery", () => {
  it("offers page refresh for a protocol mismatch and reloads when selected", async () => {
    const element = await mountFailure(
      "protocol mismatch",
      ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
    );
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });

    const failure = element.querySelector<HTMLElement>(
      '.login-gate__failure[data-kind="protocol-mismatch"]',
    );
    const refresh = failure?.querySelector<HTMLButtonElement>(".login-gate__failure-refresh");

    expect(refresh?.textContent?.trim()).toBe("Refresh page");
    expect(failure?.querySelector(".login-gate__failure-steps")).not.toBeNull();
    expect(failure?.querySelector(".login-gate__failure-docs")).not.toBeNull();

    refresh?.click();
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "auth-required",
      "unauthorized: gateway token required",
      ConnectErrorDetailCodes.AUTH_REQUIRED,
    ],
    ["network", "WebSocket connection failed", null],
    [
      "insecure-context",
      "device identity required",
      ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
    ],
  ])("does not offer page refresh for %s failures", async (kind, error, code) => {
    const element = await mountFailure(error, code);

    expect(element.querySelector(".login-gate__failure")?.getAttribute("data-kind")).toBe(kind);
    expect(element.querySelector(".login-gate__failure-refresh")).toBeNull();
  });

  it("offers a one-command recovery before manual pairing approval", async () => {
    const element = await mountFailure(
      "pairing required",
      ConnectErrorDetailCodes.PAIRING_REQUIRED,
    );

    const steps = Array.from(
      element.querySelectorAll<HTMLElement>(".login-gate__failure-steps li"),
      (entry) => entry.textContent?.trim(),
    );
    expect(steps).toEqual([
      "On the Gateway host, run openclaw dashboard to open a secure one-time pairing link.",
      "Run openclaw devices list on the Gateway host.",
      "Approve the pending browser/device request from that list.",
      "Reconnect after the approval completes.",
    ]);
  });

  it("offers only supported recovery for an insecure browser context", async () => {
    const element = await mountFailure(
      "device identity required",
      ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
    );

    const steps = Array.from(
      element.querySelectorAll<HTMLElement>(".login-gate__failure-steps li"),
      (entry) => entry.textContent?.trim(),
    );
    expect(steps).toEqual([
      "Use HTTPS/Tailscale Serve, or open http://127.0.0.1:18789 on the Gateway host.",
      "Do not use a remote plain-HTTP URL; a token or password cannot replace browser device identity.",
    ]);
  });

  it.each(["click", "Enter", " ", "nested button"])(
    "surfaces denied gateway-command copying from the %s interaction",
    async (interaction) => {
      const writeText = vi.fn().mockRejectedValue(new DOMException("Clipboard access denied"));
      const execCommand = vi.fn(() => false);
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
      const element = await mountFailure("WebSocket connection failed", null);
      const command = element.querySelector<HTMLElement>(".login-gate__command");
      const button = command?.querySelector<HTMLButtonElement>(".chat-copy-btn");

      if (interaction === "nested button") {
        button?.click();
      } else if (interaction === "click") {
        command?.click();
      } else {
        command?.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: interaction }),
        );
      }

      await vi.waitFor(() => expect(button?.getAttribute("aria-label")).toBe("Copy failed"));
      expect(button?.dataset.error).toBe("1");
      expect(writeText).toHaveBeenCalledOnce();
      expect(execCommand).toHaveBeenCalledOnce();
    },
  );

  it("keeps the latest command-copy feedback until its own reset", async () => {
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("Clipboard access denied"))
      .mockResolvedValueOnce(undefined);
    const execCommand = vi.fn(() => false);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const schedule = vi.spyOn(window, "setTimeout");
    const element = await mountFailure("WebSocket connection failed", null);
    const command = element.querySelector<HTMLElement>(".login-gate__command");
    const button = command?.querySelector<HTMLButtonElement>(".chat-copy-btn");

    command?.click();
    await vi.waitFor(() => expect(button?.getAttribute("aria-label")).toBe("Copy failed"));
    const failedReset = schedule.mock.calls.find(([, delay]) => delay === 2_000)?.[0];
    if (typeof failedReset !== "function") {
      throw new Error("Expected the failed copy feedback to schedule its reset");
    }

    command?.click();
    await vi.waitFor(() => expect(button?.getAttribute("aria-label")).toBe("Copied!"));
    expect(button?.dataset.error).toBeUndefined();
    expect(button?.dataset.copied).toBe("1");

    failedReset();
    expect(button?.getAttribute("aria-label")).toBe("Copied!");
    expect(button?.dataset.copied).toBe("1");

    const successfulReset = schedule.mock.calls.find(([, delay]) => delay === 1_500)?.[0];
    if (typeof successfulReset !== "function") {
      throw new Error("Expected the successful copy feedback to schedule its reset");
    }
    successfulReset();

    expect(button?.getAttribute("aria-label")).toBe("Copy command");
    expect(button?.dataset.copied).toBeUndefined();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(execCommand).toHaveBeenCalledOnce();
  });
});
