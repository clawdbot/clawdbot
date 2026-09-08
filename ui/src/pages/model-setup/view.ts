import { html, nothing, type TemplateResult } from "lit";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { icons } from "../../components/icons.ts";
import { renderLearnMoreLink } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import "../../styles/model-setup.css";
import { renderModelSetupFailure, renderConfiguredModel } from "./configured-model.ts";
import { renderProviderIcon } from "./model-setup-icon-loader.ts";
import { listModelSetupPrepareOptions, type ModelSetupPrepareOption } from "./prepare-options.ts";
import { manualProviderName, renderManualProviderPicker } from "./provider-picker.ts";
import type {
  ModelSetupActivationState,
  ModelSetupPageState,
  ModelSetupVerifyState,
  ModelSetupWizardState,
} from "./state.ts";
import { activationTargetId } from "./state.ts";
import { renderModelSetupSuccessDialog } from "./success-dialog.ts";
import { renderModelSetupWizard } from "./wizard-view.ts";

const MODEL_SETUP_DOCS_URL = "https://docs.openclaw.ai/concepts/model-providers";

type Candidate = SystemAgentSetupDetectResult["candidates"][number];
type AuthOption = NonNullable<SystemAgentSetupDetectResult["authOptions"]>[number];
type ModelSetupViewProps = {
  page: ModelSetupPageState;
  activation: ModelSetupActivationState;
  verify: ModelSetupVerifyState;
  wizard: ModelSetupWizardState;
  wizardMode: "auth" | "prepare" | "activate";
  wizardValue: unknown;
  canAdmin: boolean;
  canVerify: boolean;
  canPrepare: boolean;
  modelConfigured?: boolean;
  gatewayTooOld: boolean;
  refreshWarning: string | null;
  cancellationNotice?: string | null;
  activationUnresolved?: boolean;
  onUseCurrentModel?: () => void;
  actionsDisabled: boolean;
  manualProviderId: string;
  manualApiKey: string;
  manualError: string | null;
  moreSignInOpen: boolean;
  firstRun: boolean;
  nativeSessionCatalogsEnabled?: boolean;
  onNativeSessionCatalogsChange?: (enabled: boolean) => void;
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

function renderCandidateRows(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  // The current connection owns verification and recovery for the configured
  // route, including provider-auto candidates returned by newer Gateways.
  const candidates = result.configuredModel
    ? result.candidates.filter(
        (candidate) =>
          candidate.kind !== "existing-model" && candidate.modelRef !== result.configuredModel,
      )
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
        ${candidates
          .toSorted((a, b) => a.label.localeCompare(b.label))
          .map((candidate) => {
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
                  <div class="muted">
                    ${candidate.modelRef} · ${formatUiExternalText(candidate.detail)}
                  </div>
                </div>
                <div class="model-setup__row-actions">
                  <button
                    type="button"
                    class=${`btn ${failure ? "" : "primary"}`}
                    ?disabled=${props.actionsDisabled}
                    @click=${() => props.onActivateCandidate(candidate)}
                  >
                    <span>
                      ${
                        testing
                          ? t("modelSetup.candidates.testingButton")
                          : failure
                            ? t("modelSetup.candidates.retry")
                            : t("modelSetup.candidates.testAndUse")
                      }
                    </span>
                  </button>
                </div>
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
                  <div>
                    <strong>${candidate.label}</strong> — ${formatUiExternalText(candidate.detail)}
                  </div>
                  <div class="muted">${formatUiExternalText(candidate.reason)}</div>
                </div>
              </div>
              <div class="model-setup__row-actions">
                ${
                  authOption
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
                    : nothing
                }
                ${
                  manualProvider
                    ? html`<button
                        type="button"
                        class="btn"
                        ?disabled=${props.actionsDisabled}
                        @click=${() => props.onUseManualProvider(manualProvider.id)}
                      >
                        ${t("modelSetup.unavailable.useApiKey")}
                      </button>`
                    : nothing
                }
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
        ${
          option.kind === "device-code"
            ? t("modelSetup.signIn.pair")
            : option.kind === "install"
              ? t("modelSetup.signIn.install")
              : option.kind === "custom"
                ? t("modelSetup.signIn.custom")
                : t("modelSetup.signIn.signIn")
        }
      </button>
    </div>
  `;
}

function renderSignIn(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  const options = (result.authOptions ?? []).toSorted((a, b) => a.label.localeCompare(b.label));
  if (options.length === 0) {
    return nothing;
  }
  const featured = options.filter(
    (option) => option.featured || option.kind === "install" || option.kind === "custom",
  );
  const more = options.filter((option) => !featured.includes(option));
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2>${t("modelSetup.signIn.title")}</h2>
      </div>
      <div class="model-setup__rows">${featured.map((option) => renderAuthRow(props, option))}</div>
      ${
        more.length
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
          : nothing
      }
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
                ${option.actionLabel ?? t("modelSetup.prepare.ollamaButton")}
              </button>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

function renderManual(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  const provider = result.manualProviders.find((entry) => entry.id === props.manualProviderId);
  const targetId = `manual:${props.manualProviderId}`;
  const testing = props.activation.phase === "testing" && props.activation.targetId === targetId;
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
            ${
              provider
                ? t("modelSetup.manual.accessValueFor", { provider: manualProviderName(provider) })
                : t("modelSetup.manual.accessValue")
            }
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
        ${
          props.manualError
            ? html`<div class="callout danger" role="alert">${props.manualError}</div>`
            : nothing
        }
        <button
          type="button"
          class="btn primary"
          ?disabled=${props.actionsDisabled || !props.manualProviderId}
          @click=${props.onManualConnect}
        >
          ${
            testing
              ? t("modelSetup.candidates.testingButton")
              : t("modelSetup.manual.connectAndVerify")
          }
        </button>
      </div>
    </section>
  `;
}

export function revealModelSetupFeedback(root: ParentNode): void {
  // Immediate scrolling reveals the current attempt without moving focus or
  // scheduling work that could outlive this route. Unrelated renders do not call this.
  root
    .querySelector(".model-setup > .model-setup__testing, .model-setup > .model-setup__failure")
    ?.scrollIntoView?.({ block: "nearest", behavior: "auto" });
}

function renderActivationFeedback(activation: ModelSetupActivationState) {
  // Preparation can activate an undiscovered model. Feedback belongs to the
  // attempt, not a candidate row or the current manual-provider selection.
  if (activation.phase === "testing") {
    return html`<div class="model-setup__testing" role="status">${t("modelSetup.testing")}</div>`;
  }
  return activation.phase === "failure"
    ? renderModelSetupFailure(activation.status, activation.error)
    : nothing;
}

function renderNativeSessionDiscovery(
  props: ModelSetupViewProps,
  result: SystemAgentSetupDetectResult,
) {
  if (
    result.nativeSessionCatalogPreferenceRequired !== true ||
    !result.nativeSessionCatalogs?.length
  ) {
    return nothing;
  }
  return html`
    <section class="settings-section model-setup__native-discovery">
      <div class="settings-section__header"><h2>${t("modelSetup.nativeDiscovery.title")}</h2></div>
      <p class="muted">${t("modelSetup.nativeDiscovery.body")}</p>
      <p>${result.nativeSessionCatalogs.map((option) => option.label).join(", ")}</p>
      <label>
        <input
          type="checkbox"
          .checked=${props.nativeSessionCatalogsEnabled === true}
          ?disabled=${props.actionsDisabled}
          @change=${(event: Event) => {
            // SAFETY: This listener is attached directly to the checkbox input above.
            const input = event.currentTarget as HTMLInputElement;
            props.onNativeSessionCatalogsChange?.(input.checked);
          }}
        />
        ${t("modelSetup.nativeDiscovery.enable")}
      </label>
      <p class="muted">${t("modelSetup.nativeDiscovery.decline")}</p>
    </section>
  `;
}

function renderReady(props: ModelSetupViewProps, result: SystemAgentSetupDetectResult) {
  const onContinue =
    props.firstRun && result.setupComplete && props.activation.phase !== "success"
      ? props.onOpenChat
      : undefined;
  const current = result.configuredModel
    ? renderConfiguredModel({
        result,
        verify: props.verify,
        canVerify: props.canVerify,
        actionsDisabled: props.actionsDisabled,
        onVerify: props.onVerify,
        onContinue,
      })
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
    ${current} ${renderNativeSessionDiscovery(props, result)} ${renderEmptyState(props, result)}
    ${renderCandidateRows(props, result)} ${renderUnavailable(props, result)}
    ${renderPrepare(props, result)} ${renderSignIn(props, result)} ${renderManual(props, result)}
  `;
}

function renderLoadingSection(params: {
  title: string;
  rows?: number;
  intro?: string;
  className?: string;
  status?: string;
}) {
  return html`
    <section class=${`settings-section ${params.className ?? ""}`.trim()}>
      <div class="settings-section__header"><h2>${params.title}</h2></div>
      ${params.intro ? html`<p class="muted">${params.intro}</p>` : nothing}
      <div class="model-setup__rows">
        ${Array.from(
          { length: params.rows ?? 1 },
          (_, index) => html`
            <div class="model-setup__row model-setup__loading-row">
              <span class="model-setup__loading-icon skeleton"></span>
              <span class="model-setup__loading-copy">
                ${
                  index === 0 && params.status
                    ? html`<span class="model-setup__loading-status">${params.status}</span>`
                    : html`<span class="skeleton skeleton-line skeleton-line--medium"></span>`
                }
                <span class="skeleton skeleton-line skeleton-line--long"></span>
              </span>
              <span class="model-setup__loading-action skeleton"></span>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

function renderLoading(modelConfigured: boolean) {
  return html`
    <div
      class="model-setup__loading"
      role="status"
      aria-busy="true"
      aria-label=${t("modelSetup.loading")}
    >
      <div class="model-setup__loading-sections" aria-hidden="true">
        ${
          modelConfigured
            ? renderLoadingSection({
                title: t("modelSetup.verify.title"),
                className: "model-setup__loading-section--selected",
                status: t("modelSetup.loading"),
              })
            : nothing
        }
        ${renderLoadingSection({
          title: t("modelSetup.candidates.title"),
          className: "model-setup__loading-section--candidates",
          status: modelConfigured ? undefined : t("modelSetup.loading"),
        })}
        ${renderLoadingSection({
          title: t("modelSetup.prepare.title"),
          intro: t("modelSetup.prepare.intro"),
          rows: 2,
        })}
        ${renderLoadingSection({
          title: t("modelSetup.signIn.title"),
          className: "model-setup__loading-section--sign-in",
        })}
        ${renderLoadingSection({ title: t("modelSetup.manual.title") })}
      </div>
    </div>
  `;
}

export function renderModelSetup(props: ModelSetupViewProps): TemplateResult {
  let body: unknown;
  if (props.page.phase === "ready") {
    body = renderReady(
      { ...props, actionsDisabled: props.actionsDisabled || props.activationUnresolved === true },
      props.page.result,
    );
  } else if (!props.canAdmin) {
    body = html`<div class="callout warning" role="note">
      ${t("modelSetup.access.adminRequired")}
    </div>`;
  } else if (props.gatewayTooOld) {
    body = html`<div class="callout warning" role="note">
      ${t("modelSetup.access.gatewayTooOld")}
    </div>`;
  } else if (props.page.phase === "loading") {
    body = renderLoading(props.modelConfigured === true);
  } else if (props.page.phase === "detect-error") {
    body = html`
      <div class="callout danger" role="alert">${props.page.message}</div>
      <button type="button" class="btn" @click=${props.onDetect}>${t("modelSetup.retry")}</button>
    `;
  }
  const content = html`
    <div class="model-setup">
      <div class="model-setup__intro">
        <div>
          <h1>${t("modelSetup.heading")}</h1>
          <p>${t("modelSetup.intro")}</p>
        </div>
        ${
          props.page.phase === "ready" &&
          !props.page.result.configuredModel &&
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
            : nothing
        }
      </div>
      ${
        props.canAdmin && !props.gatewayTooOld
          ? renderActivationFeedback(props.activation)
          : nothing
      }
      ${
        props.refreshWarning
          ? html`<div class="callout warning" role="alert">${props.refreshWarning}</div>`
          : nothing
      }
      ${
        props.activationUnresolved && !props.actionsDisabled && props.activation.phase !== "success"
          ? html`<div class="model-setup__recovery">
              <p>${t("modelSetup.recovery.unknown")}</p>
              ${
                props.page.phase === "ready" && props.page.result.configuredModel && props.canVerify
                  ? html`<button
                      type="button"
                      class="btn primary"
                      @click=${props.onUseCurrentModel}
                    >
                      ${t("modelSetup.recovery.useCurrent")}
                    </button>`
                  : nothing
              }
              <button type="button" class="btn" @click=${props.onDetect}>
                ${t("modelSetup.checkAgain")}
              </button>
            </div>`
          : nothing
      }
      ${body}
    </div>
    ${renderModelSetupWizard({
      mode: props.wizardMode,
      state: props.wizard,
      refreshWarning: props.refreshWarning,
      cancellationNotice: props.cancellationNotice,
      value: props.wizardValue,
      onValueChange: props.onWizardValueChange,
      onAnswer: props.onWizardAnswer,
      onCancel: props.onWizardCancel,
      onClose: props.onWizardClose,
    })}
    ${
      props.activation.phase === "success"
        ? renderModelSetupSuccessDialog(
            props.activation,
            props.onOpenChat,
            props.onSuccessClose,
            props.firstRun,
          )
        : nothing
    }
  `;
  return html`
    <section class="content-header">
      <div>
        <div class="page-title">${titleForRoute("model-setup")}</div>
        <div class="page-subtitle">
          ${subtitleForRoute("model-setup")} ${renderLearnMoreLink(MODEL_SETUP_DOCS_URL)}
        </div>
      </div>
    </section>
    ${renderSettingsWorkspace(content)}
  `;
}
