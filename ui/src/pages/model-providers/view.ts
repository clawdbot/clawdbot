// Control UI view renders the Model Providers settings page content.
import { html, nothing } from "lit";
import type { ModelsProbeResult } from "../../api/types.ts";
import { renderProviderBrandIcon } from "../../components/provider-icon.ts";
import { renderProviderUsageDetails } from "../../components/provider-usage.ts";
import {
  renderSettingsEmpty,
  renderSettingsGroup,
  renderSettingsPage,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatCost, formatTimeMs, formatTokens } from "../../lib/format.ts";
import "../../styles/model-providers.css";
import "../../styles/usage.css";
import type {
  DefaultModelSelection,
  ModelPickerEntry,
  ModelProviderAuthKind,
  ModelProviderCard,
  ModelProviderLogoutTarget,
  ProviderOption,
} from "./data.ts";
import { renderDefaultModels } from "./default-models-view.ts";

export type ModelProviderRowMessage = { kind: "success" | "error"; text: string };

type ModelProvidersViewProps = {
  connected: boolean;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  updatedAt: number | null;
  costDays: number;
  cards: ModelProviderCard[];
  configuredModels: ModelPickerEntry[];
  defaultModels: DefaultModelSelection;
  defaultModelsDirty: boolean;
  unconfiguredProviders: ProviderOption[];
  canMutate: boolean;
  mutationBlockedReason: string | null;
  probeAvailable: boolean;
  busy: Record<string, boolean>;
  messages: Record<string, ModelProviderRowMessage>;
  probeResults: Record<string, ModelsProbeResult>;
  keyEditorProvider: string | null;
  keyDraft: string;
  pendingLogoutProvider: string | null;
  addProviderOpen: boolean;
  addProviderId: string;
  addProviderKey: string;
  onRefresh: () => void;
  onOpenKeyEditor: (provider: string) => void;
  onCloseKeyEditor: () => void;
  onKeyDraftChange: (value: string) => void;
  onSaveKey: (provider: string, configKey: string) => void;
  onRemoveKey: (provider: string, configKey: string) => void;
  onProbe: (cardId: string, providers: string[]) => void;
  onRequestLogout: (provider: string) => void;
  onCancelLogout: () => void;
  onLogout: (cardId: string, targets: ModelProviderLogoutTarget[]) => void;
  onAddProviderToggle: () => void;
  onAddProviderIdChange: (provider: string) => void;
  onAddProviderKeyChange: (value: string) => void;
  onAddProvider: () => void;
  onPrimaryChange: (model: string) => void;
  onFallbackAdd: (model: string) => void;
  onFallbackRemove: (index: number) => void;
  onUtilityChange: (model: string | null) => void;
  onDefaultModelsSave: () => void;
  onDefaultModelsReset: () => void;
};

const AUTH_KIND_I18N: Record<ModelProviderAuthKind, string> = {
  ok: "modelProviders.status.ok",
  expiring: "modelProviders.status.expiring",
  expired: "modelProviders.status.expired",
  missing: "modelProviders.status.missing",
  "api-key": "modelProviders.status.apiKey",
};

const AUTH_KIND_STATUS: Record<ModelProviderAuthKind, "ok" | "warn" | "danger" | "muted"> = {
  ok: "ok",
  expiring: "warn",
  expired: "danger",
  missing: "danger",
  "api-key": "muted",
};

function renderAuthStatus(card: ModelProviderCard) {
  const auth = card.auth;
  if (!auth) {
    return nothing;
  }
  const label = t(AUTH_KIND_I18N[auth.kind]);
  const detail = auth.expiryLabel
    ? t("modelProviders.expiresIn", { time: auth.expiryLabel })
    : undefined;
  return html`
    <span title=${detail ?? label}>
      ${renderSettingsStatus({ kind: AUTH_KIND_STATUS[auth.kind], label })}
    </span>
  `;
}

function modelsText(card: ModelProviderCard): string | null {
  if (card.modelCount === 0) {
    return null;
  }
  return card.availableModelCount < card.modelCount
    ? t("modelProviders.modelsAvailable", {
        available: String(card.availableModelCount),
        count: String(card.modelCount),
      })
    : card.modelCount === 1
      ? t("modelProviders.modelOne")
      : t("modelProviders.models", { count: String(card.modelCount) });
}

// formatTokens tops out at "M"; month-scale provider totals can cross a
// billion tokens, which would render as e.g. "4132M".
function formatTokenTotal(tokens: number): string {
  if (tokens >= 1_000_000_000) {
    const billions = tokens / 1_000_000_000;
    return billions < 10 ? `${billions.toFixed(1)}B` : `${Math.round(billions)}B`;
  }
  return formatTokens(tokens);
}

function renderLocalCost(card: ModelProviderCard, costDays: number) {
  const cost = card.localCost;
  if (!cost || (cost.totalTokens === 0 && cost.totalCost === 0)) {
    return nothing;
  }
  return html`
    <div class="model-providers__local-cost">
      <div class="provider-usage-billing-row">
        <span>${t("modelProviders.localCost", { days: String(costDays) })}</span>
        <strong>${formatCost(cost.totalCost)}</strong>
      </div>
      <div class="model-providers__local-cost-detail">
        ${t("modelProviders.localCostDetail", {
          tokens: formatTokenTotal(cost.totalTokens),
          sessions: String(cost.sessionCount),
        })}
      </div>
    </div>
  `;
}

function renderCredentialSummary(card: ModelProviderCard) {
  const oauthCount = card.profiles.filter((profile) => profile.type === "oauth").length;
  const tokenCount = card.profiles.filter((profile) => profile.type === "token").length;
  const apiProfileCount = card.profiles.filter((profile) => profile.type === "api_key").length;
  const parts = [];
  if (oauthCount > 0) {
    parts.push(t("modelProviders.credentials.oauth", { count: String(oauthCount) }));
  }
  if (tokenCount > 0) {
    parts.push(t("modelProviders.credentials.tokenProfiles", { count: String(tokenCount) }));
  }
  if (card.apiKey?.source === "config" || (!card.apiKey && card.hasConfigApiKey)) {
    parts.push(t("modelProviders.credentials.configKey"));
  } else if (card.apiKey?.source === "env") {
    parts.push(
      card.apiKey.envVar
        ? t("modelProviders.credentials.envKeyNamed", { name: card.apiKey.envVar })
        : t("modelProviders.credentials.envKey"),
    );
  } else if (apiProfileCount > 0) {
    parts.push(t("modelProviders.credentials.profileKey", { count: String(apiProfileCount) }));
  }
  return html`
    <div class="model-providers__credentials">
      <span>${t("modelProviders.credentials.label")}</span>
      <strong
        >${parts.length > 0 ? parts.join(" · ") : t("modelProviders.credentials.none")}</strong
      >
    </div>
  `;
}

function renderProbeResult(result: ModelsProbeResult | undefined) {
  if (!result) {
    return nothing;
  }
  return html`
    <div
      class="model-providers__probe model-providers__probe--${result.status === "ok"
        ? "success"
        : "error"}"
      role="status"
    >
      <div class="model-providers__probe-summary">
        <strong>${t(`modelProviders.probe.status.${result.status}`)}</strong>
        ${result.latencyMs !== undefined
          ? html`<span
              >${t("modelProviders.probe.latency", { ms: String(result.latencyMs) })}</span
            >`
          : nothing}
      </div>
      ${result.error ? html`<div>${result.error}</div>` : nothing}
      ${result.results.map(
        (target) => html`
          <div class="model-providers__probe-target">
            <span>${target.label}</span>
            <span>
              ${t(`modelProviders.probe.status.${target.status}`)}${target.latencyMs !== undefined
                ? ` · ${t("modelProviders.probe.latency", { ms: String(target.latencyMs) })}`
                : ""}
            </span>
            ${target.error ? html`<small>${target.error}</small>` : nothing}
          </div>
        `,
      )}
    </div>
  `;
}

function renderKeyEditor(card: ModelProviderCard, props: ModelProvidersViewProps) {
  if (props.keyEditorProvider !== card.id) {
    return nothing;
  }
  const busy = Boolean(props.busy[`key:${card.id}`]);
  const authModeBlocked =
    card.apiKeySupported === false ||
    Boolean(card.configAuthMode && card.configAuthMode !== "api-key");
  return html`
    <div class="model-providers__inline-form">
      <label class="field">
        <span>${t("modelProviders.apiKey.label")}</span>
        <input
          type="password"
          autocomplete="off"
          placeholder=${card.apiKey?.source === "config"
            ? t("modelProviders.apiKey.replacePlaceholder")
            : t("modelProviders.apiKey.placeholder")}
          .value=${props.keyDraft}
          ?disabled=${busy || !props.canMutate || authModeBlocked}
          @input=${(event: Event) =>
            props.onKeyDraftChange((event.target as HTMLInputElement).value)}
        />
      </label>
      <div class="model-providers__form-actions">
        <button
          class="btn primary btn--sm"
          ?disabled=${busy || !props.canMutate || authModeBlocked || !props.keyDraft.trim()}
          @click=${() => props.onSaveKey(card.id, card.configKey ?? card.id)}
        >
          ${busy ? t("modelProviders.saving") : t("common.save")}
        </button>
        <button class="btn btn--sm" ?disabled=${busy} @click=${() => props.onCloseKeyEditor()}>
          ${t("common.cancel")}
        </button>
      </div>
    </div>
  `;
}

function renderProviderActions(card: ModelProviderCard, props: ModelProvidersViewProps) {
  const credentialProviders = card.credentialProviderIds.length
    ? card.credentialProviderIds
    : [card.id];
  const isConfigured = card.hasConfigApiKey || Boolean(card.apiKey) || card.profiles.length > 0;
  const canLogout = card.logoutTargets.length > 0;
  const probeBusy = Boolean(props.busy[`probe:${card.id}`]);
  const keyBusy = Boolean(props.busy[`key:${card.id}`]);
  const logoutBusy = Boolean(props.busy[`logout:${card.id}`]);
  const blocked = props.mutationBlockedReason ?? "";
  const authModeBlocked = Boolean(card.configAuthMode && card.configAuthMode !== "api-key");
  const apiKeyUnsupported = card.apiKeySupported === false;
  const keyBlocked = authModeBlocked
    ? t("modelProviders.apiKey.authModeBlocked", { mode: card.configAuthMode ?? "" })
    : blocked;
  return html`
    <div class="model-providers__card-actions">
      ${isConfigured
        ? html`
            <button
              class="btn btn--sm"
              ?disabled=${probeBusy || !props.canMutate || !props.probeAvailable}
              title=${!props.probeAvailable ? t("modelProviders.probe.unavailable") : blocked}
              @click=${() => props.onProbe(card.id, credentialProviders)}
            >
              ${probeBusy ? t("modelProviders.probe.testing") : t("modelProviders.probe.test")}
            </button>
          `
        : nothing}
      ${apiKeyUnsupported
        ? nothing
        : html`
            <button
              class="btn btn--sm"
              ?disabled=${keyBusy || !props.canMutate || authModeBlocked}
              title=${keyBlocked}
              @click=${() => props.onOpenKeyEditor(card.id)}
            >
              ${card.hasConfigApiKey
                ? t("modelProviders.apiKey.replace")
                : t("modelProviders.apiKey.set")}
            </button>
          `}
      ${card.hasConfigApiKey
        ? html`
            <button
              class="btn btn--sm danger"
              ?disabled=${keyBusy || !props.canMutate || authModeBlocked}
              title=${keyBlocked}
              @click=${() => props.onRemoveKey(card.id, card.configKey ?? card.id)}
            >
              ${t("modelProviders.apiKey.remove")}
            </button>
          `
        : nothing}
      ${canLogout
        ? html`
            <button
              class="btn btn--sm"
              ?disabled=${logoutBusy || !props.canMutate}
              title=${blocked}
              @click=${() => props.onRequestLogout(card.id)}
            >
              ${t("modelProviders.logout.action")}
            </button>
          `
        : nothing}
    </div>
    ${props.pendingLogoutProvider === card.id
      ? html`
          <div class="model-providers__confirm" role="alert">
            <span>${t("modelProviders.logout.confirm", { provider: card.displayName })}</span>
            <div class="model-providers__form-actions">
              <button
                class="btn danger btn--sm"
                ?disabled=${logoutBusy}
                @click=${() => props.onLogout(card.id, card.logoutTargets)}
              >
                ${logoutBusy
                  ? t("modelProviders.logout.loggingOut")
                  : t("modelProviders.logout.action")}
              </button>
              <button class="btn btn--sm" ?disabled=${logoutBusy} @click=${props.onCancelLogout}>
                ${t("common.cancel")}
              </button>
            </div>
          </div>
        `
      : nothing}
  `;
}

function renderProviderRow(card: ModelProviderCard, props: ModelProvidersViewProps) {
  const models = modelsText(card);
  const message = props.messages[`key:${card.id}`] ?? props.messages[card.id];
  return html`
    <div
      class="settings-row settings-row--stacked model-providers__row"
      data-provider-id=${card.id}
    >
      <div class="model-providers__head">
        <div class="model-providers__identity">
          ${renderProviderBrandIcon(card.id, { className: "model-providers__icon" })}
          <div class="settings-row__text">
            <span class="settings-row__title">${card.displayName}</span>
            <span class="settings-row__desc"
              >${card.id}${models ? html` · ${models}` : nothing}</span
            >
          </div>
        </div>
        <div class="settings-row__control">
          ${card.usage?.plan ? renderSettingsValue(card.usage.plan) : nothing}
          ${renderAuthStatus(card)}
        </div>
      </div>
      ${renderCredentialSummary(card)}
      ${card.usage
        ? renderProviderUsageDetails(card.usage)
        : html`<div class="model-providers__no-stats">${t("modelProviders.noStats")}</div>`}
      ${renderLocalCost(card, props.costDays)} ${renderProviderActions(card, props)}
      ${renderKeyEditor(card, props)} ${renderProbeResult(props.probeResults[card.id])}
      ${message
        ? html`<div class="callout ${message.kind}" role="status">${message.text}</div>`
        : nothing}
    </div>
  `;
}

function renderAddProvider(props: ModelProvidersViewProps) {
  const rows = html`
    ${props.unconfiguredProviders.length === 0
      ? renderSettingsEmpty(t("modelProviders.add.none"))
      : nothing}
    ${props.addProviderOpen
      ? html`
          <div class="settings-row settings-row--stacked">
            <div class="model-providers__add-form">
              <label class="field">
                <span>${t("modelProviders.add.provider")}</span>
                <select
                  .value=${props.addProviderId}
                  @change=${(event: Event) =>
                    props.onAddProviderIdChange((event.target as HTMLSelectElement).value)}
                >
                  <option value="">${t("modelProviders.add.selectProvider")}</option>
                  ${props.unconfiguredProviders.map(
                    (provider) =>
                      html`<option value=${provider.id}>${provider.displayName}</option>`,
                  )}
                </select>
              </label>
              <label class="field">
                <span>${t("modelProviders.apiKey.label")}</span>
                <input
                  type="password"
                  autocomplete="off"
                  placeholder=${t("modelProviders.apiKey.placeholder")}
                  .value=${props.addProviderKey}
                  @input=${(event: Event) =>
                    props.onAddProviderKeyChange((event.target as HTMLInputElement).value)}
                />
              </label>
              <button
                class="btn primary"
                ?disabled=${Boolean(props.busy.add) ||
                !props.addProviderId ||
                !props.addProviderKey.trim()}
                @click=${props.onAddProvider}
              >
                ${props.busy.add ? t("modelProviders.saving") : t("modelProviders.add.save")}
              </button>
            </div>
            ${props.messages.add
              ? html`<div class="callout ${props.messages.add.kind}" role="status">
                  ${props.messages.add.text}
                </div>`
              : nothing}
          </div>
        `
      : nothing}
  `;
  return renderSettingsSection(
    {
      title: t("modelProviders.add.title"),
      description: t("modelProviders.add.subtitle"),
      actions: html`
        <button
          class="btn btn--sm"
          ?disabled=${!props.canMutate || props.unconfiguredProviders.length === 0}
          title=${props.mutationBlockedReason ?? ""}
          @click=${props.onAddProviderToggle}
        >
          ${props.addProviderOpen ? t("common.cancel") : t("modelProviders.add.action")}
        </button>
      `,
    },
    rows,
  );
}

export function renderModelProviders(props: ModelProvidersViewProps) {
  if (!props.connected) {
    return renderSettingsPage(
      renderSettingsGroup(renderSettingsEmpty(t("modelProviders.disconnected"))),
    );
  }
  if (props.loading) {
    return renderSettingsPage(
      html`<div aria-busy="true">
        ${renderSettingsGroup(renderSettingsEmpty(t("common.loading")))}
      </div>`,
    );
  }
  const providerRows = html`
    ${props.error
      ? html`
          <div class="settings-row">
            <div class="settings-row__text">
              <span class="settings-row__desc provider-usage-error">${props.error}</span>
            </div>
          </div>
        `
      : nothing}
    ${props.cards.length === 0
      ? renderSettingsEmpty(
          html`<strong>${t("modelProviders.emptyTitle")}</strong><br />${t(
              "modelProviders.emptySubtitle",
            )}`,
        )
      : props.cards.map((card) => renderProviderRow(card, props))}
  `;
  return renderSettingsPage(html`
    ${renderDefaultModels({
      models: props.configuredModels,
      selection: props.defaultModels,
      dirty: props.defaultModelsDirty,
      canMutate: props.canMutate,
      mutationBlockedReason: props.mutationBlockedReason,
      busy: props.busy,
      message: props.messages.defaults,
      onPrimaryChange: props.onPrimaryChange,
      onFallbackAdd: props.onFallbackAdd,
      onFallbackRemove: props.onFallbackRemove,
      onUtilityChange: props.onUtilityChange,
      onSave: props.onDefaultModelsSave,
      onReset: props.onDefaultModelsReset,
    })}
    ${renderSettingsSection(
      {
        title: t("modelProviders.title"),
        description: props.updatedAt
          ? t("modelProviders.updated", { time: formatTimeMs(props.updatedAt) })
          : t("modelProviders.subtitle"),
        count: props.cards.length,
        actions: html`
          <button
            class="btn btn--sm"
            ?disabled=${props.refreshing}
            @click=${() => props.onRefresh()}
          >
            ${props.refreshing ? t("modelProviders.refreshing") : t("common.refresh")}
          </button>
        `,
      },
      providerRows,
    )}
    ${renderAddProvider(props)}
    ${props.mutationBlockedReason
      ? html`<div class="callout warning">${props.mutationBlockedReason}</div>`
      : nothing}
  `);
}
