/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { registerControlUiReloadGuard } from "../app/document-reload-guard.ts";
import { showToast } from "../lib/toast.ts";
import "./login-gate.ts";

type LoginGateElement = HTMLElement & {
  props: Record<string, unknown>;
  updateComplete: Promise<boolean>;
};

async function mountFailure(lastError: string, lastErrorCode: string | null, secret = "") {
  const element = document.createElement("openclaw-login-gate") as LoginGateElement;
  element.props = {
    resourceBasePath: "",
    connected: false,
    lastError,
    lastErrorCode,
    hasToken: Boolean(secret),
    hasPassword: Boolean(secret),
    gatewayUrl: "ws://127.0.0.1:18789",
    secret,
    showGatewaySecret: false,
    onGatewayUrlChange: vi.fn(),
    onSecretChange: vi.fn(),
    onToggleGatewaySecret: vi.fn(),
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
  const setupCode = btoa(
    JSON.stringify({
      url: "wss://gateway.example",
      bootstrapToken: "synthetic-bootstrap-token",
    }),
  ).replace(/=+$/g, "");

  it("explains a pasted setup code before connecting and clears the hint when replaced", async () => {
    const element = await mountFailure("", null, setupCode);
    const hint = element.querySelector("#login-gate-secret-hint");
    expect(hint?.textContent).toContain("device setup code for the OpenClaw mobile app");
    expect(hint?.textContent).toContain("openclaw gateway auth-token --show");
    expect(element.querySelector("#login-gate-credential")?.getAttribute("aria-describedby")).toBe(
      hint?.id,
    );
    expect(element.props.onConnect).not.toHaveBeenCalled();
    element.props = { ...element.props, secret: "ordinary-secret" };
    await element.updateComplete;
    expect(element.querySelector("#login-gate-secret-hint")).toBeNull();
    expect(element.querySelector("#login-gate-credential")?.hasAttribute("aria-describedby")).toBe(
      false,
    );
  });

  it.each([
    ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
    ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH,
  ])("explains setup codes instead of generic mismatch copy for %s", async (code) => {
    const element = await mountFailure("unauthorized", code, setupCode);
    expect(element.querySelector(".login-gate__failure-summary")?.textContent?.trim()).toBe(
      element.querySelector("#login-gate-secret-hint")?.textContent?.trim(),
    );
    expect(element.querySelector(".login-gate__failure-summary")?.textContent).toContain(
      "Paste it in the app's Gateway settings instead",
    );
  });

  it("preserves unrelated failure summaries with a setup code entered", async () => {
    const element = await mountFailure(
      "rate limit",
      ConnectErrorDetailCodes.AUTH_RATE_LIMITED,
      setupCode,
    );
    expect(element.querySelector(".login-gate__failure")?.getAttribute("data-kind")).toBe(
      "auth-rate-limited",
    );
    expect(element.querySelector(".login-gate__failure-summary")?.textContent).not.toContain(
      "device setup code",
    );
  });

  it("explains how to reconnect with a verified user identity", async () => {
    const element = await mountFailure(
      "operator role policies require a verified user identity for this authentication method",
      ConnectErrorDetailCodes.AUTH_VERIFIED_USER_REQUIRED,
    );
    const failure = element.querySelector(".login-gate__failure");
    const steps = failure?.querySelector(".login-gate__failure-steps")?.textContent;

    expect(failure?.getAttribute("data-kind")).toBe("verified-user-required");
    expect(failure?.querySelector(".login-gate__failure-title")?.textContent).toBe(
      "Verified identity required",
    );
    expect(steps).toMatch(/trusted proxy or Tailscale/iu);
    expect(steps).toMatch(/shared Gateway token or password/iu);
    expect(failure?.querySelector(".login-gate__failure-docs")?.getAttribute("href")).toBe(
      "https://docs.openclaw.ai/gateway/operator-scopes",
    );
  });

  it.each([
    { name: "empty", secret: "" },
    { name: "populated", secret: "test-secret" },
  ])("explains missing identity headers with $name credentials", async ({ secret }) => {
    const element = await mountFailure(
      "unauthorized",
      ConnectErrorDetailCodes.AUTH_IDENTITY_HEADER_REQUIRED,
      secret,
    );
    const failure = element.querySelector(".login-gate__failure");
    const steps = failure?.querySelector(".login-gate__failure-steps")?.textContent;

    expect(failure?.getAttribute("data-kind")).toBe("trusted-proxy");
    expect(steps).toMatch(/(?:open|use|sign in).*?(?:authenticated proxy|SSO).*?URL/iu);
    expect(steps).toMatch(/configured/iu);
    expect(failure?.textContent).toMatch(
      /missing.*?identity[- ]headers?|identity[- ]headers?.*?missing/iu,
    );
    expect(steps).toMatch(/forward/iu);
    expect(steps).toMatch(/WebSocket upgrade/iu);
    expect(failure?.querySelector(".login-gate__failure-docs")?.getAttribute("href")).toBe(
      "https://docs.openclaw.ai/gateway/trusted-proxy-auth",
    );
    expect(failure?.querySelector(".login-gate__failure-raw")?.textContent).toBe("unauthorized");
    expect(failure?.querySelectorAll(".login-gate__failure-steps code")).toHaveLength(0);
    expect(steps).not.toMatch(/generate.*?token|replace.*?(?:token|password)|Gateway is running/iu);
  });

  it.each([
    "Authenticated profile verification is unavailable; retry the request.",
    "GitHub is rate limiting profile verification. Retry shortly; if this continues, ask a gateway administrator to check the GitHub API credential.",
  ])(
    "explains profile verification failures without credential or network recovery: %s",
    async (error) => {
      const element = await mountFailure(
        error,
        ConnectErrorDetailCodes.AUTHENTICATED_PROFILE_UNAVAILABLE,
      );
      const failure = element.querySelector(".login-gate__failure");

      expect(failure?.getAttribute("data-kind")).toBe("profile-unavailable");
      expect(failure?.querySelector(".login-gate__failure-title")?.textContent).toBe(
        "Profile verification unavailable",
      );
      expect(failure?.querySelector(".login-gate__failure-summary")?.textContent).toBe(error);
      expect(failure?.querySelector(".login-gate__failure-steps")?.textContent).toContain("Retry");
      expect(failure?.querySelector(".login-gate__failure-steps")?.textContent).toContain(
        "Gateway administrator",
      );
      expect(failure?.querySelectorAll(".login-gate__failure-steps code")).toHaveLength(0);
      expect(failure?.querySelector(".login-gate__failure-raw")?.textContent).toBe(error);
    },
  );

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

  it("edits and reveals one Gateway secret without choosing a credential type", async () => {
    const element = await mountFailure("", null, "old-secret");
    const input = element.querySelector<HTMLInputElement>("#login-gate-credential")!;
    expect(element.querySelector('label[for="login-gate-credential"]')?.textContent).toBe(
      "Gateway secret",
    );
    expect(input.placeholder).toBe("Paste the token or type the password");
    expect(input.type).toBe("password");
    expect(input.value).toBe("old-secret");
    expect(element.querySelector('[role="radiogroup"]')).toBeNull();

    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    element.props = { ...element.props, secret: "" };
    await element.updateComplete;
    input.value = "replacement-secret";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(element.props.onSecretChange).toHaveBeenNthCalledWith(1, "");
    expect(element.props.onSecretChange).toHaveBeenNthCalledWith(2, "replacement-secret");

    element
      .querySelector<HTMLButtonElement>('[aria-label="Toggle Gateway secret visibility"]')
      ?.click();
    expect(element.props.onToggleGatewaySecret).toHaveBeenCalledOnce();
    element.props = { ...element.props, secret: "replacement-secret", showGatewaySecret: true };
    await element.updateComplete;
    expect(input.type).toBe("text");
    expect(input.value).toBe("replacement-secret");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(element.props.onConnect).toHaveBeenCalledOnce();
  });

  it.each([
    [ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING, "auth-required"],
    [ConnectErrorDetailCodes.AUTH_PASSWORD_NOT_CONFIGURED, "auth-required"],
    [ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH, "auth-failed"],
  ])(
    "explains a password-mode %s error without changing the input or suggesting token recovery",
    async (code, kind) => {
      const element = await mountFailure("unauthorized", code, "entered-secret");
      const failure = element.querySelector(".login-gate__failure");
      expect(failure?.getAttribute("data-kind")).toBe(kind);
      expect(element.querySelector<HTMLInputElement>("#login-gate-credential")?.value).toBe(
        "entered-secret",
      );
      expect(element.querySelector(".login-gate__failure-title")?.textContent?.trim()).toBe(
        "This Gateway expects its password",
      );
      expect(element.querySelector(".login-gate__failure-steps")?.textContent).toContain(
        "Type the configured Gateway password into Gateway secret.",
      );
      expect(element.querySelector(".login-gate__failure-steps")?.textContent).not.toMatch(
        /auth-token|generate-gateway-token|auth mode/,
      );
      expect(element.querySelector('[role="radiogroup"]')).toBeNull();
    },
  );

  it("keeps Connect available beside Refresh for a protocol mismatch", async () => {
    const element = await mountFailure(
      "protocol mismatch",
      ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
    );
    const actions = element.querySelector(".login-gate__actions");

    expect(actions?.querySelector(".login-gate__failure-refresh")).not.toBeNull();
    expect(actions?.querySelector("button.login-gate__connect")?.textContent?.trim()).toBe(
      "Connect",
    );
    actions?.querySelector<HTMLButtonElement>("button.login-gate__connect")?.click();
    expect(element.props.onConnect).toHaveBeenCalledOnce();
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

  it("shows an explicit recovery choice when reconnect leaves unsaved starts behind the login gate", async () => {
    const element = await mountFailure(
      "protocol mismatch",
      ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
    );
    const reload = vi.fn();
    const discard = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    const release = registerControlUiReloadGuard(
      () => false,
      () => {
        showToast({
          message: "Recovery needs a reload. Unsaved starts will be lost.",
          actionLabel: "Discard unsaved starts and reload",
          onAction: discard,
        });
      },
    );
    try {
      element.querySelector<HTMLButtonElement>(".login-gate__failure-refresh")?.click();
      expect(reload).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(element.querySelector(".app-toast__message")?.textContent).toContain(
          "Unsaved starts will be lost.",
        );
      });
      const action = element.querySelector<HTMLButtonElement>(".app-toast__action");
      expect(action?.textContent?.trim()).toBe("Discard unsaved starts and reload");
      expect(discard).not.toHaveBeenCalled();
      action?.click();
      expect(discard).toHaveBeenCalledOnce();
    } finally {
      release();
    }
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

  it("leads pairing recovery with one approve command and folds the form away", async () => {
    const element = await mountFailure(
      "pairing required",
      ConnectErrorDetailCodes.PAIRING_REQUIRED,
    );
    const failure = element.querySelector<HTMLElement>(".login-gate__failure");

    expect(failure?.getAttribute("data-kind")).toBe("pairing-required");
    expect(failure?.getAttribute("data-tone")).toBe("pending");
    expect(failure?.querySelector(".login-gate__failure-title")?.textContent).toBe(
      "Approve this browser",
    );
    expect(failure?.querySelector(".login-gate__command--hero code")?.textContent?.trim()).toBe(
      "openclaw devices approve --latest",
    );
    const steps = Array.from(
      element.querySelectorAll<HTMLElement>(".login-gate__failure-steps li"),
      (entry) => entry.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain("prints the exact approve command");
    expect(steps[1]).toContain("Prefer a link? Run openclaw dashboard");
    expect(steps[1]).toContain("on the Gateway host and open the one-time URL");
    expect(steps[2]).toBe("Once approved, click Connect.");
    // The form stays reachable but folded; its summary names the target without a credential.
    const connection = failure?.querySelector<HTMLDetailsElement>(".login-gate__connection");
    expect(connection?.open).toBe(false);
    expect(connection?.querySelector("summary")?.textContent?.replace(/\s+/g, " ")).toContain(
      "Connecting to 127.0.0.1:18789 · no secret Change",
    );
    expect(element.querySelectorAll("button.login-gate__connect")).toHaveLength(1);
  });

  it("shows automatic pairing recovery only while reconnect is pending", async () => {
    const element = await mountFailure(
      "pairing required",
      ConnectErrorDetailCodes.PAIRING_REQUIRED,
    );
    element.props = { ...element.props, reconnectPending: true };
    await element.updateComplete;

    expect(element.textContent).toContain(
      "Waiting for approval… this page connects on its own once the request is approved.",
    );
    expect(element.textContent).not.toContain("Once approved, click Connect.");
    expect(element.querySelector('[aria-hidden="true"].session-run-spinner')).not.toBeNull();
    const checkNow = element.querySelector<HTMLButtonElement>(".login-gate__connect")!;
    expect(checkNow.textContent?.trim()).toBe("Check now");
    checkNow.click();
    expect(element.props.onConnect).toHaveBeenCalledOnce();

    element.props = { ...element.props, reconnectPending: false };
    await element.updateComplete;
    expect(element.textContent).toContain("Once approved, click Connect.");
    expect(element.textContent).not.toContain("Waiting for approval…");
    expect(element.querySelector(".session-run-spinner")).toBeNull();
    expect(checkNow.textContent?.trim()).toBe("Connect");
  });

  it("renders only a normalized pairing request in the approve command", async () => {
    const safe = await mountFailure(
      "scope upgrade pending approval (requestId: req-123)",
      ConnectErrorDetailCodes.PAIRING_REQUIRED,
    );

    expect(safe.querySelector(".login-gate__failure-title")?.textContent).toBe(
      "Approve the new access level",
    );
    expect(safe.querySelector(".login-gate__command--hero code")?.textContent?.trim()).toBe(
      "openclaw devices approve req-123",
    );
    expect(safe.querySelectorAll(".login-gate__failure-steps li")).toHaveLength(2);
    safe.remove();

    const unsafe = await mountFailure(
      "scope upgrade pending approval (requestId: req-123;touch-owned)",
      ConnectErrorDetailCodes.PAIRING_REQUIRED,
    );

    expect(unsafe.querySelector(".login-gate__command--hero code")?.textContent?.trim()).toBe(
      "openclaw devices approve --latest",
    );
    // Only the redacted raw-error disclosure may echo the rejected id.
    expect(unsafe.querySelector(".login-gate__hero")?.textContent).not.toContain("touch-owned");
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
