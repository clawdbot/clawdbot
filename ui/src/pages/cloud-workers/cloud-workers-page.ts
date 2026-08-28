import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import type { EnvironmentsListResult } from "../../../../packages/gateway-protocol/src/index.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import {
  renderDocsLink,
  renderLearnMoreLink,
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsToggleRow,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { resolveEditableSnapshotConfig } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  buildCloudWorkerDeletePatch,
  buildCloudWorkerUpsertPatch,
  cloudWorkerProfileStatus,
  createCloudWorkerDraft,
  readCloudWorkerProfiles,
  validateCloudWorkerDraft,
  type CloudWorkerDraftError,
  type CloudWorkerProfileDraft,
  type ConfiguredCloudWorkerProfile,
} from "./cloud-worker-config.ts";

const CLOUD_WORKERS_DOCS_URL = "https://docs.openclaw.ai/gateway/cloud-workers";
type EditorState = { kind: "add" } | { kind: "edit"; profileId: string } | null;

function formControlValue(event: Event): string {
  const target = event.currentTarget;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    ? target.value
    : "";
}

class CloudWorkersPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private advertisedProfileIds = new Set<string>();
  @state() private catalogLoaded = false;
  @state() private catalogLoading = false;
  @state() private catalogError: string | null = null;
  @state() private editor: EditorState = null;
  @state() private draft: CloudWorkerProfileDraft = createCloudWorkerDraft();
  @state() private formError: string | null = null;
  @state() private notice: string | null = null;
  @state() private busyProfileId: string | null = null;

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    invalidateRequests: () => this.resetGatewayState(),
    onSnapshot: (change) => {
      if (change.initial) {
        this.resetGatewayState();
      }
    },
    ensureInitialData: () => void this.loadCatalog(),
  });
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.runtimeConfig,
    (runtimeConfig) => {
      void runtimeConfig.ensureLoaded();
      return runtimeConfig.subscribe(() => this.requestUpdate());
    },
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private resetGatewayState() {
    this.busyProfileId = null;
    this.advertisedProfileIds = new Set();
    this.catalogLoaded = false;
    this.catalogLoading = false;
    this.catalogError = null;
  }

  private async loadCatalog() {
    if (this.catalogLoading || this.catalogLoaded) {
      return;
    }
    const scope = this.gateway.capture();
    if (
      !scope ||
      !canCallGatewayMethod(this.gateway.snapshot, "environments.list", "operator.admin")
    ) {
      this.catalogLoaded = true;
      return;
    }
    this.catalogLoading = true;
    this.catalogError = null;
    try {
      const result = await scope.client.request<EnvironmentsListResult>("environments.list", {});
      if (!this.gateway.isCurrent(scope)) {
        return;
      }
      this.advertisedProfileIds = new Set((result.profiles ?? []).map((profile) => profile.id));
      this.catalogLoaded = true;
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.catalogError = formatUiError(error);
        this.catalogLoaded = true;
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.catalogLoading = false;
      }
    }
  }

  private editableConfig(): Record<string, unknown> | null {
    return resolveEditableSnapshotConfig(this.context?.runtimeConfig.state.configSnapshot);
  }

  private profiles(): ConfiguredCloudWorkerProfile[] {
    return readCloudWorkerProfiles(this.editableConfig());
  }

  private hasManageAccess(): boolean {
    return canCallGatewayMethod(this.gateway.snapshot, "config.patch", "operator.admin");
  }

  private canManage(): boolean {
    const configState = this.context?.runtimeConfig.state;
    return Boolean(
      this.hasManageAccess() &&
      configState?.configSnapshot?.hash &&
      !configState.configLoading &&
      !configState.configSaving &&
      this.busyProfileId === null,
    );
  }

  private openAdd() {
    if (!this.canManage()) {
      return;
    }
    this.editor = { kind: "add" };
    this.draft = createCloudWorkerDraft();
    this.formError = null;
    this.notice = null;
  }

  private openEdit(profile: ConfiguredCloudWorkerProfile) {
    if (!this.canManage()) {
      return;
    }
    if (profile.providerId !== "crabbox") {
      this.context.navigate("advanced", { search: "?section=cloudWorkers" });
      return;
    }
    this.editor = { kind: "edit", profileId: profile.id };
    this.draft = createCloudWorkerDraft(profile);
    this.formError = null;
    this.notice = null;
  }

  private closeEditor() {
    if (this.busyProfileId !== null) {
      return;
    }
    this.editor = null;
    this.formError = null;
  }

  private patchDraft(patch: Partial<CloudWorkerProfileDraft>) {
    this.draft = { ...this.draft, ...patch };
    this.formError = null;
  }

  private errorText(error: CloudWorkerDraftError): string {
    return t(`cloudWorkersPage.errors.${error}`);
  }

  private async saveProfile(draft: CloudWorkerProfileDraft) {
    const scope = this.gateway.capture();
    const runtimeConfig = this.context.runtimeConfig;
    const editingId = this.editor?.kind === "edit" ? this.editor.profileId : null;
    const config = this.editableConfig();
    if (!scope || !this.editor || !config || !this.canManage()) {
      return;
    }
    const currentProfiles = Object.fromEntries(
      this.profiles().map((profile) => [profile.id, true]),
    );
    const validationError = validateCloudWorkerDraft(draft, currentProfiles, editingId);
    if (validationError) {
      this.formError = this.errorText(validationError);
      return;
    }
    const profileId = editingId ?? draft.id;
    this.busyProfileId = profileId;
    this.formError = null;
    this.notice = null;
    const isCurrent = () =>
      this.gateway.isCurrent(scope) && this.context.runtimeConfig === runtimeConfig;
    try {
      const patched = await runtimeConfig.patchFromSnapshot((base) => {
        const built = buildCloudWorkerUpsertPatch(base, draft, editingId);
        return "error" in built
          ? { error: this.errorText(built.error) }
          : {
              options: {
                raw: built.patch,
                note: `cloud workers: ${editingId ? "update" : "add"} ${profileId}`,
                canDispatch: isCurrent,
              },
            };
      });
      if (!isCurrent()) {
        return;
      }
      if (!patched) {
        this.formError = runtimeConfig.state.lastError ?? t("cloudWorkersPage.errors.saveFailed");
        return;
      }
      this.editor = null;
      this.notice = t("labsPage.restartRequired");
    } catch (error) {
      if (isCurrent()) {
        this.formError = formatUiError(error);
      }
    } finally {
      if (isCurrent()) {
        this.busyProfileId = null;
      }
    }
  }

  private async deleteProfile(profile: ConfiguredCloudWorkerProfile) {
    const gateway = this.context.gateway;
    const client = gateway.snapshot.client;
    const gatewayUrl = gateway.connection.gatewayUrl;
    const runtimeConfig = this.context.runtimeConfig;
    if (
      !this.canManage() ||
      !(await showConfirmDialog({
        title: t("cloudWorkersPage.deleteTitle"),
        message: t("cloudWorkersPage.deleteConfirm", { profile: profile.id }),
        confirmLabel: t("common.delete"),
        danger: true,
      }))
    ) {
      return;
    }
    const scope = this.gateway.capture();
    if (
      !scope ||
      scope.client !== client ||
      this.context.gateway !== gateway ||
      gateway.connection.gatewayUrl !== gatewayUrl ||
      this.context.runtimeConfig !== runtimeConfig ||
      !this.canManage()
    ) {
      this.formError = t("cloudWorkersPage.errors.deleteFailed");
      return;
    }
    this.busyProfileId = profile.id;
    this.formError = null;
    this.notice = null;
    const isCurrent = () =>
      this.gateway.isCurrent(scope) && this.context.runtimeConfig === runtimeConfig;
    try {
      const patched = await runtimeConfig.patchFromSnapshot((base) => {
        const built = buildCloudWorkerDeletePatch(base, profile.id);
        return "error" in built
          ? { error: this.errorText(built.error) }
          : {
              options: {
                raw: built.patch,
                note: `cloud workers: delete ${profile.id}`,
                canDispatch: isCurrent,
              },
            };
      });
      if (!isCurrent()) {
        return;
      }
      if (!patched) {
        this.formError = runtimeConfig.state.lastError ?? t("cloudWorkersPage.errors.deleteFailed");
        return;
      }
      if (this.editor?.kind === "edit" && this.editor.profileId === profile.id) {
        this.editor = null;
      }
      this.notice = t("labsPage.restartRequired");
    } catch (error) {
      if (isCurrent()) {
        this.formError = formatUiError(error);
      }
    } finally {
      if (isCurrent()) {
        this.busyProfileId = null;
      }
    }
  }

  private profileDescription(profile: ConfiguredCloudWorkerProfile): string {
    if (profile.providerId !== "crabbox") {
      return t("cloudWorkersPage.providerFact", {
        provider: profile.providerId || t("common.unknown"),
      });
    }
    return [
      t("cloudWorkersPage.backendFact", { backend: profile.backend || t("common.unknown") }),
      t("cloudWorkersPage.classFact", { value: profile.machineClass || t("common.unknown") }),
      t("cloudWorkersPage.ttlFact", { value: profile.ttl || t("common.unknown") }),
      t("cloudWorkersPage.idleFact", { value: profile.idleTimeout || t("common.unknown") }),
      t("cloudWorkersPage.desktopFact", {
        value: profile.desktop ? t("common.enabled") : t("common.disabled"),
      }),
    ].join(" · ");
  }

  private renderProfile(profile: ConfiguredCloudWorkerProfile) {
    const status = cloudWorkerProfileStatus(
      profile.id,
      this.advertisedProfileIds,
      this.catalogLoaded,
    );
    const statusControl =
      status === "advertised"
        ? renderSettingsStatus({ kind: "ok", label: t("cloudWorkersPage.advertised") })
        : status === "restart-required"
          ? renderSettingsStatus({ kind: "warn", label: t("cloudWorkersPage.restartRequired") })
          : renderSettingsStatus({ kind: "muted", label: t("common.loading") });
    const canManage = this.canManage();
    return renderSettingsRow({
      title: html`<code>${profile.id}</code>`,
      description: this.profileDescription(profile),
      control: html`
        ${statusControl}
        <button
          class="btn btn--sm"
          type="button"
          ?disabled=${!canManage}
          @click=${() => this.openEdit(profile)}
        >
          ${t("cloudWorkersPage.editAction")}
        </button>
        <button
          class="btn btn--sm danger"
          type="button"
          ?disabled=${!canManage}
          @click=${() => void this.deleteProfile(profile)}
        >
          ${t("common.delete")}
        </button>
      `,
    });
  }

  private renderEditor() {
    if (!this.editor) {
      return nothing;
    }
    const busy = this.busyProfileId !== null;
    const canSave = this.canManage();
    const editing = this.editor.kind === "edit";
    return renderSettingsSection(
      {
        title: editing ? t("cloudWorkersPage.editProfile") : t("cloudWorkersPage.addProfile"),
      },
      [
        renderSettingsRow({
          title: t("cloudWorkersPage.fields.profileId"),
          description: t("cloudWorkersPage.fields.profileIdHelp"),
          control: editing
            ? renderSettingsValue(this.draft.id, { mono: true })
            : html`<input
                class="settings-input mono"
                aria-label=${t("cloudWorkersPage.fields.profileId")}
                autocomplete="off"
                spellcheck="false"
                .value=${this.draft.id}
                ?disabled=${busy}
                @input=${(event: Event) => this.patchDraft({ id: formControlValue(event) })}
              />`,
        }),
        renderSettingsRow({
          title: t("cloudWorkersPage.fields.backend"),
          description: html`${t("cloudWorkersPage.fields.backendHelp")}
          ${renderDocsLink(CLOUD_WORKERS_DOCS_URL, t("cloudWorkersPage.providerList"))}`,
          control: html`<input
            class="settings-input mono"
            aria-label=${t("cloudWorkersPage.fields.backend")}
            placeholder=${t("cloudWorkersPage.fields.backendPlaceholder")}
            autocomplete="off"
            spellcheck="false"
            .value=${this.draft.backend}
            ?disabled=${busy}
            @input=${(event: Event) => this.patchDraft({ backend: formControlValue(event) })}
          />`,
        }),
        renderSettingsRow({
          title: t("cloudWorkersPage.fields.machineClass"),
          description: t("cloudWorkersPage.fields.machineClassHelp"),
          control: html`<input
            class="settings-input mono"
            aria-label=${t("cloudWorkersPage.fields.machineClass")}
            autocomplete="off"
            spellcheck="false"
            .value=${this.draft.machineClass}
            ?disabled=${busy}
            @input=${(event: Event) => this.patchDraft({ machineClass: formControlValue(event) })}
          />`,
        }),
        renderSettingsRow({
          title: t("cloudWorkersPage.fields.ttl"),
          description: t("cloudWorkersPage.fields.ttlHelp"),
          control: html`<input
            class="settings-input mono"
            aria-label=${t("cloudWorkersPage.fields.ttl")}
            placeholder=${t("cloudWorkersPage.fields.ttlPlaceholder")}
            autocomplete="off"
            spellcheck="false"
            .value=${this.draft.ttl}
            ?disabled=${busy}
            @input=${(event: Event) => this.patchDraft({ ttl: formControlValue(event) })}
          />`,
        }),
        renderSettingsRow({
          title: t("cloudWorkersPage.fields.idleTimeout"),
          description: t("cloudWorkersPage.fields.idleTimeoutHelp"),
          control: html`<input
            class="settings-input mono"
            aria-label=${t("cloudWorkersPage.fields.idleTimeout")}
            placeholder=${t("cloudWorkersPage.fields.idleTimeoutPlaceholder")}
            autocomplete="off"
            spellcheck="false"
            .value=${this.draft.idleTimeout}
            ?disabled=${busy}
            @input=${(event: Event) => this.patchDraft({ idleTimeout: formControlValue(event) })}
          />`,
        }),
        renderSettingsRow({
          title: t("cloudWorkersPage.fields.setup"),
          description: t("cloudWorkersPage.fields.setupHelp"),
          stacked: true,
          control: html`<textarea
            class="settings-input mono"
            aria-label=${t("cloudWorkersPage.fields.setup")}
            placeholder=${t("cloudWorkersPage.fields.setupPlaceholder")}
            autocomplete="off"
            spellcheck="false"
            .value=${this.draft.setup}
            ?disabled=${busy}
            @input=${(event: Event) => this.patchDraft({ setup: formControlValue(event) })}
          ></textarea>`,
        }),
        renderSettingsToggleRow({
          title: t("cloudWorkersPage.fields.desktop"),
          description: t("cloudWorkersPage.fields.desktopHelp"),
          checked: this.draft.desktop,
          disabled: busy,
          onChange: (desktop) => this.patchDraft({ desktop }),
        }),
        renderSettingsRow({
          title: t("cloudWorkersPage.fields.binary"),
          description: t("cloudWorkersPage.fields.binaryHelp"),
          control: html`<input
            class="settings-input mono"
            aria-label=${t("cloudWorkersPage.fields.binary")}
            placeholder=${t("cloudWorkersPage.fields.binaryPlaceholder")}
            autocomplete="off"
            spellcheck="false"
            .value=${this.draft.binary}
            ?disabled=${busy}
            @input=${(event: Event) => this.patchDraft({ binary: formControlValue(event) })}
          />`,
        }),
        ...(this.formError
          ? [
              renderSettingsRow({
                title: t("cloudWorkersPage.errors.title"),
                description: html`<span role="alert">${this.formError}</span>`,
              }),
            ]
          : []),
        renderSettingsRow({
          title: t("cloudWorkersPage.fields.actions"),
          description: t("cloudWorkersPage.fields.actionsHelp"),
          control: html`
            <button
              class="btn primary"
              type="button"
              ?disabled=${!canSave}
              @click=${() => void this.saveProfile(this.draft)}
            >
              ${busy ? t("common.saving") : t("common.save")}
            </button>
            <button class="btn" type="button" ?disabled=${busy} @click=${() => this.closeEditor()}>
              ${t("common.cancel")}
            </button>
          `,
        }),
      ],
    );
  }

  override render() {
    const profiles = this.profiles();
    const canManage = this.canManage();
    const addAction = canManage
      ? html`<button class="btn btn--sm primary" type="button" @click=${() => this.openAdd()}>
          ${t("cloudWorkersPage.addProfile")}
        </button>`
      : undefined;
    const rows = profiles.length
      ? profiles.map((profile) => this.renderProfile(profile))
      : renderSettingsEmpty(t("cloudWorkersPage.empty"));
    const body = renderSettingsPage(html`
      ${!this.hasManageAccess()
        ? html`<div class="callout warning" role="note">
            ${t("cloudWorkersPage.adminRequired")}
          </div>`
        : nothing}
      ${this.catalogError
        ? html`<div class="callout warning" role="status">
            ${t("cloudWorkersPage.catalogFailed", { error: this.catalogError })}
          </div>`
        : nothing}
      ${this.formError && !this.editor
        ? html`<div class="callout warning" role="alert">${this.formError}</div>`
        : nothing}
      ${this.notice
        ? html`<div class="callout warning" role="status">${this.notice}</div>`
        : nothing}
      ${renderSettingsSection(
        {
          title: t("cloudWorkersPage.sectionTitle"),
          description: t("cloudWorkersPage.sectionDescription"),
          actions: addAction,
          count: profiles.length,
        },
        rows,
      )}
      ${this.renderEditor()}
    `);
    return html`
      ${renderSettingsPageHeader({
        title: titleForRoute("cloud-workers"),
        subtitle: html`${t("cloudWorkersPage.intro")} ${renderLearnMoreLink(CLOUD_WORKERS_DOCS_URL)}`,
      })}
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-cloud-workers-page")) {
  customElements.define("openclaw-cloud-workers-page", CloudWorkersPage);
}
