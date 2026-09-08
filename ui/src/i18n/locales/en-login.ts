import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Recovery copy follows the lazy login and plugin views; the loader label stays eager.
const enLogin = {
  login: {
    passwordPlaceholder: "optional",
    showToken: "Show token",
    hideToken: "Hide token",
    toggleTokenVisibility: "Toggle token visibility",
    showPassword: "Show password",
    hidePassword: "Hide password",
    togglePasswordVisibility: "Toggle password visibility",
    failure: {
      rawError: "Raw error",
      profileUnavailable: {
        title: "Profile verification unavailable",
        stepRetry: "Retry shortly.",
        stepAdmin:
          "If this continues, ask a Gateway administrator to check the identity provider and GitHub API credential.",
      },
      verifiedUserRequired: {
        title: "Verified identity required",
        summary:
          "This Gateway has named roles enabled. Device and setup tokens cannot identify a person.",
        stepIdentity:
          "Reconnect through the trusted proxy or Tailscale so the Gateway can verify your identity.",
        stepSharedSecret:
          "For trusted local operator access, use the shared Gateway token or password.",
      },
      authRequired: {
        title: "Auth required",
        summary:
          "The Gateway is reachable, but it needs a matching token or password before this browser can connect.",
        stepPaste:
          "Paste the token from openclaw gateway auth-token --show or enter the configured password.",
        stepGenerate:
          "If no token is configured, run openclaw doctor --generate-gateway-token on the gateway host.",
        stepConnect: "Click Connect again after updating the credential.",
      },
      authFailed: {
        title: "Auth did not match",
        summary:
          "The supplied credential was rejected. The most common cause is a stale token or a token copied from another Gateway URL.",
        stepDashboard:
          "Run openclaw dashboard --no-open for a fresh URL, or openclaw gateway auth-token --show to recover the token.",
        stepReplace:
          "Replace stale token/password values; do not reuse a token from another Gateway URL.",
        stepMode:
          "Use one matching auth mode at a time: gateway token for token mode, password for password mode.",
      },
      trustedProxy: {
        title: "Proxy authentication required",
        summary:
          "The Gateway is reachable, but it rejected the proxy identity or forwarding information.",
        stepSignIn:
          "Open the configured authenticated proxy or SSO dashboard URL and sign in there, rather than visiting the Gateway directly.",
        stepHeaders:
          "Ask the Gateway administrator to check for missing identity headers and required-header forwarding on WebSocket upgrade requests, and confirm your account is permitted.",
        stepNoToken: "A Gateway token cannot replace proxy authentication.",
      },
      rateLimited: {
        title: "Too many failed attempts",
        summary: "The Gateway is temporarily limiting authentication attempts for this client.",
        stepStop: "Stop retrying from this tab for a moment.",
        stepWait:
          "Wait for the auth limiter to cool down, then reconnect with the corrected credential.",
        stepCheckClients: "If this is a shared host, check other clients for repeated bad retries.",
      },
      pairing: {
        title: "Device pairing required",
        scopeTitle: "Scope upgrade pending",
        roleTitle: "Role upgrade pending",
        metadataTitle: "Device refresh pending",
        summary:
          "This browser needs one-time approval from the Gateway host before it can use the Control UI.",
        upgradeSummary:
          "This browser is already known, but the requested access changed and needs a fresh approval.",
        stepDashboard:
          "On the Gateway host, run openclaw dashboard to open a secure one-time pairing link.",
        stepList: "Run openclaw devices list on the Gateway host.",
        stepApproveId: "Approve this request: openclaw devices approve {requestId}.",
        stepApprove: "Approve the pending browser/device request from that list.",
        stepReconnect: "Reconnect after the approval completes.",
      },
      insecure: {
        title: "Secure browser context required",
        summary:
          "This page is running over plain HTTP, so the browser cannot create the device identity the Gateway expects.",
        stepHttps: "Use HTTPS/Tailscale Serve, or open http://127.0.0.1:18789 on the Gateway host.",
        stepAvoidDisable:
          "Do not use a remote plain-HTTP URL; a token or password cannot replace browser device identity.",
      },
      origin: {
        title: "Browser origin not allowed",
        summary:
          "The Gateway rejected this page origin before accepting the Control UI connection.",
        stepAllowedOrigins: "Add this browser origin to gateway.controlUi.allowedOrigins.",
        stepFullOrigin: "Use full origins such as http://localhost:5173, not wildcard patterns.",
        stepRestart: "Restart or reload the Gateway after changing allowed origins.",
      },
      protocol: {
        title: "Protocol mismatch",
        summary:
          "The served Control UI and the running Gateway do not agree on the supported connection protocol.",
        refresh: "Refresh page",
        stepDashboard:
          "Reopen the served dashboard with openclaw dashboard so the UI and Gateway come from the same install.",
        stepDevUi:
          "If using pnpm ui:dev, rebuild or restart the dev UI against the current checkout.",
        stepRestart:
          "Restart the Gateway after updating OpenClaw so it serves the current protocol.",
      },
      network: {
        title: "Could not connect",
        summary:
          "The browser could not complete the Gateway connection. Check the target and transport before retrying credentials.",
        stepGateway: "Confirm the Gateway is running with openclaw status or openclaw gateway run.",
        stepUrl:
          "Check the WebSocket URL and use wss:// when the Gateway is behind HTTPS/Tailscale Serve.",
        stepDashboard:
          "Reopen the dashboard with openclaw dashboard --no-open to recopy the current URL and auth details.",
      },
    },
  },
} satisfies TranslationMap;

export const registerLoginEnglish = Object.assign(
  () => {
    Object.assign(en.login, enLogin.login);
  },
  { catalog: enLogin },
);
