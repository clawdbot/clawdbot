// Control UI component renders the login gate.
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { normalizeBasePath } from "../app-route-paths.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { t } from "../i18n/index.ts";
import {
  resolveAuthHintKind,
  resolvePairingHint,
  shouldShowInsecureContextHint,
} from "../lib/connection-hints.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { normalizeLowercaseStringOrEmpty } from "../lib/string-coerce.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { renderConnectCommand } from "./connect-command.ts";
import { icons } from "./icons.ts";

type LoginFailureKind =
  | "auth-required"
  | "auth-failed"
  | "auth-rate-limited"
  | "pairing-required"
  | "insecure-context"
  | "origin-not-allowed"
  | "protocol-mismatch"
  | "network";

type LoginFailureFeedback = {
  kind: LoginFailureKind;
  title: string;
  summary: string;
  steps: string[];
  docsHref: string;
  docsLabel: string;
  rawError: string;
};

type LoginGateProps = {
  basePath: string;
  connected: boolean;
  lastError: string | null;
  lastErrorCode?: string | null;
  hasToken: boolean;
  hasPassword: boolean;
  gatewayUrl: string;
  token: string;
  password: string;
  showGatewayToken: boolean;
  showGatewayPassword: boolean;
  onGatewayUrlChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onToggleGatewayToken: () => void;
  onToggleGatewayPassword: () => void;
  onConnect: () => void;
};

type LoginFailureFeedbackParams = {
  connected: boolean;
  lastError: string | null;
  lastErrorCode?: string | null;
  hasToken: boolean;
  hasPassword: boolean;
};

function resolveDocsLabel(href: string): string {
  if (href.includes("insecure-http")) {
    return t("login.failure.docsInsecure");
  }
  if (href.includes("device-pairing")) {
    return t("login.failure.docsPairing");
  }
  return t("login.failure.docsAuth");
}

// Shared with the connection banner so no offline surface prints credentials.
export function redactLoginFailureError(value: string): string {
  return value
    .replace(
      /([?#&])(?:access_token|auth|deviceToken|password|refresh_token|token)=([^&#\s]+)/gi,
      "$1[redacted-credential]",
    )
    .replace(/\bBearer\s+([A-Za-z0-9._~+/-]+=*)/gi, "Bearer [redacted]")
    .replace(
      /(["']?(?:access|accessToken|deviceToken|password|refresh|refreshToken|token)["']?\s*[:=]\s*)["']?[^"',\s}]+/gi,
      "$1[redacted]",
    );
}

function buildFeedback(params: {
  kind: LoginFailureKind;
  rawError: string;
  docsHref?: string;
  titleKey: string;
  summaryKey: string;
  stepKeys: string[];
  stepParams?: Record<string, string>;
}): LoginFailureFeedback {
  const docsHref = params.docsHref ?? "https://docs.openclaw.ai/web/dashboard";
  return {
    kind: params.kind,
    title: t(params.titleKey, params.stepParams),
    summary: t(params.summaryKey, params.stepParams),
    steps: params.stepKeys.map((key) => t(key, params.stepParams)),
    docsHref,
    docsLabel: resolveDocsLabel(docsHref),
    rawError: redactLoginFailureError(params.rawError),
  };
}

function resolveLoginFailureFeedback(
  params: LoginFailureFeedbackParams,
): LoginFailureFeedback | null {
  if (params.connected || !params.lastError) {
    return null;
  }

  const rawError = params.lastError;
  const lastErrorCode = params.lastErrorCode ?? null;
  const lower = normalizeLowercaseStringOrEmpty(rawError);

  const pairing = resolvePairingHint(false, rawError, lastErrorCode);
  if (pairing) {
    return buildFeedback({
      kind: "pairing-required",
      rawError,
      docsHref: "https://docs.openclaw.ai/web/control-ui#device-pairing-first-connection",
      titleKey:
        pairing.kind === "scope-upgrade-pending"
          ? "login.failure.pairing.scopeTitle"
          : pairing.kind === "role-upgrade-pending"
            ? "login.failure.pairing.roleTitle"
            : pairing.kind === "metadata-upgrade-pending"
              ? "login.failure.pairing.metadataTitle"
              : "login.failure.pairing.title",
      summaryKey:
        pairing.kind === "pairing-required"
          ? "login.failure.pairing.summary"
          : "login.failure.pairing.upgradeSummary",
      stepKeys: [
        "login.failure.pairing.stepList",
        pairing.requestId
          ? "login.failure.pairing.stepApproveId"
          : "login.failure.pairing.stepApprove",
        "login.failure.pairing.stepReconnect",
      ],
      stepParams: { requestId: pairing.requestId ?? "" },
    });
  }

  if (
    lastErrorCode === ConnectErrorDetailCodes.AUTH_RATE_LIMITED ||
    lower.includes("too many failed authentication attempts") ||
    lower.includes("rate limit")
  ) {
    return buildFeedback({
      kind: "auth-rate-limited",
      rawError,
      titleKey: "login.failure.rateLimited.title",
      summaryKey: "login.failure.rateLimited.summary",
      stepKeys: [
        "login.failure.rateLimited.stepStop",
        "login.failure.rateLimited.stepWait",
        "login.failure.rateLimited.stepCheckClients",
      ],
    });
  }

  if (shouldShowInsecureContextHint(false, rawError, lastErrorCode)) {
    return buildFeedback({
      kind: "insecure-context",
      rawError,
      docsHref: "https://docs.openclaw.ai/web/control-ui#insecure-http",
      titleKey: "login.failure.insecure.title",
      summaryKey: "login.failure.insecure.summary",
      stepKeys: [
        "login.failure.insecure.stepHttps",
        "login.failure.insecure.stepLocalCompat",
        "login.failure.insecure.stepAvoidDisable",
      ],
    });
  }

  if (
    lastErrorCode === ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED ||
    lower.includes("origin not allowed")
  ) {
    return buildFeedback({
      kind: "origin-not-allowed",
      rawError,
      docsHref:
        "https://docs.openclaw.ai/web/control-ui#debuggingtesting-dev-server--remote-gateway",
      titleKey: "login.failure.origin.title",
      summaryKey: "login.failure.origin.summary",
      stepKeys: [
        "login.failure.origin.stepAllowedOrigins",
        "login.failure.origin.stepFullOrigin",
        "login.failure.origin.stepRestart",
      ],
    });
  }

  if (lower.includes("protocol mismatch")) {
    return buildFeedback({
      kind: "protocol-mismatch",
      rawError,
      docsHref:
        "https://docs.openclaw.ai/web/control-ui#debuggingtesting-dev-server--remote-gateway",
      titleKey: "login.failure.protocol.title",
      summaryKey: "login.failure.protocol.summary",
      stepKeys: [
        "login.failure.protocol.stepDashboard",
        "login.failure.protocol.stepDevUi",
        "login.failure.protocol.stepRestart",
      ],
    });
  }

  const authHintKind = resolveAuthHintKind({
    connected: false,
    lastError: rawError,
    lastErrorCode,
    hasToken: params.hasToken,
    hasPassword: params.hasPassword,
  });
  if (authHintKind === "required") {
    return buildFeedback({
      kind: "auth-required",
      rawError,
      titleKey: "login.failure.authRequired.title",
      summaryKey: "login.failure.authRequired.summary",
      stepKeys: [
        "login.failure.authRequired.stepPaste",
        "login.failure.authRequired.stepGenerate",
        "login.failure.authRequired.stepConnect",
      ],
    });
  }
  if (authHintKind === "failed") {
    return buildFeedback({
      kind: "auth-failed",
      rawError,
      titleKey: "login.failure.authFailed.title",
      summaryKey: "login.failure.authFailed.summary",
      stepKeys: [
        "login.failure.authFailed.stepDashboard",
        "login.failure.authFailed.stepReplace",
        "login.failure.authFailed.stepMode",
      ],
    });
  }

  return buildFeedback({
    kind: "network",
    rawError,
    titleKey: "login.failure.network.title",
    summaryKey: "login.failure.network.summary",
    stepKeys: [
      "login.failure.network.stepGateway",
      "login.failure.network.stepUrl",
      "login.failure.network.stepDashboard",
    ],
  });
}

function renderLoginFailure(feedback: LoginFailureFeedback) {
  return html`
    <div
      class="callout danger login-gate__failure"
      role="alert"
      aria-live="polite"
      data-kind=${feedback.kind}
    >
      <div class="login-gate__failure-title">${feedback.title}</div>
      <div class="login-gate__failure-summary">${feedback.summary}</div>
      <ol class="login-gate__failure-steps">
        ${feedback.steps.map((step) => html`<li>${step}</li>`)}
      </ol>
      <details class="login-gate__failure-detail">
        <summary>${t("login.failure.rawError")}</summary>
        <div class="login-gate__failure-raw mono">${feedback.rawError}</div>
      </details>
      <a
        class="session-link login-gate__failure-docs"
        href=${feedback.docsHref}
        target=${EXTERNAL_LINK_TARGET}
        rel=${buildExternalLinkRel()}
        >${feedback.docsLabel}</a
      >
    </div>
  `;
}

function renderLoginGate(props: LoginGateProps) {
  const basePath = normalizeBasePath(props.basePath);
  const faviconSrc = controlUiPublicAssetPath("favicon.svg", basePath);
  const failure = resolveLoginFailureFeedback({
    connected: props.connected,
    lastError: props.lastError,
    lastErrorCode: props.lastErrorCode,
    hasToken: props.hasToken,
    hasPassword: props.hasPassword,
  });

  return html`
    <div class="login-gate">
      <div class="login-gate__card">
        <div class="login-gate__header">
          <img class="login-gate__logo" src=${faviconSrc} alt="OpenClaw" />
          <div class="login-gate__title">OpenClaw</div>
          <div class="login-gate__sub">${t("login.subtitle")}</div>
        </div>
        <div class="login-gate__form">
          <label class="field">
            <span>${t("connection.access.wsUrl")}</span>
            <input
              inputmode="url"
              autocapitalize="none"
              autocorrect="off"
              autocomplete="off"
              spellcheck="false"
              enterkeyhint="go"
              .value=${props.gatewayUrl}
              @input=${(e: Event) => {
                props.onGatewayUrlChange((e.target as HTMLInputElement).value);
              }}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") {
                  props.onConnect();
                }
              }}
              placeholder="ws://127.0.0.1:18789"
            />
          </label>
          <label class="field">
            <span>${t("connection.access.token")}</span>
            <div class="login-gate__secret-row">
              <input
                type=${props.showGatewayToken ? "text" : "password"}
                autocomplete="off"
                spellcheck="false"
                enterkeyhint="go"
                .value=${props.token}
                @input=${(e: Event) => {
                  props.onTokenChange((e.target as HTMLInputElement).value);
                }}
                placeholder="OPENCLAW_GATEWAY_TOKEN (${t("login.passwordPlaceholder")})"
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") {
                    props.onConnect();
                  }
                }}
              />
              <openclaw-tooltip
                .content=${props.showGatewayToken ? t("login.hideToken") : t("login.showToken")}
              >
                <button
                  type="button"
                  class="btn btn--icon ${props.showGatewayToken ? "active" : ""}"
                  aria-label=${t("login.toggleTokenVisibility")}
                  aria-pressed=${props.showGatewayToken}
                  @click=${props.onToggleGatewayToken}
                >
                  ${props.showGatewayToken ? icons.eye : icons.eyeOff}
                </button>
              </openclaw-tooltip>
            </div>
          </label>
          <label class="field">
            <span>${t("connection.access.password")}</span>
            <div class="login-gate__secret-row">
              <input
                type=${props.showGatewayPassword ? "text" : "password"}
                autocomplete="off"
                spellcheck="false"
                enterkeyhint="go"
                .value=${props.password}
                @input=${(e: Event) => {
                  props.onPasswordChange((e.target as HTMLInputElement).value);
                }}
                placeholder="${t("login.passwordPlaceholder")}"
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") {
                    props.onConnect();
                  }
                }}
              />
              <openclaw-tooltip
                .content=${props.showGatewayPassword
                  ? t("login.hidePassword")
                  : t("login.showPassword")}
              >
                <button
                  type="button"
                  class="btn btn--icon ${props.showGatewayPassword ? "active" : ""}"
                  aria-label=${t("login.togglePasswordVisibility")}
                  aria-pressed=${props.showGatewayPassword}
                  @click=${props.onToggleGatewayPassword}
                >
                  ${props.showGatewayPassword ? icons.eye : icons.eyeOff}
                </button>
              </openclaw-tooltip>
            </div>
          </label>
          <button class="btn primary login-gate__connect" @click=${props.onConnect}>
            ${t("common.connect")}
          </button>
        </div>
        ${failure ? renderLoginFailure(failure) : ""}
        <details class="login-gate__help">
          <summary class="login-gate__help-title">${t("connection.help.title")}</summary>
          <ol class="login-gate__steps">
            <li>${t("connection.help.step1")}${renderConnectCommand("openclaw gateway run")}</li>
            <li>${t("connection.help.step2")} ${renderConnectCommand("openclaw dashboard")}</li>
            <li>${t("connection.help.step3")}</li>
          </ol>
          <div class="login-gate__docs">
            <a
              class="session-link"
              href="https://docs.openclaw.ai/web/dashboard"
              target="_blank"
              rel="noreferrer"
              >${t("connection.help.docsLink")}</a
            >
          </div>
        </details>
      </div>
    </div>
  `;
}

class LoginGate extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) props?: LoginGateProps;

  override render() {
    return this.props ? renderLoginGate(this.props) : nothing;
  }
}

if (!customElements.get("openclaw-login-gate")) {
  customElements.define("openclaw-login-gate", LoginGate);
}
