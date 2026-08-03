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
    basePath: "",
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
});

describe("login gate connection command accessibility", () => {
  it("copies the command when its card background is clicked", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    const element = await mountFailure("connection refused", null);
    const command = element.querySelector<HTMLElement>(".login-gate__command");
    expect(command).toBeInstanceOf(HTMLElement);

    command!.click();

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledOnce();
      expect(writeText).toHaveBeenCalledWith("openclaw gateway run");
    });
  });

  it("keeps the command and its copy affordance as separate keyboard controls", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    const element = await mountFailure("connection refused", null);
    const command = element.querySelector<HTMLElement>(".login-gate__command");
    const action = command?.querySelector<HTMLButtonElement>(".login-gate__command-action");
    const copy = command?.querySelector<HTMLButtonElement>(".chat-copy-btn");

    expect(action).toBeInstanceOf(HTMLButtonElement);
    expect(copy).toBeInstanceOf(HTMLButtonElement);
    expect(action?.contains(copy ?? null)).toBe(false);
    action!.focus();
    expect(document.activeElement).toBe(action);
    action!.click();

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("openclaw gateway run");
    });
  });

  it.each(["Enter", " "])("preserves the copy button's %s keyboard activation", async (key) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    const element = await mountFailure("connection refused", null);
    const help = element.querySelector<HTMLDetailsElement>(".login-gate__help");
    expect(help).toBeInstanceOf(HTMLDetailsElement);
    help!.open = true;
    const button = element.querySelector<HTMLButtonElement>(".login-gate__command .chat-copy-btn");
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button?.closest('[role="button"]')).toBeNull();

    button!.focus();
    expect(document.activeElement).toBe(button);
    const activation = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    button!.dispatchEvent(activation);

    expect(activation.defaultPrevented).toBe(false);
    // jsdom does not synthesize native button activation from keyboard events.
    button!.click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledOnce();
      expect(button?.dataset.copied).toBe("1");
      expect(button?.getAttribute("aria-label")).toBe("Copied!");
    });
  });
});
