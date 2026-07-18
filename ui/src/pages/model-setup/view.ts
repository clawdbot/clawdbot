import { html, nothing, type TemplateResult } from "lit";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import "../../styles/model-setup.css";
import type {
  ModelSetupActivationState,
  ModelSetupPageState,
  ModelSetupVerifyState,
  ModelSetupWizardState,
} from "./state.ts";
import { activationTargetId } from "./state.ts";
import { renderModelSetupWizard } from "./wizard-view.ts";

type Candidate = SystemAgentSetupDetectResult["candidates"][number];
type AuthOption = NonNullable<SystemAgentSetupDetectResult["authOptions"]>[number];

function renderProviderIcon(
  props: Pick<ModelSetupViewProps, "iconUrls" | "onIconError">,
  icon: string | undefined,
  label: string,
  className = "",
) {
  const blobUrl = icon ? props.iconUrls[icon] : undefined;
  if (!icon || !blobUrl) {
    return nothing;
  }
  return html`<img
    class=${`model-setup__icon ${className}`.trim()}
    src=${blobUrl}
    alt=${label}
    width="24"
    height="24"
    @error=${() => props.onIconError(icon)}
  />`;
}

type ModelSetupViewProps = {
  page: ModelSetupPageState;
  activation: ModelSetupActivationState;
  verify: ModelSetupVerifyState;
  wizard: ModelSetupWizardState;
  wizardValue: unknown;
  canAdmin: boolean;
  canVerify: boolean;
  gatewayTooOld: boolean;
  actionsDisabled: boolean;
  manualProviderId: string;
  manualApiKey: string;
  manualError: string | null;
  moreSignInOpen: boolean;
  iconUrls: Readonly<Record<string, string>>;
  onDetect: () => void;
  onVerify: () => void;
  onActivateCandidate: (candidate: Candidate) => void;
  onStartAuth: (option: AuthOption) => void;
  onManualProviderChange: (providerId: string) => void;
  onManualApiKeyChange: (apiKey: string) => void;
  onManualConnect: () => void;
  onMoreSignInToggle: (open: boolean) => void;
  onIconError: (iconUrl: string) => void;
  onOpenChat: () => void;
  onWizardValueChange: (value: unknown) => void;
  onWizardAnswer: (value: unknown, includeValue?: boolean) => void;
  onWizardCancel: () => void;
  onWizardClose: () => void;
};

function candidateStatus(candidate: Candidate): string {
  if (candidate.recommended) {
    return t("modelSetup.candidates.recommended");
  }
  if (candidate.credentials === true) {
    return t("modelSetup.candidates.credentialsReady");
  }
  if (candidate.credentials === false) {
    return t("modelSetup.candidates.signInNeeded");
  }
  return t("modelSetup.candidates.detected");
}

function failureLabel(status: string): string {
  const labels: Record<string, string> = {
    auth: t("modelSetup.failure.auth"),
    rate_limit: t("modelSetup.failure.rateLimit"),
    billing: t("modelSetup.failure.billing"),
    timeout: t("modelSetup.failure.timeout"),
    format: t("modelSetup.failure.format"),
    unavailable: t("modelSetup.failure.unavailable"),
    unknown: t("modelSetup.failure.unknown"),
  };
  return labels[status] ?? labels.unknown!;
}

function renderSuccess(
  activation: Extract<ModelSetupActivationState, { phase: "success" }>,
  onOpenChat: () => void,
) {
  return html`
    <div class="model-setup__success" role="status">
      <div>
        <strong>${t("modelSetup.success.title")}</strong>
        <div>
          ${activation.latencyMs === undefined
            ? activation.modelRef
            : t("modelSetup.success.detail", {
                modelRef: activation.modelRef,
                latencyMs: String(activation.latencyMs),
              })}
        </div>
      </div>
      <button type="button" class="btn primary" @click=${onOpenChat}>
        ${t("modelSetup.success.openChat")}
      </button>
    </div>
  `;
}

function renderCandidateRows(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  if (result.candidates.length === 0) {
    return nothing;
  }
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2>${t("modelSetup.candidates.title")}</h2>
      </div>
      <div class="model-setup__rows">
        ${result.candidates.map((candidate) => {
          const testing =
            props.activation.phase === "testing" &&
            props.activation.targetId === activationTargetId(candidate.kind, candidate.modelRef);
          const failure =
            props.activation.phase === "failure" &&
            props.activation.targetId === activationTargetId(candidate.kind, candidate.modelRef)
              ? props.activation
              : null;
          return html`
            <div class="model-setup__row" data-candidate-kind=${candidate.kind}>
              <div class="model-setup__row-main">
                <div class="model-setup__row-title">
                  ${renderProviderIcon(props, candidate.icon, candidate.label)}
                  <strong>${candidate.label}</strong>
                  <span class="model-setup__chip">${candidateStatus(candidate)}</span>
                </div>
                <div class="muted">${candidate.modelRef} · ${candidate.detail}</div>
                ${testing
                  ? html`<div class="model-setup__testing" role="status">
                      ${t("modelSetup.candidates.testing", { modelRef: candidate.modelRef })}
                    </div>`
                  : nothing}
                ${failure
                  ? html`<div class="callout danger" role="alert">
                      <strong>${failureLabel(failure.status)}</strong> ${failure.error}
                    </div>`
                  : nothing}
              </div>
              <button
                type="button"
                class="btn primary"
                ?disabled=${props.actionsDisabled}
                @click=${() => props.onActivateCandidate(candidate)}
              >
                ${testing
                  ? t("modelSetup.candidates.testingButton")
                  : t("modelSetup.candidates.testAndUse")}
              </button>
            </div>
          `;
        })}
      </div>
    </section>
  `;
}

function renderEmptyState(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  const installs = result.recommendedInstalls ?? [];
  if (
    result.candidates.length > 0 ||
    (result.authOptions?.length ?? 0) > 0 ||
    installs.length === 0
  ) {
    return nothing;
  }
  return html`
    <section class="settings-section model-setup__empty">
      <div class="settings-section__header">
        <h2>${t("modelSetup.empty.title")}</h2>
      </div>
      <p class="muted">${t("modelSetup.empty.intro")}</p>
      <div class="model-setup__recommendations">
        ${installs.map(
          (install) => html`
            <div class="model-setup__recommendation" data-recommended-install=${install.id}>
              ${renderProviderIcon(
                props,
                install.icon,
                install.label,
                "model-setup__icon--recommendation",
              )}
              <div class="model-setup__row-main">
                <strong>${install.label}</strong>
                <div class="muted">${install.hint}</div>
                <a href=${install.website} target="_blank" rel="noopener">${install.website}</a>
              </div>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

function renderCurrentConnection(props: ModelSetupViewProps, modelRef: string) {
  // A successful verify reports the model that actually answered; prefer it over
  // the detect-time snapshot so concurrent config changes cannot mislabel the result.
  const displayRef = props.verify.phase === "ok" ? props.verify.modelRef : modelRef;
  return html`
    <section class="settings-section model-setup__current" data-verify-phase=${props.verify.phase}>
      <div class="settings-section__header">
        <h2>${t("modelSetup.verify.title")}</h2>
      </div>
      <div class="model-setup__row">
        <div class="model-setup__row-main">
          <strong>${displayRef}</strong>
          ${props.verify.phase === "checking"
            ? html`<div class="model-setup__testing" role="status">
                ${t("modelSetup.verify.checking", { modelRef })}
              </div>`
            : props.verify.phase === "ok"
              ? html`<div class="model-setup__verified" role="status">
                  ${props.verify.latencyMs === undefined
                    ? t("modelSetup.verify.answered")
                    : t("modelSetup.verify.answeredIn", {
                        latencyMs: String(props.verify.latencyMs),
                      })}
                </div>`
              : props.verify.phase === "failed"
                ? html`<div class="callout danger" role="alert">
                    <strong>${failureLabel(props.verify.status)}</strong> ${props.verify.error}
                  </div>`
                : nothing}
        </div>
        ${props.canVerify
          ? html`<button
              type="button"
              class="btn"
              ?disabled=${props.actionsDisabled}
              @click=${props.onVerify}
            >
              ${t("modelSetup.verify.button")}
            </button>`
          : nothing}
      </div>
    </section>
  `;
}

function renderUnavailable(result: SystemAgentSetupDetectResult) {
  if (!result.unavailableCandidates?.length) {
    return nothing;
  }
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2>${t("modelSetup.unavailable.title")}</h2>
      </div>
      <div class="model-setup__rows">
        ${result.unavailableCandidates.map(
          (candidate) => html`
            <div class="model-setup__row model-setup__row--info">
              <div>
                <div><strong>${candidate.label}</strong> — ${candidate.detail}</div>
                <div>${candidate.reason}</div>
              </div>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

function renderAuthRow(props: ModelSetupViewProps, option: AuthOption) {
  return html`
    <div class="model-setup__row" data-auth-choice=${option.id}>
      <div class="model-setup__provider-copy">
        ${renderProviderIcon(props, option.icon, option.label)}
        <div>
          <strong>${option.label}</strong>
          ${option.groupLabel ? html`<div class="muted">${option.groupLabel}</div>` : nothing}
          ${option.hint ? html`<div class="muted">${option.hint}</div>` : nothing}
        </div>
      </div>
      <button
        type="button"
        class="btn"
        ?disabled=${props.actionsDisabled}
        @click=${() => props.onStartAuth(option)}
      >
        ${option.kind === "device-code"
          ? t("modelSetup.signIn.pair")
          : t("modelSetup.signIn.signIn")}
      </button>
    </div>
  `;
}

function renderSignIn(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  const options = (result.authOptions ?? []).toSorted(
    (left, right) => Number(right.featured) - Number(left.featured),
  );
  if (options.length === 0) {
    return nothing;
  }
  const featured = options.filter((option) => option.featured);
  const more = options.filter((option) => !option.featured);
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2>${t("modelSetup.signIn.title")}</h2>
      </div>
      <div class="model-setup__rows">${featured.map((option) => renderAuthRow(props, option))}</div>
      ${more.length
        ? html`<details
            class="model-setup__more"
            .open=${props.moreSignInOpen}
            @toggle=${(event: Event) =>
              props.onMoreSignInToggle((event.currentTarget as HTMLDetailsElement).open)}
          >
            <summary>${t("modelSetup.signIn.more")}</summary>
            <div class="model-setup__rows">
              ${more.map((option) => renderAuthRow(props, option))}
            </div>
          </details>`
        : nothing}
    </section>
  `;
}

function renderManual(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  const provider = result.manualProviders.find((entry) => entry.id === props.manualProviderId);
  const targetId = `manual:${props.manualProviderId}`;
  const testing = props.activation.phase === "testing" && props.activation.targetId === targetId;
  const failure =
    props.activation.phase === "failure" && props.activation.targetId === targetId
      ? props.activation
      : null;
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2>${t("modelSetup.manual.title")}</h2>
      </div>
      <div class="model-setup__manual">
        <label class="field">
          <span>${t("modelSetup.manual.provider")}</span>
          <div class="model-setup__manual-provider">
            ${renderProviderIcon(props, provider?.icon, provider?.label ?? "")}
            <select
              ?disabled=${props.actionsDisabled}
              @change=${(event: Event) =>
                props.onManualProviderChange((event.currentTarget as HTMLSelectElement).value)}
            >
              <option value="" ?selected=${!props.manualProviderId}>
                ${t("modelSetup.manual.selectProvider")}
              </option>
              ${result.manualProviders.map(
                (entry) => html`
                  <option value=${entry.id} ?selected=${entry.id === props.manualProviderId}>
                    ${entry.label}
                  </option>
                `,
              )}
            </select>
          </div>
        </label>
        ${provider?.hint ? html`<div class="muted">${provider.hint}</div>` : nothing}
        <label class="field">
          <span>${t("modelSetup.manual.accessValue")}</span>
          <input
            class="input"
            type="password"
            autocomplete="off"
            .value=${props.manualApiKey}
            ?disabled=${props.actionsDisabled}
            placeholder=${t("modelSetup.manual.accessValuePlaceholder")}
            @input=${(event: Event) =>
              props.onManualApiKeyChange((event.currentTarget as HTMLInputElement).value)}
          />
        </label>
        ${props.manualError
          ? html`<div class="callout danger" role="alert">${props.manualError}</div>`
          : nothing}
        ${testing
          ? html`<div class="model-setup__testing" role="status">
              ${t("modelSetup.candidates.testing", { modelRef: provider?.label ?? targetId })}
            </div>`
          : nothing}
        ${failure
          ? html`<div class="callout danger" role="alert">
              <strong>${failureLabel(failure.status)}</strong> ${failure.error}
            </div>`
          : nothing}
        <button
          type="button"
          class="btn primary"
          ?disabled=${props.actionsDisabled || !props.manualProviderId}
          @click=${props.onManualConnect}
        >
          ${testing ? t("modelSetup.candidates.testingButton") : t("modelSetup.manual.connect")}
        </button>
      </div>
    </section>
  `;
}

function renderReady(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  if (props.activation.phase === "success") {
    return renderSuccess(props.activation, props.onOpenChat);
  }
  const current = result.configuredModel
    ? renderCurrentConnection(props, result.configuredModel)
    : nothing;
  if (!props.canAdmin) {
    return html`${current}
      <div class="callout warning" role="note">${t("modelSetup.access.adminRequired")}</div>`;
  }
  if (props.gatewayTooOld) {
    return html`${current}
      <div class="callout warning" role="note">${t("modelSetup.access.gatewayTooOld")}</div>`;
  }
  return html`
    ${current} ${renderEmptyState(props, result)} ${renderCandidateRows(props, result)}
    ${renderUnavailable(result)} ${renderSignIn(props, result)} ${renderManual(props, result)}
  `;
}

export function renderModelSetup(props: ModelSetupViewProps): TemplateResult {
  let body: unknown;
  if (props.page.phase === "ready") {
    body = renderReady(props, props.page.result);
  } else if (!props.canAdmin) {
    body = html`<div class="callout warning" role="note">
      ${t("modelSetup.access.adminRequired")}
    </div>`;
  } else if (props.gatewayTooOld) {
    body = html`<div class="callout warning" role="note">
      ${t("modelSetup.access.gatewayTooOld")}
    </div>`;
  } else if (props.page.phase === "loading") {
    body = html`<div class="model-setup__loading" role="status">${t("modelSetup.loading")}</div>`;
  } else if (props.page.phase === "detect-error") {
    body = html`
      <div class="callout danger" role="alert">${props.page.message}</div>
      <button type="button" class="btn" @click=${props.onDetect}>${t("modelSetup.retry")}</button>
    `;
  }
  return html`
    <div class="model-setup">
      <div class="model-setup__intro">
        <div>
          <h1>${t("modelSetup.heading")}</h1>
          <p>${t("modelSetup.intro")}</p>
        </div>
        ${props.page.phase === "ready" &&
        props.activation.phase !== "success" &&
        props.canAdmin &&
        !props.gatewayTooOld
          ? html`<button
              type="button"
              class="btn"
              ?disabled=${props.actionsDisabled}
              @click=${props.onDetect}
            >
              ${t("modelSetup.checkAgain")}
            </button>`
          : nothing}
      </div>
      ${body}
    </div>
    ${renderModelSetupWizard({
      state: props.wizard,
      value: props.wizardValue,
      onValueChange: props.onWizardValueChange,
      onAnswer: props.onWizardAnswer,
      onCancel: props.onWizardCancel,
      onClose: props.onWizardClose,
    })}
  `;
}
