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
    expect(feedback?.summary).toBe(
      "The Gateway is reachable, but it needs a matching token or password before this browser can connect.",
    );
    expect(feedback?.steps).toEqual([
      "Paste the token from openclaw dashboard --no-open or enter the configured password.",
      "If no token is configured, run openclaw doctor --generate-gateway-token on the gateway host.",
      "Click Connect again after updating the credential.",
    ]);
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
    expect(feedback?.summary).toBe(
      "The supplied credential was rejected. The most common cause is a stale token or a token copied from another Gateway URL.",
    );
    expect(feedback?.steps).toEqual([
      "Run openclaw dashboard --no-open and open the fresh URL or paste its token.",
      "Replace stale token/password values; do not reuse a token from another Gateway URL.",
      "Use one matching auth mode at a time: gateway token for token mode, password for password mode.",
    ]);
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
    expect(feedback?.steps).toEqual([
      "Stop retrying from this tab for a moment.",
      "Wait for the auth limiter to cool down, then reconnect with the corrected credential.",
      "If this is a shared host, check other clients for repeated bad retries.",
    ]);
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
    expect(feedback?.summary).toBe(
      "This browser is already known, but the requested access changed and needs a fresh approval.",
    );
    expect(feedback?.steps).toEqual([
      "Run openclaw devices list on the Gateway host.",
      "Approve this request: openclaw devices approve req-123.",
      "Reconnect after the approval completes.",
    ]);
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
    expect(feedback?.steps).toEqual([
      "Use HTTPS/Tailscale Serve, or open http://127.0.0.1:18789 on the Gateway host.",
      "For local token-only compatibility, set gateway.controlUi.allowInsecureAuth: true.",
      "Avoid disabling device auth for remote HTTP access.",
    ]);
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
    expect(feedback?.rawError).toBe(
      "Browser refused the Gateway WebSocket for security reasons. Use wss:// when the Control UI is served over HTTPS/Tailscale Serve, or open the loopback dashboard at http://127.0.0.1:18789.",
    );
    expect(feedback?.steps).toEqual([
      "Use HTTPS/Tailscale Serve, or open http://127.0.0.1:18789 on the Gateway host.",
      "For local token-only compatibility, set gateway.controlUi.allowInsecureAuth: true.",
      "Avoid disabling device auth for remote HTTP access.",
    ]);
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
    expect(feedback?.steps).toEqual([
      "Confirm the Gateway is running with openclaw status or openclaw gateway run.",
      "Check the WebSocket URL and use wss:// when the Gateway is behind HTTPS/Tailscale Serve.",
      "Reopen the dashboard with openclaw dashboard --no-open to recopy the current URL and auth details.",
    ]);
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
    expect(feedback?.steps).toEqual([
      "Add this browser origin to gateway.controlUi.allowedOrigins.",
      "Use full origins such as http://localhost:5173, not wildcard patterns.",
      "Restart or reload the Gateway after changing allowed origins.",
    ]);
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
    expect(feedback?.summary).toBe(
      "The served Control UI and the running Gateway do not agree on the supported connection protocol.",
    );
    expect(feedback?.steps).toEqual([
      "Reopen the served dashboard with openclaw dashboard so the UI and Gateway come from the same install.",
      "If using pnpm ui:dev, rebuild or restart the dev UI against the current checkout.",
      "Restart the Gateway after updating OpenClaw so it serves the current protocol.",
    ]);
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
    expect(feedback?.steps).toEqual([
      "Confirm the Gateway is running with openclaw status or openclaw gateway run.",
      "Check the WebSocket URL and use wss:// when the Gateway is behind HTTPS/Tailscale Serve.",
      "Reopen the dashboard with openclaw dashboard --no-open to recopy the current URL and auth details.",
    ]);
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

    expect(feedback?.rawError).toBe(
      "failed ws://host/openclaw#[redacted-credential] Authorization: Bearer [redacted] token=[redacted]",
    );
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
    expect(alert?.querySelector(".login-gate__failure-title")?.textContent?.trim()).toBe(
      "Protocol mismatch",
    );
    expect(alert?.querySelector(".login-gate__failure-summary")?.textContent?.trim()).toBe(
      "The served Control UI and the running Gateway do not agree on the supported connection protocol.",
    );
    expect(
      Array.from(alert?.querySelectorAll(".login-gate__failure-steps li") ?? []).map((step) =>
        step.textContent?.trim(),
      ),
    ).toEqual([
      "Reopen the served dashboard with openclaw dashboard so the UI and Gateway come from the same install.",
      "If using pnpm ui:dev, rebuild or restart the dev UI against the current checkout.",
      "Restart the Gateway after updating OpenClaw so it serves the current protocol.",
    ]);
    expect(alert?.querySelector("details summary")?.textContent?.trim()).toBe("Raw error");
    expect(alert?.querySelector(".login-gate__failure-raw")?.textContent?.trim()).toBe(
      "protocol mismatch",
    );

    const docsLink = alert?.querySelector<HTMLAnchorElement>(".login-gate__failure-docs");
    expect(docsLink?.textContent?.trim()).toBe("Control UI auth docs");
    expect(docsLink?.getAttribute("href")).toBe(
      "https://docs.openclaw.ai/web/control-ui#debuggingtesting-dev-server--remote-gateway",
    );
  });
});
