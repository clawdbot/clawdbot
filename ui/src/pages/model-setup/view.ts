import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import {
  hasProviderBrandIcon,
  renderProviderBrandIcon,
  renderProviderFallbackIcon,
} from "../../components/provider-icon.ts";
import { syncDropdownItemRadio } from "../../components/web-awesome.ts";
import { t } from "../../i18n/index.ts";
import "../../styles/model-setup.css";
import { listModelSetupPrepareOptions, type ModelSetupPrepareOption } from "./prepare-options.ts";
import {
  focusSelectedManualProvider,
  handleManualProviderKeydown,
  handleManualProviderSelect,
  type WebAwesomeSelectEvent,
} from "./provider-picker.ts";
import type {
  ModelSetupActivationState,
  ModelSetupPageState,
  ModelSetupVerifyState,
  ModelSetupWizardState,
} from "./state.ts";
import { activationTargetId } from "./state.ts";
import { renderModelSetupSuccessDialog } from "./success-dialog.ts";
import { renderModelSetupWizard } from "./wizard-view.ts";

type Candidate = SystemAgentSetupDetectResult["candidates"][number];
type AuthOption = NonNullable<SystemAgentSetupDetectResult["authOptions"]>[number];
type ManualProvider = SystemAgentSetupDetectResult["manualProviders"][number];
type SetupIconEntry = {
  brandId?: string;
  label: string;
  icon?: string;
};

export function resolveSetupBrandIcon(entry: SetupIconEntry): string | null {
  // Only new Gateways provide authoritative local brand identity. Legacy
  // payloads stay on their remote artwork path instead of guessing from labels.
  return entry.brandId && hasProviderBrandIcon(entry.brandId) ? entry.brandId : null;
}

function renderProviderIcon(
  props: Pick<ModelSetupViewProps, "iconUrls" | "onIconError">,
  entry: SetupIconEntry,
  className = "",
) {
  const localBrand = resolveSetupBrandIcon(entry);
  if (localBrand) {
    return renderProviderBrandIcon(localBrand, {
      className: `model-setup__icon ${className}`.trim(),
    });
  }
  const blobUrl = entry.icon ? props.iconUrls[entry.icon] : undefined;
  if (!entry.icon || !blobUrl) {
    return renderProviderFallbackIcon(entry.label, {
      className: `model-setup__icon ${className}`.trim(),
    });
  }
  return html`<img
    class=${`model-setup__icon ${className}`.trim()}
    src=${blobUrl}
    alt=${entry.label}
    width="24"
    height="24"
    @error=${() => props.onIconError(entry.icon!)}
  />`;
}

type ModelSetupViewProps = {
  page: ModelSetupPageState;
  activation: ModelSetupActivationState;
  verify: ModelSetupVerifyState;
  wizard: ModelSetupWizardState;
  wizardMode: "auth" | "prepare";
  wizardValue: unknown;
  canAdmin: boolean;
  canVerify: boolean;
  canPrepare: boolean;
  gatewayTooOld: boolean;
  actionsDisabled: boolean;
  manualProviderId: string;
  manualApiKey: string;
  manualError: string | null;
  moreSignInOpen: boolean;
  firstRun: boolean;
  iconUrls: Readonly<Record<string, string>>;
  onDetect: () => void;
  onVerify: () => void;
  onActivateCandidate: (candidate: Candidate) => void;
  onStartAuth: (option: AuthOption) => void;
  onStartPrepare: (option: ModelSetupPrepareOption) => void;
  onManualProviderChange: (providerId: string) => void;
  onUseManualProvider: (providerId: string) => void;
  onManualApiKeyChange: (apiKey: string) => void;
  onManualConnect: () => void;
  onMoreSignInToggle: (open: boolean) => void;
  onIconError: (iconUrl: string) => void;
  onOpenChat: () => void;
  onSuccessClose: () => void;
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

function renderCandidateRows(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  // The current connection already owns verification and status. Keep the
  // existing-model candidate only for older Gateways that lack that surface.
  const candidates = result.configuredModel
    ? result.candidates.filter((candidate) => candidate.kind !== "existing-model")
    : result.candidates;
  if (candidates.length === 0) {
    return nothing;
  }
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2>${t("modelSetup.candidates.title")}</h2>
      </div>
      <div class="model-setup__rows">
        ${candidates.map((candidate) => {
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
                  ${renderProviderIcon(props, candidate)}
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
              ${renderProviderIcon(props, install, "model-setup__icon--recommendation")}
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

function renderUnavailable(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  if (!result.unavailableCandidates?.length) {
    return nothing;
  }
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2>${t("modelSetup.unavailable.title")}</h2>
      </div>
      <div class="model-setup__rows">
        ${result.unavailableCandidates.map((candidate) => {
          const authOption = (result.authOptions ?? []).find(
            (option) => option.id === candidate.authOptionId,
          );
          const manualProvider = result.manualProviders.find(
            (provider) => provider.id === candidate.manualProviderId,
          );
          return html`
            <div
              class="model-setup__row model-setup__row--info"
              data-unavailable-candidate=${candidate.id}
            >
              <div class="model-setup__provider-copy">
                ${renderProviderIcon(props, candidate)}
                <div>
                  <div><strong>${candidate.label}</strong> — ${candidate.detail}</div>
                  <div class="muted">${candidate.reason}</div>
                </div>
              </div>
              <div class="model-setup__row-actions">
                ${authOption
                  ? html`<button
                      type="button"
                      class="btn primary"
                      ?disabled=${props.actionsDisabled}
                      @click=${() => props.onStartAuth(authOption)}
                    >
                      ${t("modelSetup.unavailable.signIn", {
                        provider: authOption.groupLabel ?? authOption.label,
                      })}
                    </button>`
                  : nothing}
                ${manualProvider
                  ? html`<button
                      type="button"
                      class="btn"
                      ?disabled=${props.actionsDisabled}
                      @click=${() => props.onUseManualProvider(manualProvider.id)}
                    >
                      ${t("modelSetup.unavailable.useApiKey")}
                    </button>`
                  : nothing}
                <button
                  type="button"
                  class="btn"
                  ?disabled=${props.actionsDisabled}
                  @click=${props.onDetect}
                >
                  ${t("modelSetup.checkAgain")}
                </button>
              </div>
            </div>
          `;
        })}
      </div>
    </section>
  `;
}

function renderAuthRow(props: ModelSetupViewProps, option: AuthOption) {
  return html`
    <div class="model-setup__row" data-auth-choice=${option.id}>
      <div class="model-setup__provider-copy">
        ${renderProviderIcon(props, option)}
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

function renderPrepare(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  if (!props.canPrepare) {
    return nothing;
  }
  const options = listModelSetupPrepareOptions(result);
  if (options.length === 0) {
    return nothing;
  }
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2>${t("modelSetup.prepare.title")}</h2>
      </div>
      <p class="muted">${t("modelSetup.prepare.intro")}</p>
      <div class="model-setup__rows">
        ${options.map(
          (option) => html`
            <div class="model-setup__row" data-prepare-choice=${option.id}>
              <div class="model-setup__provider-copy">
                ${renderProviderIcon(props, option)}
                <div>
                  <strong>${option.label}</strong>
                  ${option.hint ? html`<div class="muted">${option.hint}</div>` : nothing}
                </div>
              </div>
              <button
                type="button"
                class="btn"
                ?disabled=${props.actionsDisabled}
                @click=${() => props.onStartPrepare(option)}
              >
                ${t("modelSetup.prepare.ollamaButton")}
              </button>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

function manualProviderName(provider: ManualProvider): string {
  return provider.groupLabel?.trim() || provider.label;
}

function manualProviderMethod(provider: ManualProvider): string | undefined {
  const method = provider.label.trim();
  return method === manualProviderName(provider) ? undefined : method;
}

function renderManualProviderPicker(
  props: ModelSetupViewProps,
  result: SystemAgentSetupDetectResult,
  provider: ManualProvider | undefined,
) {
  const providerMethod = provider ? manualProviderMethod(provider) : undefined;
  const triggerLabel = provider
    ? [manualProviderName(provider), providerMethod].filter(Boolean).join(", ")
    : t("modelSetup.manual.selectProvider");
  return html`
    <wa-dropdown
      class="model-setup-provider-select"
      placement="bottom-start"
      aria-label=${t("modelSetup.manual.provider")}
      @wa-select=${(event: WebAwesomeSelectEvent) =>
        handleManualProviderSelect(event, props.manualProviderId, props.onManualProviderChange)}
      @wa-after-show=${focusSelectedManualProvider}
      @keydown=${handleManualProviderKeydown}
    >
      <button
        slot="trigger"
        type="button"
        class="model-setup-provider-select__trigger"
        aria-label=${`${t("modelSetup.manual.provider")}: ${triggerLabel}`}
        ?disabled=${props.actionsDisabled || result.manualProviders.length === 0}
      >
        ${provider
          ? renderProviderIcon(props, provider, "model-setup__icon--picker")
          : html`<span class="model-setup-provider-select__placeholder-icon" aria-hidden="true">
              ${icons.key}
            </span>`}
        <span class="model-setup-provider-select__copy">
          <strong>
            ${provider ? manualProviderName(provider) : t("modelSetup.manual.selectProvider")}
          </strong>
          ${provider
            ? providerMethod
              ? html`<span>${providerMethod}</span>`
              : nothing
            : html`<span>${t("modelSetup.manual.selectProviderHint")}</span>`}
        </span>
        <span class="model-setup-provider-select__chevron" aria-hidden="true">
          ${icons.chevronDown}
        </span>
      </button>
      ${result.manualProviders.map((entry) => {
        const selected = entry.id === props.manualProviderId;
        const entryMethod = manualProviderMethod(entry);
        const accessibleLabel = [manualProviderName(entry), entryMethod, entry.hint]
          .filter(Boolean)
          .join(", ");
        return html`
          <wa-dropdown-item
            class="model-setup-provider-select__option"
            data-manual-provider=${entry.id}
            ?data-selected=${selected}
            aria-label=${accessibleLabel}
            .value=${entry.id}
            type="checkbox"
            .checked=${selected}
            ?disabled=${props.actionsDisabled}
            ${ref((element) => syncDropdownItemRadio(element, selected))}
          >
            <span slot="icon">
              ${renderProviderIcon(props, entry, "model-setup__icon--picker")}
            </span>
            <span class="model-setup-provider-select__copy">
              <strong>${manualProviderName(entry)}</strong>
              ${entryMethod ? html`<span>${entryMethod}</span>` : nothing}
              ${entry.hint ? html`<small>${entry.hint}</small>` : nothing}
            </span>
          </wa-dropdown-item>
        `;
      })}
    </wa-dropdown>
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
        <div class="field">
          <span>${t("modelSetup.manual.provider")}</span>
          ${renderManualProviderPicker(props, result, provider)}
        </div>
        <label class="field">
          <span>
            ${provider
              ? t("modelSetup.manual.accessValueFor", { provider: manualProviderName(provider) })
              : t("modelSetup.manual.accessValue")}
          </span>
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
        <div class="model-setup__manual-help">
          ${icons.shieldCheck}
          <span>${t("modelSetup.manual.verifyHint")}</span>
        </div>
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
          ${testing
            ? t("modelSetup.candidates.testingButton")
            : t("modelSetup.manual.connectAndVerify")}
        </button>
      </div>
    </section>
  `;
}

function renderReady(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
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
    ${renderUnavailable(props, result)} ${renderPrepare(props, result)}
    ${renderSignIn(props, result)} ${renderManual(props, result)}
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
      mode: props.wizardMode,
      state: props.wizard,
      value: props.wizardValue,
      onValueChange: props.onWizardValueChange,
      onAnswer: props.onWizardAnswer,
      onCancel: props.onWizardCancel,
      onClose: props.onWizardClose,
    })}
    ${props.activation.phase === "success"
      ? renderModelSetupSuccessDialog(
          props.activation,
          props.onOpenChat,
          props.onSuccessClose,
          props.firstRun,
        )
      : nothing}
  `;
}
