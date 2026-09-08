// Control UI component renders the login gate.
import { html, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { normalizeBasePath } from "../app-route-paths.ts";
import { canReloadControlUiDocument } from "../app/document-reload-guard.ts";
import { controlUiPublicAssetPath } from "../app/public-assets.ts";
import { t } from "../i18n/index.ts";
import "../lib/toast.ts";
import { registerLoginEnglish } from "../i18n/locales/en-login.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { formatGatewayHost } from "../lib/gateway-host.ts";
import { classifyGatewaySecret } from "../lib/gateway-secret-shape.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { renderConnectCommand } from "./connect-command.ts";
import { icons } from "./icons.ts";
import {
  type LoginFailureFeedback,
  type LoginFailureFeedbackParams,
  type LoginFailureStep,
  type LoginFailureTone,
  resolveLoginFailureFeedback,
} from "./login-gate-feedback.ts";

registerLoginEnglish();

type LoginGateProps = LoginFailureFeedbackParams & {
  resourceBasePath: string;
  gatewayUrl: string;
  secret: string;
  showGatewaySecret: boolean;
  onGatewayUrlChange: (value: string) => void;
  onSecretChange: (value: string) => void;
  onToggleGatewaySecret: () => void;
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
  withSubmit: boolean;
}) {
  const { props, feedback } = params;
  const isSetupCode = classifyGatewaySecret(props.secret) === "setup-code";
  const invalidField = feedback?.placement === "form" ? feedback.field : undefined;
  const submitOnEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      props.onConnect();
    }
  };

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
        <label for="login-gate-credential">${t("login.secret")}</label>
        <span class="settings-secret">
          <input
            id="login-gate-credential"
            type=${props.showGatewaySecret ? "text" : "password"}
            autocomplete="off"
            spellcheck="false"
            enterkeyhint="go"
            aria-invalid=${invalidField === "credential" ? "true" : nothing}
            aria-describedby=${isSetupCode ? "login-gate-secret-hint" : nothing}
            .value=${props.secret}
            @input=${(e: Event) => {
              props.onSecretChange((e.target as HTMLInputElement).value);
            }}
            @keydown=${submitOnEnter}
            placeholder=${t("login.secretPlaceholder")}
          />
          ${renderSecretToggle(
            props.showGatewaySecret,
            [t("login.showSecret"), t("login.hideSecret"), t("login.toggleSecretVisibility")],
            props.onToggleGatewaySecret,
          )}
        </span>
        ${isSetupCode ? html`<p id="login-gate-secret-hint" class="muted" role="status">${t("login.setupCodeHint")}</p>` : nothing}
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

function renderConnectionSummary(props: LoginGateProps) {
  const host = formatGatewayHost(props.gatewayUrl);
  const credential = props.secret.trim()
    ? t("login.connection.secretEntered")
    : t("login.connection.noSecret");
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

function renderStatusBody(params: { props: LoginGateProps; feedback: LoginFailureFeedback }) {
  const { props, feedback } = params;
  const waitingForPairing = feedback.kind === "pairing-required" && props.reconnectPending;
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
      ${
        waitingForPairing
          ? html`<p class="login-gate__failure-summary">
              <span class="session-run-spinner" aria-hidden="true"></span>
              ${t("login.failure.pairing.waiting")}
            </p>`
          : nothing
      }
      <div class="login-gate__actions">
        ${renderRefreshAction(feedback)}
        <button class="btn login-gate__connect" @click=${props.onConnect}>
          ${waitingForPairing ? t("login.failure.pairing.checkNow") : t("common.connect")}
        </button>
      </div>
      <details class="login-gate__connection">
        ${renderConnectionSummary(props)} ${renderForm({ ...params, withSubmit: false })}
      </details>
      ${renderFailureFooter(feedback)}
    </section>
  `;
}

function renderFormBody(params: { props: LoginGateProps; feedback: LoginFailureFeedback | null }) {
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

function renderLoginGate(props: LoginGateProps) {
  const resourceBasePath = normalizeBasePath(props.resourceBasePath);
  const faviconSrc = controlUiPublicAssetPath("favicon.svg", resourceBasePath);
  const feedback = resolveLoginFailureFeedback(props);
  const body =
    feedback?.placement === "status"
      ? renderStatusBody({ props, feedback })
      : renderFormBody({ props, feedback });

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

  override render() {
    return this.props ? renderLoginGate(this.props) : nothing;
  }
}

if (!customElements.get("openclaw-login-gate")) {
  customElements.define("openclaw-login-gate", LoginGate);
}
