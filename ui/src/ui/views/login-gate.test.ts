/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../../src/gateway/protocol/connect-error-details.js";
import { i18n } from "../../i18n/index.ts";
import type { AppViewState } from "../app-view-state.ts";
import { renderLoginGate, resolveLoginFailureFeedback } from "./login-gate.ts";

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    basePath: "",
    connected: false,
    lastError: null,
    lastErrorCode: null,
    loginShowGatewayToken: false,
    loginShowGatewayPassword: false,
    password: "",
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatShowToolCalls: true,
      splitRatio: 0.6,
      navCollapsed: false,
      navWidth: 220,
      navGroupsCollapsed: {},
      borderRadius: 50,
      locale: "en",
    },
    applySettings: () => undefined,
    connect: () => undefined,
    ...overrides,
  } as unknown as AppViewState;
}

describe("resolveLoginFailureFeedback", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("explains missing auth credentials", () => {
    const feedback = resolveLoginFailureFeedback({
      connected: false,
      lastError: "disconnected (4008): connect failed",
      lastErrorCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
      hasToken: false,
      hasPassword: false,
    });

    expect(feedback?.kind).toBe("auth-required");
    expect(feedback?.title).toBe("Auth required");
    expect(feedback?.steps.join(" ")).toContain("openclaw dashboard --no-open");
    expect(feedback?.steps.join(" ")).toContain("openclaw doctor --generate-gateway-token");
  });

  it("explains rejected stale credentials", () => {
    const feedback = resolveLoginFailureFeedback({
      connected: false,
      lastError: "unauthorized: gateway token mismatch",
      lastErrorCode: ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH,
      hasToken: true,
      hasPassword: false,
    });

    expect(feedback?.kind).toBe("auth-failed");
    expect(feedback?.summary).toContain("stale token");
    expect(feedback?.steps.join(" ")).toContain("token mode");
  });

  it("explains auth rate limits without encouraging retries", () => {
    const feedback = resolveLoginFailureFeedback({
      connected: false,
      lastError: "too many failed authentication attempts",
      lastErrorCode: ConnectErrorDetailCodes.AUTH_RATE_LIMITED,
      hasToken: true,
      hasPassword: false,
    });

    expect(feedback?.kind).toBe("auth-rate-limited");
    expect(feedback?.title).toBe("Too many failed attempts");
    expect(feedback?.steps[0]).toContain("Stop retrying");
  });

  it("preserves pairing request ids in the approval command", () => {
    const feedback = resolveLoginFailureFeedback({
      connected: false,
      lastError: "scope upgrade pending approval (requestId: req-123)",
      lastErrorCode: ConnectErrorDetailCodes.PAIRING_REQUIRED,
      hasToken: true,
      hasPassword: false,
    });

    expect(feedback?.kind).toBe("pairing-required");
    expect(feedback?.title).toBe("Scope upgrade pending");
    expect(feedback?.steps.join(" ")).toContain("openclaw devices approve req-123");
  });

  it("explains insecure HTTP device identity failures", () => {
    const feedback = resolveLoginFailureFeedback({
      connected: false,
      lastError: "device identity required",
      lastErrorCode: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
      hasToken: true,
      hasPassword: false,
    });

    expect(feedback?.kind).toBe("insecure-context");
    expect(feedback?.steps.join(" ")).toContain("Tailscale Serve");
    expect(feedback?.steps.join(" ")).toContain("gateway.controlUi.allowInsecureAuth");
  });

  it("explains browser WebSocket security failures as insecure context", () => {
    const feedback = resolveLoginFailureFeedback({
      connected: false,
      lastError:
        "Browser refused the Gateway WebSocket for security reasons. Use wss:// when the Control UI is served over HTTPS/Tailscale Serve, or open the loopback dashboard at http://127.0.0.1:18789.",
      lastErrorCode: "BROWSER_WEBSOCKET_SECURITY_ERROR",
      hasToken: true,
      hasPassword: false,
    });

    expect(feedback?.kind).toBe("insecure-context");
    expect(feedback?.rawError).toContain("Use wss://");
    expect(feedback?.rawError).toContain("http://127.0.0.1:18789");
    expect(feedback?.steps.join(" ")).toContain("Tailscale Serve");
    expect(feedback?.steps.join(" ")).toContain("gateway.controlUi.allowInsecureAuth");
  });

  it("keeps generic browser WebSocket constructor failures on the network path", () => {
    const feedback = resolveLoginFailureFeedback({
      connected: false,
      lastError: "Could not create the Gateway WebSocket: constructor failed",
      lastErrorCode: "BROWSER_WEBSOCKET_CONSTRUCTOR_ERROR",
      hasToken: false,
      hasPassword: false,
    });

    expect(feedback?.kind).toBe("network");
    expect(feedback?.steps.join(" ")).toContain("WebSocket URL");
  });

  it("explains browser origin rejections", () => {
    const feedback = resolveLoginFailureFeedback({
      connected: false,
      lastError: "origin not allowed",
      lastErrorCode: ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED,
      hasToken: true,
      hasPassword: false,
    });

    expect(feedback?.kind).toBe("origin-not-allowed");
    expect(feedback?.steps.join(" ")).toContain("gateway.controlUi.allowedOrigins");
  });

  it("explains protocol mismatch without requiring a gateway protocol change", () => {
    const feedback = resolveLoginFailureFeedback({
      connected: false,
      lastError: "protocol mismatch",
      lastErrorCode: null,
      hasToken: true,
      hasPassword: false,
    });

    expect(feedback?.kind).toBe("protocol-mismatch");
    expect(feedback?.summary).toContain("supported connection protocol");
    expect(feedback?.steps.join(" ")).toContain("openclaw dashboard");
  });

  it("falls back to connection diagnostics for generic close errors", () => {
    const feedback = resolveLoginFailureFeedback({
      connected: false,
      lastError: "disconnected (1006): no reason",
      lastErrorCode: null,
      hasToken: false,
      hasPassword: false,
    });

    expect(feedback?.kind).toBe("network");
    expect(feedback?.steps.join(" ")).toContain("WebSocket URL");
    expect(feedback?.steps.join(" ")).toContain("wss://");
  });

  it("redacts credential-shaped values from displayed raw errors", () => {
    const feedback = resolveLoginFailureFeedback({
      connected: false,
      lastError:
        "failed ws://host/openclaw#token=secret-token Authorization: Bearer secret-bearer token=inline-secret",
      lastErrorCode: null,
      hasToken: false,
      hasPassword: false,
    });

    expect(feedback?.rawError).not.toContain("secret-token");
    expect(feedback?.rawError).not.toContain("secret-bearer");
    expect(feedback?.rawError).not.toContain("inline-secret");
    expect(feedback?.rawError).toContain("[redacted");
  });
});

describe("renderLoginGate", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("renders an accessible structured failure panel with raw error details", async () => {
    const container = document.createElement("div");
    const state = createState({
      lastError: "protocol mismatch",
      settings: {
        ...createState().settings,
        token: "stale-token",
      },
    });

    render(renderLoginGate(state), container);
    await Promise.resolve();

    const alert = container.querySelector<HTMLElement>('[role="alert"]');
    expect(alert?.dataset.kind).toBe("protocol-mismatch");
    expect(alert?.textContent).toContain("Protocol mismatch");
    expect(alert?.textContent).toContain("openclaw dashboard");
    expect(alert?.querySelector("details")?.textContent).toContain("protocol mismatch");
    expect(alert?.querySelector("a")?.getAttribute("href")).toContain("docs.openclaw.ai");
  });
});
