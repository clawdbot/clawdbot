import { html } from "lit";
import type {
  UserModelAccount,
  UserProfileAuthLink,
  UsersAuthConnectCatalogResult,
  UsersAuthConnectStartResult,
  WizardStep,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { providerDisplayLabel, renderProviderBrandIcon } from "../../components/provider-icon.ts";
import { renderPicker } from "../../components/select-picker.ts";
import {
  renderLearnMoreLink,
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { renderWizardStepControls } from "../../components/wizard-step-controls.ts";
import { t } from "../../i18n/index.ts";

type ModelAccountsContext = {
  gatewayUrl: string;
  personLabel: string | null;
  unavailableReason: "identity" | "write" | "profile";
  onConnectionSettings: () => void;
};

export type ModelAccountsSectionProps = {
  links: UserProfileAuthLink[];
  accounts: UserModelAccount[];
  hasMore: boolean;
  inventoryLoading: boolean;
  inventoryError: string | null;
  /** Linking an arbitrary stored credential is operator.admin-only server-side. */
  showManualLink: boolean;
  busy: boolean;
  cancelBusy: boolean;
  error: string | null;
  notice: string | null;
  statusUnavailable: boolean;
  linkDraft: string;
  signIn: {
    providers: UsersAuthConnectCatalogResult["providers"];
    provider: string;
    method: string;
  } | null;
  connectFlow: (UsersAuthConnectStartResult & { step?: WizardStep }) | null;
  stepValue: unknown;
  onLinkDraftInput: (value: string) => void;
  onLink: () => void;
  onUnlink: (provider: string) => void;
  onSelectAccount: (authProfileId: string) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  onAddAccount: () => void;
  onProviderChange: (provider: string) => void;
  onMethodChange: (method: string) => void;
  onCloseSignIn: () => void;
  onConnectStart: () => void;
  onStepValueChange: (stepId: string, value: unknown) => void;
  onStepAnswer: (stepId: string, value: unknown) => void;
  onConnectCancel: () => void;
  onConnectCheck: () => void;
};

function inputValue(event: Event): string {
  // SAFETY: each @input listener below is bound to its own text input element.
  return (event.target as HTMLInputElement).value;
}

function gatewayEndpoint(gatewayUrl: string): string {
  try {
    const url = new URL(gatewayUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return t("profilePage.modelAccounts.gatewayUnavailable");
  }
}

function accountIdDetail(accounts: UserModelAccount[], account: UserModelAccount) {
  return accounts.some(
    (candidate) =>
      candidate.authProfileId !== account.authProfileId &&
      candidate.provider === account.provider &&
      candidate.label === account.label,
  )
    ? html` <code>${account.authProfileId}</code>`
    : "";
}

function renderLinkedRow(props: ModelAccountsSectionProps, link: UserProfileAuthLink) {
  const account = props.accounts.find(
    (candidate) => candidate.authProfileId === link.authProfileId,
  );
  return renderSettingsRow({
    title: html`
      <span class="model-accounts__id"
        >${account?.label ?? t("profilePage.modelAccounts.gatewayAccount")}</span
      >
      <span class="model-accounts__provider">${providerDisplayLabel(link.provider)}</span>
    `,
    description: html`${t("profilePage.modelAccounts.linkedDescription")}${
      account ? accountIdDetail(props.accounts, account) : ""
    }`,
    control: html`
      ${renderSettingsStatus({ kind: "ok", label: t("profilePage.modelAccounts.linkedStatus") })}
      <button
        type="button"
        class="btn btn--sm profile-auth-link-unlink"
        ?disabled=${props.busy}
        @click=${() => props.onUnlink(link.provider)}
      >
        ${t("profilePage.modelAccounts.unlinkAction")}
      </button>
    `,
  });
}

function renderSavedAccountRow(props: ModelAccountsSectionProps, account: UserModelAccount) {
  return renderSettingsRow({
    title: html`
      <span class="model-accounts__id">${account.label}</span>
      <span class="model-accounts__provider">${providerDisplayLabel(account.provider)}</span>
    `,
    description: html`${t(
      `profilePage.modelAccounts.authTypes.${account.authType}`,
    )}${accountIdDetail(props.accounts, account)}`,
    control: html`
      <button
        type="button"
        class="btn btn--sm profile-auth-account-select"
        data-auth-profile-id=${account.authProfileId}
        ?disabled=${props.busy}
        @click=${() => props.onSelectAccount(account.authProfileId)}
      >
        ${t("profilePage.modelAccounts.selectAction")}
      </button>
    `,
  });
}

function renderSignIn(props: ModelAccountsSectionProps) {
  const choice = props.signIn;
  if (!choice) {
    return "";
  }
  const provider = choice.providers.find((entry) => entry.id === choice.provider);
  const flow = props.connectFlow;
  const step = flow?.step;
  const cancel = html`<button
    type="button"
    class="btn btn--sm profile-auth-connect-cancel"
    ?disabled=${props.cancelBusy}
    @click=${flow ? props.onConnectCancel : props.onCloseSignIn}
  >
    ${t("profilePage.modelAccounts.cancelAction")}
  </button>`;
  return renderSettingsRow({
    title: flow
      ? (flow.step?.title ?? provider?.label ?? t("profilePage.modelAccounts.connectAction"))
      : t("profilePage.modelAccounts.addAccount"),
    stacked: true,
    control: flow
      ? html`<div class="model-accounts-flow">
          ${
            step
              ? renderWizardStepControls({
                  step,
                  value: props.stepValue,
                  busy: props.busy,
                  inputId: "profile-account-auth-answer",
                  leadingAction: cancel,
                  onValueChange: (value) => props.onStepValueChange(step.id, value),
                  onAnswer: (value) => props.onStepAnswer(step.id, value),
                })
              : html`<span role="status">${t("common.loading")}</span>${cancel}`
          }
          ${
            props.statusUnavailable
              ? html`<button
                  type="button"
                  class="btn btn--sm profile-auth-connect-check"
                  ?disabled=${props.cancelBusy}
                  @click=${props.onConnectCheck}
                >
                  ${t("profilePage.modelAccounts.checkStatusAction")}
                </button>`
              : ""
          }
        </div>`
      : html`<div class="model-accounts-choice">
          ${renderPicker({
            label: t("profilePage.modelAccounts.provider"),
            className: "profile-auth-provider",
            value: choice.provider || null,
            options: choice.providers.map((entry) => ({ value: entry.id, label: entry.label })),
            disabled: props.busy,
            renderLeading: (entry) => renderProviderBrandIcon(entry.value),
            onChange: props.onProviderChange,
          })}
          ${
            provider
              ? renderPicker({
                  label: t("profilePage.modelAccounts.method"),
                  className: "profile-auth-method",
                  value: choice.method || null,
                  options: provider.methods.map((method) => ({
                    value: method.id,
                    label: method.label,
                    description: method.hint,
                  })),
                  disabled: props.busy,
                  onChange: props.onMethodChange,
                })
              : ""
          }
          ${
            !props.busy && !props.error && choice.providers.length === 0
              ? html`<span>${t("profilePage.modelAccounts.noMethods")}</span>`
              : ""
          }
          <div class="wizard-step__actions">
            ${cancel}
            <button
              type="button"
              class="btn btn--sm primary profile-auth-connect-start"
              ?disabled=${props.busy || !choice.method}
              @click=${props.onConnectStart}
            >
              ${t("profilePage.modelAccounts.connectAction")}
            </button>
          </div>
        </div>`,
  });
}

function renderManualLinkRow(props: ModelAccountsSectionProps) {
  return renderSettingsRow({
    title: t("profilePage.modelAccounts.inputLabel"),
    description: t("profilePage.modelAccounts.inputDescription"),
    stackedOnNarrow: true,
    control: html`
      <form
        class="model-accounts-form"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          props.onLink();
        }}
      >
        <input
          class="settings-input profile-auth-link-input"
          type="text"
          aria-label=${t("profilePage.modelAccounts.inputLabel")}
          .value=${props.linkDraft}
          placeholder=${t("profilePage.modelAccounts.inputPlaceholder")}
          ?disabled=${props.busy}
          @input=${(event: Event) => props.onLinkDraftInput(inputValue(event))}
        />
        <button
          type="submit"
          class="btn btn--sm profile-auth-link-submit"
          ?disabled=${props.busy || !props.linkDraft.trim()}
        >
          ${t("profilePage.modelAccounts.linkAction")}
        </button>
      </form>
    `,
  });
}

function renderModelAccountRows(props: ModelAccountsSectionProps) {
  return html`
    ${
      props.links.length === 0
        ? renderSettingsEmpty(t("profilePage.modelAccounts.empty"))
        : props.links.map((link) => renderLinkedRow(props, link))
    }
    ${props.accounts
      .filter((account) => !account.selected)
      .map((account) => renderSavedAccountRow(props, account))}
    ${
      props.hasMore
        ? renderSettingsRow({
            title: t("profilePage.modelAccounts.savedAccounts"),
            control: html`<button
              type="button"
              class="btn btn--sm profile-auth-accounts-more"
              ?disabled=${props.busy}
              @click=${props.onLoadMore}
            >
              ${t("profilePage.modelAccounts.loadMore")}
            </button>`,
          })
        : ""
    }
    ${renderSignIn(props)} ${props.showManualLink ? renderManualLinkRow(props) : ""}
    ${
      props.notice
        ? html`<div class="settings-row model-accounts-notice" role="status">
            <span class="settings-row__desc">${props.notice}</span>
          </div>`
        : ""
    }
    ${
      props.error
        ? html`<div class="settings-row model-accounts-error" role="alert">
            <span class="settings-row__desc">${props.error}</span>
          </div>`
        : ""
    }
    ${
      props.inventoryError
        ? html`<div class="settings-row model-accounts-error" role="alert">
            ${t("profilePage.modelAccounts.inventoryFailed")} ${props.inventoryError}
          </div>`
        : ""
    }
  `;
}

export function renderModelAccountsSection(
  context: ModelAccountsContext,
  props: ModelAccountsSectionProps | null,
) {
  const rows = html`
    ${renderSettingsRow({
      title: t("profilePage.modelAccounts.gateway"),
      stackedOnNarrow: true,
      control: renderSettingsValue(gatewayEndpoint(context.gatewayUrl), { mono: true }),
    })}
    ${renderSettingsRow({
      title: t("profilePage.modelAccounts.person"),
      stackedOnNarrow: true,
      control: renderSettingsValue(context.personLabel ?? t("profilePage.modelAccounts.noPerson")),
    })}
    ${renderSettingsRow({
      title: t("profilePage.modelAccounts.scope"),
      description: t("profilePage.modelAccounts.personalDescription"),
      control: renderSettingsValue(t("profilePage.modelAccounts.personal")),
    })}
    ${
      props
        ? renderModelAccountRows(props)
        : renderSettingsRow({
            title: t("profilePage.modelAccounts.signInUnavailable"),
            description: t(`profilePage.modelAccounts.unavailable.${context.unavailableReason}`),
            stacked: true,
            control: html`
              <button type="button" class="btn btn--sm" @click=${context.onConnectionSettings}>
                ${t("profilePage.modelAccounts.connectionSettings")}
              </button>
              ${renderLearnMoreLink(
                "https://docs.openclaw.ai/concepts/multi-user#per-person-model-accounts",
              )}
            `,
          })
    }
  `;
  return renderSettingsSection(
    {
      title: t("profilePage.modelAccounts.title"),
      description: t("profilePage.modelAccounts.description"),
      actions: props
        ? html`${
              !props.signIn
                ? html`<button
                    type="button"
                    class="btn btn--sm primary profile-auth-add-account"
                    ?disabled=${props.busy}
                    @click=${props.onAddAccount}
                  >
                    ${t("profilePage.modelAccounts.addAccount")}
                  </button>`
                : ""
            }<button
              type="button"
              class="btn btn--sm profile-auth-accounts-refresh"
              ?disabled=${props.inventoryLoading}
              @click=${props.onRefresh}
            >
              ${t("common.refresh")}
            </button>`
        : undefined,
    },
    rows,
  );
}
