// Control UI view renders the Models settings page content.
import { html, nothing } from "lit";
import type { FastMode, ModelsProbeResult } from "../../api/types.ts";
import { icons } from "../../components/icons.ts";
import { renderProviderBrandIcon } from "../../components/provider-icon.ts";
import { renderProviderUsageDetails } from "../../components/provider-usage.ts";
import {
  renderSettingsEmpty,
  renderSettingsGroup,
  renderSettingsLoadingSkeleton,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatCompactTokenCount, formatCost, formatTimeMs } from "../../lib/format.ts";
import { MODEL_SETTINGS_TARGET_IDS } from "../config/route-data.ts";
import "../../styles/model-providers.css";
import "../../styles/usage.css";
import {
  classifyModelProviderCard,
  type DefaultModelSelection,
  type ModelPickerEntry,
  type ModelProviderCard,
  type ModelProviderAccessOption,
  type ModelProviderLogoutTarget,
} from "./data.ts";
import { renderDefaultModels } from "./default-models-view.ts";
import { renderProviderStatus } from "./view-status.ts";

export type ModelProviderRowMessage = {
  kind: "success" | "error";
  text: string;
  warning?: string;
};

type ModelProvidersViewProps = {
  connected: boolean;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  providerUsageFailed: boolean;
  supplementalLoading: boolean;
  updatedAt: number | null;
  costDays: number;
  cards: ModelProviderCard[];
  configuredModels: ModelPickerEntry[];
  defaultModels: DefaultModelSelection;
  thinkingLevel: string | undefined;
  thinkingOverridden: boolean;
  fastMode: FastMode | undefined;
  fastModeOverridden: boolean;
  configBusy: boolean;
  canMutate: boolean;
  mutationBlockedReason: string | null;
  /** Usage never converged before the retry budget ran out; cards lack usage. */
  providerUsageStalled: boolean;
  probeAvailable: boolean;
  busy: Record<string, boolean>;
  messages: Record<string, ModelProviderRowMessage>;
  probeResults: Record<string, ModelsProbeResult>;
  keyEditorProvider: string | null;
  keyDraft: string;
  pendingLogoutProvider: string | null;
  providerLoginBusy: boolean;
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
  onLogin: (cardId: string, option: ModelProviderAccessOption) => void;
  onPrimaryChange: (model: string) => void;
  onFallbackChange: (model: string | null) => void;
  onUtilityChange: (model: string | null) => void;
  onThinkingChange: (level: string, element: HTMLElement) => void;
  onThinkingReset: () => void;
  onFastModeChange: (mode: FastMode) => void;
  onFastModeReset: () => void;
  onOpenModelSetup: () => void;
};

function configMutationDisabled(props: ModelProvidersViewProps): boolean {
  return !props.canMutate || props.configBusy;
}

function renderMutationMessage(message: ModelProviderRowMessage | undefined) {
  if (!message) {
    return nothing;
  }
  return html`
    <div class="callout ${message.kind}" role=${message.kind === "error" ? "alert" : "status"}>
      ${message.text}
    </div>
    ${message.warning
      ? html`<div class="callout warning" role="status">${message.warning}</div>`
      : nothing}
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

function renderLocalCost(card: ModelProviderCard, costDays: number) {
  const cost = card.localCost;
  if (!cost || (cost.totalTokens === 0 && cost.totalCost === 0)) {
    return nothing;
  }
  const costUnavailable = cost.totalCost === 0 && cost.missingCostEntries > 0;
  const incompleteCost = cost.totalCost > 0 && cost.missingCostEntries > 0;
  return html`
    <div class="model-providers__local-cost">
      <div class="provider-usage-billing-row">
        <span>${t("modelProviders.localCost", { days: String(costDays) })}</span>
        <strong title=${incompleteCost ? t("modelProviders.costIncomplete") : nothing}
          >${costUnavailable
            ? t("modelProviders.costUnavailable")
            : formatCost(cost.totalCost)}</strong
        >
      </div>
      <div class="model-providers__local-cost-detail">
        ${t("modelProviders.localCostDetail", {
          tokens: formatCompactTokenCount(cost.totalTokens),
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
  const unavailableMessage = classifyModelProviderCard(card).message;
  const parts = [];
  if (unavailableMessage) {
    parts.push(unavailableMessage);
  } else if (oauthCount > 0) {
    parts.push(
      t(
        oauthCount === 1
          ? "modelProviders.credentials.oauthOne"
          : "modelProviders.credentials.oauthMany",
        { count: String(oauthCount) },
      ),
    );
  }
  if (tokenCount > 0) {
    parts.push(
      t(
        tokenCount === 1
          ? "modelProviders.credentials.tokenOne"
          : "modelProviders.credentials.tokenMany",
        { count: String(tokenCount) },
      ),
    );
  }
  if (card.apiKey?.source === "config") {
    parts.push(t("modelProviders.credentials.configKey"));
  } else if (card.apiKey?.source === "env") {
    parts.push(
      card.apiKey.envVar
        ? t("modelProviders.credentials.envKeyNamed", { name: card.apiKey.envVar })
        : t("modelProviders.credentials.envKey"),
    );
  } else if (apiProfileCount > 0) {
    parts.push(
      t(
        apiProfileCount === 1
          ? "modelProviders.credentials.profileKeyOne"
          : "modelProviders.credentials.profileKeyMany",
        { count: String(apiProfileCount) },
      ),
    );
  }
  if (parts.length === 0 && card.runtimeLabels.length === 0) {
    return nothing;
  }
  const runtimeOnly = parts.length === 0;
  return html`
    <div class="model-providers__credentials">
      <span
        >${runtimeOnly
          ? t("modelProviders.credentials.runtime")
          : t("modelProviders.credentials.label")}</span
      >
      <strong>${runtimeOnly ? card.runtimeLabels.join(" · ") : parts.join(" · ")}</strong>
    </div>
  `;
}

function renderProbeResult(result: ModelsProbeResult | undefined) {
  if (!result) {
    return nothing;
  }
  const hasWarnings =
    result.status === "ok" && result.results.some((target) => target.status !== "ok");
  const presentation = hasWarnings ? "warning" : result.status === "ok" ? "success" : "error";
  return html`
    <div class="model-providers__probe model-providers__probe--${presentation}" role="status">
      <div class="model-providers__probe-summary">
        <strong
          >${hasWarnings
            ? t("modelProviders.probe.status.partial")
            : t(`modelProviders.probe.status.${result.status}`)}</strong
        >
        ${result.latencyMs !== undefined
          ? html`<span
              >${t("modelProviders.probe.latency", { ms: String(result.latencyMs) })}</span
            >`
          : nothing}
      </div>
      ${result.error ? html`<div>${formatUiExternalText(result.error)}</div>` : nothing}
      ${result.results.map(
        (target) => html`
          <div class="model-providers__probe-target">
            <span>${target.label}</span>
            <span>
              ${t(`modelProviders.probe.status.${target.status}`)}${target.latencyMs !== undefined
                ? ` · ${t("modelProviders.probe.latency", { ms: String(target.latencyMs) })}`
                : ""}
            </span>
            ${target.error ? html`<small>${formatUiExternalText(target.error)}</small>` : nothing}
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
  const mutationDisabled = configMutationDisabled(props);
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
          ?disabled=${busy || mutationDisabled || authModeBlocked}
          @input=${(event: Event) =>
            props.onKeyDraftChange((event.target as HTMLInputElement).value)}
        />
      </label>
      <div class="model-providers__form-actions">
        <button
          class="btn primary btn--sm"
          ?disabled=${busy || mutationDisabled || authModeBlocked || !props.keyDraft.trim()}
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
  const isConfigured = classifyModelProviderCard(card).configured;
  const canLogout = card.logoutTargets.length > 0;
  const probeBusy = Boolean(props.busy[`probe:${card.id}`]);
  const keyBusy = Boolean(props.busy[`key:${card.id}`]);
  const logoutBusy = Boolean(props.busy[`logout:${card.id}`]);
  const blocked = props.mutationBlockedReason ?? "";
  const authModeBlocked = Boolean(card.configAuthMode && card.configAuthMode !== "api-key");
  const apiKeyUnsupported = card.apiKeySupported === false;
  const mutationDisabled = configMutationDisabled(props);
  const keyBlocked = authModeBlocked
    ? t("modelProviders.apiKey.authModeBlocked", { mode: card.configAuthMode ?? "" })
    : blocked;
  return html`
    <div class="model-providers__card-actions">
      ${card.accessOptions.map(
        (option) => html`
          <button
            class="btn btn--sm"
            aria-label=${t(
              option.mode === "login"
                ? "modelSetup.unavailable.signIn"
                : "modelProviders.setup.action",
              { provider: option.label },
            )}
            ?disabled=${mutationDisabled || props.providerLoginBusy}
            title=${blocked}
            @click=${() => props.onLogin(card.id, option)}
          >
            ${option.mode === "setup"
              ? t("modelProviders.setup.action", { provider: option.label })
              : t("modelSetup.unavailable.signIn", { provider: option.label })}
          </button>
        `,
      )}
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
              ?disabled=${keyBusy || mutationDisabled || authModeBlocked}
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
              ?disabled=${keyBusy || mutationDisabled || authModeBlocked}
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
              ?disabled=${logoutBusy || mutationDisabled}
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
                ?disabled=${logoutBusy || mutationDisabled}
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
  const hasUsage = Boolean(
    card.usage ||
    (card.localCost && (card.localCost.totalTokens > 0 || card.localCost.totalCost > 0)),
  );
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
            ${models ? html`<span class="settings-row__desc">${models}</span>` : nothing}
          </div>
        </div>
        <div class="settings-row__control">
          ${card.usage?.plan ? renderSettingsValue(card.usage.plan) : nothing}
          ${renderProviderStatus(card)}
        </div>
      </div>
      ${renderCredentialSummary(card)}
      ${hasUsage
        ? html`<div
            class="model-providers__global-metrics"
            aria-busy=${props.supplementalLoading ? "true" : "false"}
          >
            <div class="model-providers__global-metrics-title">
              ${t("modelProviders.globalUsage")}
            </div>
            ${card.usage ? renderProviderUsageDetails(card.usage) : nothing}
            ${renderLocalCost(card, props.costDays)}
          </div>`
        : nothing}
      ${renderProviderActions(card, props)} ${renderKeyEditor(card, props)}
      ${renderProbeResult(props.probeResults[card.id])} ${renderMutationMessage(message)}
    </div>
  `;
}

function renderModelReadiness(props: ModelProvidersViewProps) {
  const signedIn = props.cards.some((card) => classifyModelProviderCard(card).verified);
  return html`
    <div class="model-providers__setup" data-model-readiness="model-required">
      ${renderSettingsSection(
        { title: t("modelProviders.readiness.title") },
        renderSettingsRow({
          title: t("modelProviders.readiness.heading"),
          description: signedIn
            ? t("modelProviders.readiness.signedInNoModels")
            : t("modelProviders.readiness.notConfigured"),
          control: html`
            ${renderSettingsStatus({
              kind: "warn",
              label: signedIn
                ? t("modelProviders.readiness.noModels")
                : t("modelProviders.readiness.modelRequired"),
            })}
            <button class="btn primary" @click=${props.onOpenModelSetup}>
              ${signedIn ? t("modelProviders.readiness.chooseProvider") : t("modelSetup.heading")}
            </button>
          `,
        }),
      )}
    </div>
  `;
}

function renderProviderNoticeRow(text: string) {
  return html`
    <div class="settings-row">
      <div class="settings-row__text">
        <span class="settings-row__desc provider-usage-error">${text}</span>
      </div>
    </div>
  `;
}

export function renderModelProviders(props: ModelProvidersViewProps) {
  if (!props.connected) {
    return renderSettingsPage(
      renderSettingsGroup(renderSettingsEmpty(t("modelProviders.disconnected"))),
    );
  }
  if (props.loading) {
    return renderSettingsPage(html`
      <div id=${MODEL_SETTINGS_TARGET_IDS.behavior}>
        ${renderDefaultModels({
          models: props.configuredModels,
          selection: props.defaultModels,
          thinkingLevel: props.thinkingLevel,
          thinkingOverridden: props.thinkingOverridden,
          fastMode: props.fastMode,
          fastModeOverridden: props.fastModeOverridden,
          loading: true,
          canMutate: !configMutationDisabled(props),
          mutationBlockedReason: props.mutationBlockedReason,
          busy: props.busy,
          message: props.messages.defaults,
          onPrimaryChange: props.onPrimaryChange,
          onFallbackChange: props.onFallbackChange,
          onUtilityChange: props.onUtilityChange,
          onThinkingChange: props.onThinkingChange,
          onThinkingReset: props.onThinkingReset,
          onFastModeChange: props.onFastModeChange,
          onFastModeReset: props.onFastModeReset,
        })}
      </div>
      ${renderSettingsGroup(renderSettingsLoadingSkeleton())}
    `);
  }
  const providerRows = html`
    <div class="model-providers__provider-list">
      ${props.error ? renderSettingsGroup(renderProviderNoticeRow(props.error)) : nothing}
      ${props.providerUsageFailed
        ? renderSettingsGroup(renderProviderNoticeRow(t("usage.providerUsage.unavailable")))
        : nothing}
      ${props.cards.length === 0
        ? renderSettingsGroup(
            renderSettingsEmpty(
              html`<strong>${t("modelProviders.emptyTitle")}</strong><br />${t(
                  "modelProviders.emptySubtitle",
                )}`,
            ),
          )
        : props.cards.map((card) => renderSettingsGroup(renderProviderRow(card, props)))}
    </div>
  `;
  const needsModelSetup = !props.configuredModels.some((model) => model.available !== false);
  return renderSettingsPage(html`
    ${needsModelSetup ? renderModelReadiness(props) : nothing}
    <div id=${MODEL_SETTINGS_TARGET_IDS.behavior}>
      ${renderDefaultModels({
        models: props.configuredModels,
        selection: props.defaultModels,
        thinkingLevel: props.thinkingLevel,
        thinkingOverridden: props.thinkingOverridden,
        fastMode: props.fastMode,
        fastModeOverridden: props.fastModeOverridden,
        canMutate: !configMutationDisabled(props),
        mutationBlockedReason: props.mutationBlockedReason,
        busy: props.busy,
        message: props.messages.defaults,
        onPrimaryChange: props.onPrimaryChange,
        onFallbackChange: props.onFallbackChange,
        onUtilityChange: props.onUtilityChange,
        onThinkingChange: props.onThinkingChange,
        onThinkingReset: props.onThinkingReset,
        onFastModeChange: props.onFastModeChange,
        onFastModeReset: props.onFastModeReset,
      })}
    </div>
    ${renderSettingsSection(
      {
        title: t("modelProviders.title"),
        count: props.cards.length,
        actions: html`
          ${props.updatedAt
            ? html`<span class="model-providers__updated"
                >${t("modelProviders.updated", {
                  time: formatTimeMs(props.updatedAt, {
                    hour: "numeric",
                    minute: "2-digit",
                  }),
                })}</span
              >`
            : nothing}
          <openclaw-tooltip
            .content=${props.refreshing ? t("modelProviders.refreshing") : t("common.refresh")}
          >
            <button
              type="button"
              class="btn btn--icon btn--ghost btn--xs model-providers__refresh-button"
              aria-label=${props.refreshing ? t("modelProviders.refreshing") : t("common.refresh")}
              ?disabled=${props.refreshing}
              @click=${() => props.onRefresh()}
            >
              ${icons.refresh}
            </button>
          </openclaw-tooltip>
        `,
      },
      providerRows,
    )}
    ${props.providerUsageStalled
      ? html`<div class="callout warning" role="status">${t("usage.providerUsage.stalled")}</div>`
      : nothing}
  `);
}
