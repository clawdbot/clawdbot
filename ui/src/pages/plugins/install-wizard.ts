import { html, nothing, type TemplateResult } from "lit";
import type { ConfigUiHints } from "../../api/types.ts";
import { renderNode } from "../../components/config-form.ts";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { renderReasonedDisabledControl } from "../../components/reasoned-disabled-control.ts";
import { t } from "../../i18n/index.ts";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
import type { PluginInstallWizardStage, PluginInstallWizardState } from "./install-wizard-model.ts";
import { renderPluginAuthor, renderPluginOfficialBadge } from "./plugin-card.ts";
import { pluginEntryValue } from "./settings-model.ts";

type PluginInstallWizardProps = {
  state: PluginInstallWizardState;
  mutationBlockedReason: string | null;
  canMutate: boolean;
  busy: boolean;
  configSchema: JsonSchema | null;
  configSchemaLoading: boolean;
  configValue: Record<string, unknown> | null;
  configHints: ConfigUiHints;
  configUnsupportedPaths: readonly string[];
  configBusy: boolean;
  configError: string | null;
  canEditConfig: boolean;
  onClose: () => void;
  onInstall: () => void;
  onContinuePolicyWarning: () => void;
  onRetry: () => void;
  onConfigPatch: (path: Array<string | number>, value: unknown) => void;
  onConfigRemove: (path: Array<string | number>) => void;
  onSaveConfiguration: () => void;
  onManage: () => void;
};

const STAGE_ORDER: readonly PluginInstallWizardStage[] = [
  "review",
  "installing",
  "reconnecting",
  "configuring",
  "enabling",
  "success",
];

function stagePosition(stage: PluginInstallWizardStage): number {
  if (stage === "policy-warning" || stage === "error") {
    return 1;
  }
  return STAGE_ORDER.indexOf(stage);
}

function renderProgress(stage: PluginInstallWizardStage): TemplateResult {
  const current = stagePosition(stage);
  const steps = [
    ["review", t("pluginsPage.installWizard.reviewStep")],
    ["installing", t("pluginsPage.installWizard.installStep")],
    ["reconnecting", t("pluginsPage.installWizard.restartStep")],
    ["configuring", t("pluginsPage.installWizard.configureStep")],
    ["enabling", t("pluginsPage.installWizard.enableStep")],
  ] as const;
  return html`<ol
    class="plugin-install-wizard__progress"
    aria-label=${t("pluginsPage.installWizard.progressLabel")}
  >
    ${steps.map(([step, label]) => {
      const position = STAGE_ORDER.indexOf(step);
      const complete = current > position;
      const active = current === position;
      return html`<li class=${complete ? "is-complete" : active ? "is-active" : ""}>
        <span aria-hidden="true">${complete ? icons.check : position + 1}</span>
        ${label}
      </li>`;
    })}
  </ol>`;
}

function requestSource(state: PluginInstallWizardState): string {
  const request = state.request;
  return request.source === "clawhub"
    ? `ClawHub · ${request.packageName}`
    : `${t("pluginsPage.official")} · ${request.pluginId}`;
}

function renderReview(state: PluginInstallWizardState): TemplateResult {
  const { plugin, detail } = state.detail;
  const capabilities = [
    ...detail.skills.map((skill) => skill.name),
    ...detail.mcpServers.map((server) => `MCP: ${server}`),
  ];
  return html`
    <div class="plugin-install-wizard__review">
      <dl>
        <div>
          <dt>${t("pluginsPage.installedSource")}</dt>
          <dd>${requestSource(state)}</dd>
        </div>
        ${
          detail.security
            ? html`<div>
                <dt>${t("pluginsPage.detailSecurity")}</dt>
                <dd>
                  ${detail.security.status}${
                    detail.security.summary ? ` · ${detail.security.summary}` : ""
                  }
                </dd>
              </div>`
            : nothing
        }
        <div>
          <dt>${t("pluginsPage.installWizard.capabilities")}</dt>
          <dd>
            ${
              capabilities.length
                ? capabilities.join(", ")
                : t("pluginsPage.installWizard.noDeclaredCapabilities")
            }
          </dd>
        </div>
        <div>
          <dt>${t("pluginsPage.installWizard.restartImpact")}</dt>
          <dd>${t("pluginsPage.installWizard.restartDescription")}</dd>
        </div>
      </dl>
      ${plugin.catalog.summary ? html`<p>${plugin.catalog.summary}</p>` : nothing}
    </div>
  `;
}

function renderConfiguration(props: PluginInstallWizardProps): TemplateResult {
  const pluginId = props.state.pluginId;
  if (!pluginId || !props.configValue || !props.configSchema) {
    if (props.configError) {
      return html`<div class="plugin-install-wizard__alert" role="alert">
        ${props.configError}
      </div>`;
    }
    return html`<p class="plugin-install-wizard__status" role="status">
      ${
        props.configSchemaLoading
          ? t("pluginsPage.installWizard.loadingConfiguration")
          : t("pluginsPage.schemaUnavailable")
      }
    </p>`;
  }
  const pluginEntry = pluginEntryValue(props.configValue, pluginId);
  return html`
    <p class="plugin-install-wizard__status">${t("pluginsPage.installWizard.configureBody")}</p>
    <div class="plugin-install-wizard__config">
      ${renderNode({
        schema: props.configSchema,
        value: pluginEntry.config ?? {},
        path: ["plugins", "entries", pluginId, "config"],
        hints: props.configHints,
        unsupported: new Set(props.configUnsupportedPaths),
        disabled: !props.canEditConfig || props.configBusy,
        showLabel: false,
        onPatch: props.onConfigPatch,
        onRemove: props.onConfigRemove,
      })}
    </div>
    ${
      props.configError
        ? html`<div class="plugin-install-wizard__alert" role="alert">${props.configError}</div>`
        : nothing
    }
  `;
}

function renderStage(props: PluginInstallWizardProps): TemplateResult {
  const stage = props.state.stage;
  if (stage === "review") {
    return renderReview(props.state);
  }
  if (stage === "policy-warning") {
    return html`<div
      class="plugin-install-wizard__alert plugin-install-wizard__alert--warning"
      role="alert"
    >
      <strong>${t("pluginsPage.installWizard.policyWarningTitle")}</strong>
      <p>${props.state.policyReason}</p>
    </div>`;
  }
  if (stage === "configuring") {
    return renderConfiguration(props);
  }
  if (stage === "error") {
    return html`<div class="plugin-install-wizard__alert" role="alert">
      <strong>${t("pluginsPage.installWizard.failedTitle")}</strong>
      <p>${props.state.error}</p>
    </div>`;
  }
  if (stage === "success") {
    return html`<div class="plugin-install-wizard__success" role="status">
      <span aria-hidden="true">${icons.check}</span>
      <div>
        <strong>${t("pluginsPage.installWizard.successTitle")}</strong>
        <p>
          ${t("pluginsPage.installWizard.successBody", {
            name: props.state.detail.plugin.catalog.name,
          })}
        </p>
      </div>
    </div>`;
  }
  const message =
    stage === "installing"
      ? t("pluginsPage.installWizard.installingBody")
      : stage === "reconnecting"
        ? t("pluginsPage.installWizard.reconnectingBody")
        : t("pluginsPage.installWizard.enablingBody");
  return html`<div class="plugin-install-wizard__working" role="status">
    <span class="plugin-install-wizard__spinner" aria-hidden="true"></span>
    <p>${message}</p>
  </div>`;
}

function renderPrimaryAction(props: PluginInstallWizardProps): TemplateResult | typeof nothing {
  const stage = props.state.stage;
  const blocked = !props.canMutate || props.busy;
  if (stage === "success") {
    return html`<button
      type="button"
      class="btn primary oc-action oc-action-primary"
      @click=${props.onManage}
    >
      ${t("pluginsPage.installWizard.managePlugin")}
    </button>`;
  }
  if (stage === "error") {
    return html`<button
      type="button"
      class="btn primary oc-action oc-action-primary"
      @click=${props.onRetry}
    >
      ${t("pluginsPage.tryAgain")}
    </button>`;
  }
  if (stage === "policy-warning") {
    return html`<button
      type="button"
      class="btn primary oc-action oc-action-primary"
      @click=${props.onContinuePolicyWarning}
    >
      ${t("pluginsPage.installWizard.continueInstall")}
    </button>`;
  }
  if (stage === "configuring") {
    const button = html`<button
      type="button"
      class="btn primary oc-action oc-action-primary"
      ?disabled=${
        !props.mutationBlockedReason && (blocked || props.configBusy || !props.configSchema)
      }
      @click=${props.onSaveConfiguration}
    >
      ${props.configBusy ? t("pluginsPage.working") : t("pluginsPage.installWizard.saveAndEnable")}
    </button>`;
    return renderReasonedDisabledControl(
      props.mutationBlockedReason ??
        (!props.canEditConfig ? t("pluginsPage.changesDisabled") : null),
      button,
    );
  }
  if (stage !== "review") {
    return nothing;
  }
  const button = html`<button
    type="button"
    class="btn primary oc-action oc-action-primary"
    ?disabled=${!props.mutationBlockedReason && blocked}
    @click=${() => {
      if (!blocked) {
        props.onInstall();
      }
    }}
  >
    ${t("pluginsPage.installNamed", { name: props.state.detail.plugin.catalog.name })}
  </button>`;
  return renderReasonedDisabledControl(props.mutationBlockedReason, button);
}

export function renderPluginInstallWizard(props: PluginInstallWizardProps): TemplateResult {
  const catalog = props.state.detail.plugin.catalog;
  const { official, author } = catalog;
  const isWorking = ["installing", "reconnecting", "enabling"].includes(props.state.stage);
  return html`<openclaw-modal-dialog
    label=${t("pluginsPage.installWizard.title", { name: catalog.name })}
    style="--openclaw-modal-width: min(720px, calc(100vw - 32px));"
    @modal-cancel=${() => {
      if (!isWorking) {
        props.onClose();
      }
    }}
  >
    <section class="plugin-install-wizard oc-card" data-stage=${props.state.stage}>
      <header class="plugin-install-wizard__header">
        <div>
          <div class="plugin-install-wizard__title-row">
            <h2>${catalog.name}</h2>
            ${official ? renderPluginOfficialBadge() : nothing}
          </div>
          ${renderPluginAuthor(author, { linked: true })}
        </div>
        ${
          !isWorking
            ? html`<button
                type="button"
                class="btn btn--icon oc-action oc-action-icon oc-action-secondary"
                aria-label=${t("pluginsPage.cancel")}
                @click=${props.onClose}
              >
                ${icons.x}
              </button>`
            : nothing
        }
      </header>
      ${renderProgress(props.state.stage)}
      <div class="plugin-install-wizard__body">${renderStage(props)}</div>
      <footer class="plugin-install-wizard__actions">
        ${
          props.state.stage === "review" || props.state.stage === "configuring"
            ? html`<button
                type="button"
                class="btn oc-action oc-action-secondary"
                @click=${props.onClose}
              >
                ${t("pluginsPage.cancel")}
              </button>`
            : nothing
        }
        ${renderPrimaryAction(props)}
      </footer>
    </section>
  </openclaw-modal-dialog>`;
}
