import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Recovery copy follows the lazy login and plugin views; the loader label stays eager.
const enLogin = {
  login: {
    heading: "Connect to OpenClaw",
    lede: "Enter the Gateway URL and secret, or open the one-time link that openclaw dashboard prints on the Gateway host.",
    gatewayUrl: "Gateway URL",
    secret: "Gateway secret",
    setupCodeHint:
      "This is a device setup code for the OpenClaw mobile app, not the Gateway secret. Paste it in the app's Gateway settings instead; the Gateway secret comes from openclaw gateway auth-token --show on the Gateway host.",
    secretPlaceholder: "Paste the token or type the password",
    runOnHost: "Run on the Gateway host",
    connection: {
      target: "Connecting to {host}",
      secretEntered: "secret entered",
      noSecret: "no secret",
      change: "Change",
    },
    showSecret: "Show Gateway secret",
    hideSecret: "Hide Gateway secret",
    toggleSecretVisibility: "Toggle Gateway secret visibility",
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
        title: "This Gateway expects its token",
        passwordTitle: "This Gateway expects its password",
        summary:
          "The Gateway at {host} is reachable, but it needs a matching token or password before this browser can connect.",
        stepPaste: "Paste the token from openclaw gateway auth-token --show into Gateway secret.",
        stepPassword: "Type the configured Gateway password into Gateway secret.",
        stepGenerate:
          "If no token is configured, run openclaw doctor --generate-gateway-token on the gateway host.",
        stepConnect: "Click Connect again after updating the Gateway secret.",
      },
      authFailed: {
        title: "Gateway secret rejected",
        summary:
          "{host} rejected the supplied Gateway secret. Check that it belongs to this Gateway and try again.",
        stepDashboard:
          "Run openclaw dashboard --no-open for a fresh URL, or openclaw gateway auth-token --show to recover the token.",
        stepReplace: "Replace the Gateway secret with the token for this Gateway URL.",
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
        title: "Approve this browser",
        scopeTitle: "Approve the new access level",
        roleTitle: "Approve the new role",
        metadataTitle: "Re-approve this browser",
        summary:
          "This browser passed Gateway auth at {host}, but the Gateway has not seen it before. A one-time approval on the Gateway host finishes pairing.",
        upgradeSummary:
          "This browser is already paired with {host}, but it asked for access it was not approved for. Approve the new request on the Gateway host.",
        stepDashboard:
          "Prefer a link? Run openclaw dashboard on the Gateway host and open the one-time URL it prints in this browser.",
        stepLatest:
          "That command prints the exact approve command for the newest pending request; run that one as well.",
        stepReconnect: "Once approved, click Connect.",
        waiting:
          "Waiting for approval… this page connects on its own once the request is approved.",
        checkNow: "Check now",
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
        title: "Gateway unreachable",
        summary:
          "The browser could not reach {host}. Check the address and transport before retrying credentials.",
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
