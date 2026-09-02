import { html } from "lit";
import type {
  UserModelAccount,
  UserProfileAuthLink,
  UsersAuthConnectStartResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import {
  renderLearnMoreLink,
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";

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
  connectFlow: (UsersAuthConnectStartResult & { status: "pending" | "exchanging" }) | null;
  connectRedirectDraft: string;
  claudeTokenDraft: string;
  onLinkDraftInput: (value: string) => void;
  onLink: () => void;
  onUnlink: (provider: string) => void;
  onSelectAccount: (authProfileId: string) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  onConnectStart: () => void;
  onConnectRedirectInput: (value: string) => void;
  onConnectComplete: () => void;
  onConnectCancel: () => void;
  onConnectCheck: () => void;
  onClaudeTokenInput: (value: string) => void;
  onClaudeConnect: () => void;
};

function providerLabel(provider: string): string {
  if (provider === "openai") {
    return t("profilePage.modelAccounts.providerChatgpt");
  }
  if (provider === "anthropic") {
    return t("profilePage.modelAccounts.providerClaude");
  }
  return provider;
}

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
      <span class="model-accounts__provider">${providerLabel(link.provider)}</span>
    `,
    description: html`${t("profilePage.modelAccounts.linkedDescription")}${account
      ? accountIdDetail(props.accounts, account)
      : ""}`,
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
      <span class="model-accounts__provider">${providerLabel(account.provider)}</span>
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

function renderChatgptFlow(props: ModelAccountsSectionProps) {
  const flow = props.connectFlow;
  if (!flow) {
    return renderSettingsRow({
      title: t("profilePage.modelAccounts.connectChatgpt"),
      description: t("profilePage.modelAccounts.connectChatgptDescription"),
      control: html`
        <button
          type="button"
          class="btn btn--sm primary profile-auth-connect-start"
          ?disabled=${props.busy}
          @click=${() => props.onConnectStart()}
        >
          ${t("profilePage.modelAccounts.connectAction")}
        </button>
      `,
    });
  }
  return renderSettingsRow({
    title: t("profilePage.modelAccounts.connectChatgpt"),
    description: flow.autoCallback
      ? t("profilePage.modelAccounts.redirectAutoDescription")
      : t("profilePage.modelAccounts.redirectDescription"),
    stacked: true,
    control: html`
      <div class="model-accounts-flow">
        <a
          class="btn primary profile-auth-connect-open"
          href=${flow.url}
          target=${EXTERNAL_LINK_TARGET}
          rel=${buildExternalLinkRel()}
        >
          ${t("profilePage.modelAccounts.openSignIn")}
        </a>
        <form
          class="model-accounts-form"
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            props.onConnectComplete();
          }}
        >
          <input
            class="settings-input profile-auth-connect-redirect"
            type="text"
            aria-label=${t("profilePage.modelAccounts.redirectPlaceholder")}
            .value=${props.connectRedirectDraft}
            placeholder=${t("profilePage.modelAccounts.redirectPlaceholder")}
            ?disabled=${props.busy}
            @input=${(event: Event) => props.onConnectRedirectInput(inputValue(event))}
          />
          <button
            type="submit"
            class="btn btn--sm primary profile-auth-connect-finish"
            ?disabled=${props.busy || !props.connectRedirectDraft.trim()}
          >
            ${t("profilePage.modelAccounts.confirmAction")}
          </button>
          <button
            type="button"
            class="btn btn--sm profile-auth-connect-cancel"
            ?disabled=${props.cancelBusy}
            @click=${() => props.onConnectCancel()}
          >
            ${t("profilePage.modelAccounts.cancelAction")}
          </button>
        </form>
        ${flow.autoCallback || flow.status === "exchanging"
          ? html`<span class="model-accounts-hint" aria-live="polite">
              ${t(
                flow.status === "exchanging"
                  ? "profilePage.modelAccounts.exchangingHint"
                  : "profilePage.modelAccounts.waitingHint",
              )}
            </span>`
          : ""}
        ${props.statusUnavailable
          ? html`<button
              type="button"
              class="btn btn--sm profile-auth-connect-check"
              ?disabled=${props.cancelBusy}
              @click=${() => props.onConnectCheck()}
            >
              ${t("profilePage.modelAccounts.checkStatusAction")}
            </button>`
          : ""}
      </div>
    `,
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
    ${props.links.length === 0
      ? renderSettingsEmpty(t("profilePage.modelAccounts.empty"))
      : props.links.map((link) => renderLinkedRow(props, link))}
    ${props.accounts
      .filter((account) => !account.selected)
      .map((account) => renderSavedAccountRow(props, account))}
    ${props.hasMore
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
      : ""}
    ${renderChatgptFlow(props)}
    ${renderSettingsRow({
      title: t("profilePage.modelAccounts.connectClaude"),
      description: t("profilePage.modelAccounts.connectClaudeDescription"),
      stackedOnNarrow: true,
      control: html`
        <form
          class="model-accounts-form"
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            props.onClaudeConnect();
          }}
        >
          <input
            class="settings-input profile-auth-connect-claude"
            type="password"
            autocomplete="off"
            spellcheck="false"
            aria-label=${t("profilePage.modelAccounts.connectClaude")}
            .value=${props.claudeTokenDraft}
            placeholder=${t("profilePage.modelAccounts.claudeTokenPlaceholder")}
            ?disabled=${props.busy}
            @input=${(event: Event) => props.onClaudeTokenInput(inputValue(event))}
          />
          <button
            type="submit"
            class="btn btn--sm profile-auth-connect-claude-submit"
            ?disabled=${props.busy || !props.claudeTokenDraft.trim()}
          >
            ${t("profilePage.modelAccounts.connectAction")}
          </button>
        </form>
      `,
    })}
    ${props.showManualLink ? renderManualLinkRow(props) : ""}
    ${props.notice
      ? html`<div class="settings-row model-accounts-notice" role="status">
          <span class="settings-row__desc">${props.notice}</span>
        </div>`
      : ""}
    ${props.error
      ? html`<div class="settings-row model-accounts-error" role="alert">
          <span class="settings-row__desc">${props.error}</span>
        </div>`
      : ""}
    ${props.inventoryError
      ? html`<div class="settings-row model-accounts-error" role="alert">
          ${t("profilePage.modelAccounts.inventoryFailed")} ${props.inventoryError}
        </div>`
      : ""}
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
    ${props
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
        })}
  `;
  return renderSettingsSection(
    {
      title: t("profilePage.modelAccounts.title"),
      description: t("profilePage.modelAccounts.description"),
      actions: props
        ? html`<button
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
