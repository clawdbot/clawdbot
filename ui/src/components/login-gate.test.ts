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
  it("renders every auth recovery command exactly once", async () => {
    const element = await mountFailure(
      "unauthorized: gateway token required",
      ConnectErrorDetailCodes.AUTH_REQUIRED,
    );

    expect(
      Array.from(element.querySelectorAll(".login-gate__failure-steps code"), (entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["openclaw gateway auth-token --show", "openclaw doctor --generate-gateway-token"]);
  });

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
      (entry) => entry.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(steps).toHaveLength(4);
    expect(steps[0]).toContain("On the Gateway host, run openclaw dashboard");
    expect(steps[0]).toContain("to open a secure one-time pairing link.");
    expect(steps[1]).toContain("Run openclaw devices list");
    expect(steps[1]).toContain("on the Gateway host.");
    expect(steps[2]).toBe("Approve the pending browser/device request from that list.");
    expect(steps[3]).toBe("Reconnect after the approval completes.");
    expect(
      Array.from(element.querySelectorAll(".login-gate__failure-steps code"), (entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["openclaw dashboard", "openclaw devices list"]);
  });

  it("renders only a normalized pairing request in an approval command", async () => {
    const safe = await mountFailure(
      "scope upgrade pending approval (requestId: req-123)",
      ConnectErrorDetailCodes.PAIRING_REQUIRED,
    );

    expect(
      Array.from(safe.querySelectorAll(".login-gate__failure-steps code"), (entry) =>
        entry.textContent?.trim(),
      ),
    ).toContain("openclaw devices approve req-123");
    safe.remove();

    const unsafe = await mountFailure(
      "scope upgrade pending approval (requestId: req-123;touch-owned)",
      ConnectErrorDetailCodes.PAIRING_REQUIRED,
    );
    const unsafeCommands = Array.from(
      unsafe.querySelectorAll(".login-gate__failure-steps code"),
      (entry) => entry.textContent?.trim(),
    );

    expect(unsafeCommands.some((command) => command?.startsWith("openclaw devices approve"))).toBe(
      false,
    );
    expect(unsafe.textContent).toContain(
      "Approve the pending browser/device request from that list.",
    );
    expect(unsafe.querySelector(".login-gate__failure-steps")?.textContent).not.toContain(
      "touch-owned",
    );
  });

  it("preserves command order when one recovery sentence contains multiple commands", async () => {
    const element = await mountFailure("WebSocket connection failed", null);

    expect(
      Array.from(element.querySelectorAll(".login-gate__failure-steps code"), (entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["openclaw status", "openclaw gateway run", "openclaw dashboard --no-open"]);
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
      expect(command?.querySelector('[role="status"]')?.textContent).toBe("Copy failed");
      expect(writeText).toHaveBeenCalledOnce();
      expect(writeText).toHaveBeenCalledWith("openclaw status");
      expect(execCommand).toHaveBeenCalledOnce();
    },
  );

  it("keeps recovery command copy state isolated per button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const element = await mountFailure("WebSocket connection failed", null);
    const buttons = Array.from(
      element.querySelectorAll<HTMLButtonElement>(
        ".login-gate__failure-steps .login-gate__command .chat-copy-btn",
      ),
    );

    buttons[0]?.click();
    buttons[1]?.click();

    await vi.waitFor(() => {
      expect(buttons[0]?.getAttribute("aria-label")).toBe("Copied!");
      expect(buttons[1]?.getAttribute("aria-label")).toBe("Copied!");
    });
    expect(writeText.mock.calls).toEqual([["openclaw status"], ["openclaw gateway run"]]);
    expect(buttons[2]?.getAttribute("aria-label")).toBe("Copy command");
  });

  it("keeps the latest command-copy feedback until its own reset", async () => {
    let finishCopy!: () => void;
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("Clipboard access denied"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishCopy = resolve;
          }),
      );
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
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-label")).toBe("Copy command");
    expect(command?.querySelector<HTMLElement>('[role="status"]')?.hidden).toBe(true);
    failedReset();
    expect(command?.querySelector<HTMLElement>('[role="status"]')?.hidden).toBe(true);
    finishCopy();
    await vi.waitFor(() => expect(button?.getAttribute("aria-label")).toBe("Copied!"));
    expect(command?.querySelector<HTMLElement>('[role="status"]')?.hidden).toBe(false);

    failedReset();
    expect(button?.getAttribute("aria-label")).toBe("Copied!");
    expect(command?.querySelector('[role="status"]')?.textContent).toBe("Copied!");

    const successfulReset = schedule.mock.calls.find(([, delay]) => delay === 1_500)?.[0];
    if (typeof successfulReset !== "function") {
      throw new Error("Expected the successful copy feedback to schedule its reset");
    }
    successfulReset();

    expect(button?.getAttribute("aria-label")).toBe("Copy command");
    expect(command?.querySelector<HTMLElement>('[role="status"]')?.hidden).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(execCommand).toHaveBeenCalledOnce();
  });
});
