// Control UI component renders the login gate.
import { html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { normalizeBasePath } from "../app-route-paths.ts";
import { canReloadControlUiDocument } from "../app/document-reload-guard.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { t } from "../i18n/index.ts";
import "../lib/toast.ts";
import { registerLoginEnglish } from "../i18n/locales/en-login.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { renderConnectCommand } from "./connect-command.ts";
import { icons } from "./icons.ts";
import {
  type CredentialMode,
  formatGatewayHost,
  type LoginFailureFeedback,
  type LoginFailureFeedbackParams,
  type LoginFailureStep,
  type LoginFailureTone,
  PASSWORD_MODE_CODES,
  resolveLoginFailureFeedback,
} from "./login-gate-feedback.ts";

registerLoginEnglish();

type LoginGateProps = LoginFailureFeedbackParams & {
  resourceBasePath: string;
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

const TONE_ICONS: Record<LoginFailureTone, TemplateResult> = {
  pending: icons.shieldEllipsis,
  warn: icons.clock,
  danger: icons.shieldAlert,
};

function refreshLoginGatePage() {
  // A terminal reconnect failure can show this gate while startup still owns unsaved input.
  if (canReloadControlUiDocument(true)) {
    window.location.reload();
  }
}

function renderLoginFailureStep({ text, commands }: LoginFailureStep) {
  const unmatchedCommands = new Set(commands);
  const matches = [...unmatchedCommands]
    .map((command) => [command, text.indexOf(command)] as const)
    .toSorted(
      ([left, leftIndex], [right, rightIndex]) =>
        leftIndex - rightIndex || right.length - left.length,
    );
  const segments: (string | ReturnType<typeof renderConnectCommand>)[] = [];
  let cursor = 0;

  for (const [command, index] of matches) {
    if (index < cursor) {
      continue;
    }
    segments.push(text.slice(cursor, index), renderConnectCommand(command));
    unmatchedCommands.delete(command);
    cursor = index + command.length;
  }

  segments.push(text.slice(cursor));
  for (const command of unmatchedCommands) {
    segments.push(" ", renderConnectCommand(command));
  }
  return segments;
}

function renderSteps(feedback: LoginFailureFeedback) {
  if (feedback.steps.length === 0) {
    return nothing;
  }
  return html`
    <ol class="login-gate__failure-steps">
      ${feedback.steps.map((step) => html`<li>${renderLoginFailureStep(step)}</li>`)}
    </ol>
  `;
}

function renderFailureFooter(feedback: LoginFailureFeedback) {
  return html`
    <footer class="login-gate__foot">
      <details class="login-gate__failure-detail">
        <summary>${t("login.failure.rawError")}</summary>
        <div class="login-gate__failure-raw mono">${feedback.rawError}</div>
      </details>
      <a
        class="session-link login-gate__failure-docs"
        href=${feedback.docsHref}
        target=${EXTERNAL_LINK_TARGET}
        rel=${buildExternalLinkRel()}
        >${t("common.learnMore")}</a
      >
    </footer>
  `;
}

function renderRefreshAction(feedback: LoginFailureFeedback) {
  if (!feedback.refreshAction) {
    return nothing;
  }
  return html`
    <button
      type="button"
      class="btn primary login-gate__failure-refresh"
      @click=${refreshLoginGatePage}
    >
      ${feedback.refreshAction.label}
    </button>
  `;
}

function resolveCredentialMode(props: LoginGateProps, override: CredentialMode | null) {
  if (override) {
    return override;
  }
  // A password-mode rejection outranks a saved token: the Gateway just said which
  // credential it wants, and the stale token is what got rejected.
  if (props.lastErrorCode && PASSWORD_MODE_CODES.has(props.lastErrorCode)) {
    return "password";
  }
  if (props.token.trim()) {
    return "token";
  }
  return props.password.trim() ? "password" : "token";
}

function renderSecretToggle(
  revealed: boolean,
  labels: [string, string, string],
  onToggle: () => void,
) {
  const [show, hide, toggle] = labels;
  return html`
    <openclaw-tooltip .content=${revealed ? hide : show}>
      <button
        type="button"
        class="settings-secret__toggle"
        aria-label=${toggle}
        aria-pressed=${revealed}
        @click=${onToggle}
      >
        ${revealed ? icons.eye : icons.eyeOff}
      </button>
    </openclaw-tooltip>
  `;
}

function renderForm(params: {
  props: LoginGateProps;
  feedback: LoginFailureFeedback | null;
  credentialMode: CredentialMode;
  onCredentialMode: (mode: CredentialMode) => void;
  withSubmit: boolean;
}) {
  const { props, feedback, credentialMode } = params;
  const invalidField = feedback?.placement === "form" ? feedback.field : undefined;
  const submitOnEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      props.onConnect();
    }
  };
  const isPassword = credentialMode === "password";
  const credentialValue = isPassword ? props.password : props.token;
  const credentialRevealed = isPassword ? props.showGatewayPassword : props.showGatewayToken;

  return html`
    <div class="login-gate__form">
      <div class="field">
        <label for="login-gate-url">${t("login.gatewayUrl")}</label>
        <input
          id="login-gate-url"
          inputmode="url"
          autocapitalize="none"
          autocorrect="off"
          autocomplete="off"
          spellcheck="false"
          enterkeyhint="go"
          aria-invalid=${invalidField === "url" ? "true" : nothing}
          .value=${props.gatewayUrl}
          @input=${(e: Event) => {
            props.onGatewayUrlChange((e.target as HTMLInputElement).value);
          }}
          @keydown=${submitOnEnter}
          placeholder="wss://gateway.example:443"
        />
      </div>
      <div class="field">
        <div class="login-gate__field-head">
          <label for="login-gate-credential">${t("login.credential")}</label>
          <div
            class="login-gate__segmented"
            role="radiogroup"
            aria-label=${t("login.credentialType")}
          >
            <button
              type="button"
              role="radio"
              aria-checked=${!isPassword}
              @click=${() => params.onCredentialMode("token")}
            >
              ${t("login.modeToken")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked=${isPassword}
              @click=${() => params.onCredentialMode("password")}
            >
              ${t("login.modePassword")}
            </button>
          </div>
        </div>
        <span class="settings-secret">
          <input
            id="login-gate-credential"
            type=${credentialRevealed ? "text" : "password"}
            autocomplete="off"
            spellcheck="false"
            enterkeyhint="go"
            aria-invalid=${invalidField === "credential" ? "true" : nothing}
            .value=${credentialValue}
            @input=${(e: Event) => {
              const value = (e.target as HTMLInputElement).value;
              // Editing pins the visible mode; otherwise clearing a token while a
              // password exists would flip this field and route keystrokes there.
              params.onCredentialMode(credentialMode);
              if (isPassword) {
                props.onPasswordChange(value);
              } else {
                props.onTokenChange(value);
              }
            }}
            @keydown=${submitOnEnter}
            placeholder=${isPassword ? t("login.passwordFieldPlaceholder") : t("login.tokenPlaceholder")}
          />
          ${
            isPassword
              ? renderSecretToggle(
                  props.showGatewayPassword,
                  [
                    t("login.showPassword"),
                    t("login.hidePassword"),
                    t("login.togglePasswordVisibility"),
                  ],
                  props.onToggleGatewayPassword,
                )
              : renderSecretToggle(
                  props.showGatewayToken,
                  [t("login.showToken"), t("login.hideToken"), t("login.toggleTokenVisibility")],
                  props.onToggleGatewayToken,
                )
          }
        </span>
        ${isPassword ? html`<span class="login-gate__field-hint">${t("login.passwordHint")}</span>` : nothing}
      </div>
      ${
        params.withSubmit
          ? html`
              <button class="btn primary login-gate__connect" @click=${props.onConnect}>
                ${t("common.connect")}
              </button>
            `
          : nothing
      }
    </div>
  `;
}

function renderConnectionSummary(props: LoginGateProps, credentialMode: CredentialMode) {
  const host = formatGatewayHost(props.gatewayUrl);
  const credential =
    credentialMode === "password" && props.password.trim()
      ? t("login.connection.passwordEntered")
      : props.token.trim()
        ? t("login.connection.tokenSaved")
        : t("login.connection.noCredential");
  return html`
    <summary>
      <span class="login-gate__connection-target">
        ${icons.server}
        <span>${t("login.connection.target", { host })}</span>
      </span>
      <span class="login-gate__connection-cred">· ${credential}</span>
      <span class="login-gate__connection-change">${t("login.connection.change")}</span>
    </summary>
  `;
}

function renderStatusBody(params: {
  props: LoginGateProps;
  feedback: LoginFailureFeedback;
  credentialMode: CredentialMode;
  onCredentialMode: (mode: CredentialMode) => void;
}) {
  const { props, feedback } = params;
  return html`
    <section
      class="login-gate__body login-gate__failure"
      role="status"
      aria-live="polite"
      data-kind=${feedback.kind}
      data-tone=${feedback.tone}
    >
      <div class="login-gate__status-head">
        <span class="login-gate__status-icon" aria-hidden="true">${TONE_ICONS[feedback.tone]}</span>
        <div class="login-gate__status-text">
          <h1 class="login-gate__failure-title">${feedback.title}</h1>
          <p class="login-gate__failure-summary">${feedback.summary}</p>
        </div>
      </div>
      ${
        feedback.primaryCommand
          ? html`
              <div class="login-gate__hero">
                <span class="login-gate__hero-label">${t("login.runOnHost")}</span>
                ${renderConnectCommand(feedback.primaryCommand, "hero")}
              </div>
            `
          : nothing
      }
      ${renderSteps(feedback)}
      <div class="login-gate__actions">
        ${renderRefreshAction(feedback)}
        <button class="btn login-gate__connect" @click=${props.onConnect}>
          ${t("common.connect")}
        </button>
      </div>
      <details class="login-gate__connection">
        ${renderConnectionSummary(props, params.credentialMode)}
        ${renderForm({ ...params, withSubmit: false })}
      </details>
      ${renderFailureFooter(feedback)}
    </section>
  `;
}

function renderFormBody(params: {
  props: LoginGateProps;
  feedback: LoginFailureFeedback | null;
  credentialMode: CredentialMode;
  onCredentialMode: (mode: CredentialMode) => void;
}) {
  const { feedback } = params;
  return html`
    <section
      class=${feedback ? "login-gate__body login-gate__failure" : "login-gate__body"}
      role=${feedback ? "status" : nothing}
      aria-live=${feedback ? "polite" : nothing}
      data-kind=${feedback?.kind ?? nothing}
      data-tone=${feedback?.tone ?? nothing}
    >
      <div class="login-gate__status-text">
        <h1 class=${feedback ? "login-gate__failure-title" : "login-gate__heading"}>
          ${feedback?.title ?? t("login.heading")}
        </h1>
        <p class=${feedback ? "login-gate__failure-summary" : "login-gate__lede"}>
          ${feedback?.summary ?? t("login.lede")}
        </p>
      </div>
      ${renderForm({ ...params, withSubmit: true })}
      ${
        feedback
          ? html`${renderSteps(feedback)} ${renderFailureFooter(feedback)}`
          : html`
              <details class="login-gate__help">
                <summary class="login-gate__help-title">${t("connection.help.title")}</summary>
                <ol class="login-gate__steps">
                  <li>
                    ${t("connection.help.step1")}${renderConnectCommand("openclaw gateway run")}
                  </li>
                  <li>
                    ${t("connection.help.step2")} ${renderConnectCommand("openclaw dashboard")}
                  </li>
                  <li>${t("connection.help.step3")}</li>
                </ol>
                <div class="login-gate__docs">
                  <a
                    class="session-link"
                    href="https://docs.openclaw.ai/web/dashboard"
                    target=${EXTERNAL_LINK_TARGET}
                    rel=${buildExternalLinkRel()}
                    >${t("connection.help.docsLink")}</a
                  >
                </div>
              </details>
            `
      }
    </section>
  `;
}

function renderLoginGate(
  props: LoginGateProps,
  credentialModeOverride: CredentialMode | null,
  onCredentialMode: (mode: CredentialMode) => void,
) {
  const resourceBasePath = normalizeBasePath(props.resourceBasePath);
  const faviconSrc = controlUiPublicAssetPath("favicon.svg", resourceBasePath);
  const feedback = resolveLoginFailureFeedback(props);
  const credentialMode = resolveCredentialMode(props, credentialModeOverride);
  const body =
    feedback?.placement === "status"
      ? renderStatusBody({ props, feedback, credentialMode, onCredentialMode })
      : renderFormBody({ props, feedback, credentialMode, onCredentialMode });

  return html`
    <div class="login-gate">
      <openclaw-toast-host></openclaw-toast-host>
      <div class="login-gate__card" data-mode=${feedback?.placement ?? "form"}>
        <header class="login-gate__brand">
          <img class="login-gate__logo" src=${faviconSrc} alt="" />
          <span class="login-gate__brand-name">OpenClaw</span>
        </header>
        ${body}
      </div>
    </div>
  `;
}

class LoginGate extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) props?: LoginGateProps;
  // Operator choice sticks across rerenders; otherwise the mode follows the props/error.
  @state() private credentialMode: CredentialMode | null = null;

  override render() {
    return this.props
      ? renderLoginGate(this.props, this.credentialMode, (mode) => {
          this.credentialMode = mode;
        })
      : nothing;
  }
}

if (!customElements.get("openclaw-login-gate")) {
  customElements.define("openclaw-login-gate", LoginGate);
}
