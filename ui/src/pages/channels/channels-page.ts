import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type {
  ChannelsPairingListResult,
  ChannelsPairingRequest,
  NostrProfile,
} from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { resolveControlUiAuthHeader } from "../../app/control-ui-auth.ts";
import { hasOperatorAdminAccess, hasOperatorPairingAccess } from "../../app/operator-access.ts";
import { loadSettings, patchSettings } from "../../app/settings.ts";
import { renderDocsLink } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { resolveChannelPairingAuthSignature } from "../../lib/channels/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import {
  GatewayPageController,
  type GatewayPageChange,
} from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { importNostrProfile, parseValidationErrors, putNostrProfile } from "./nostr-profile-ops.ts";
import { createNostrProfileFormState } from "./view.nostr-profile-form.ts";
import { renderChannels } from "./view.ts";
import type { ChannelPairingPrompt } from "./view.types.ts";
import { runWhatsAppLogoutConfirmation } from "./whatsapp-logout.ts";
import { ChannelWizardHost } from "./wizard-host.ts";

type NostrProfileFormState = ReturnType<typeof createNostrProfileFormState> | null;

const CHANNEL_PAIRING_POLL_INTERVAL_MS = 30_000;
const CHANNELS_DOCS_URL = "https://docs.openclaw.ai/channels";

type NostrOperation = {
  scope: GatewayConnectionScope;
  gateway: ApplicationContext["gateway"];
  channels: ApplicationContext["channels"];
  formAccountId: string | null;
  accountId: string;
  headers: Record<string, string>;
};

function formatNostrProfileOperationError(error: unknown, prefix: string): string {
  return error instanceof DOMException && error.name === "TimeoutError"
    ? t("channels.nostr.notices.timeout")
    : t("channels.nostr.notices.operationFailed", { prefix, error: formatUiError(error) });
}

class ChannelsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state()
  private nostrProfileFormState: NostrProfileFormState = null;

  @state()
  private nostrProfileAccountId: string | null = null;

  @state()
  private selectedChannel: string | null = null;

  @state()
  private pairingChannelFilter: string | null = null;

  @state()
  private pairingAccountFilter: string | null = null;

  @state()
  private pairingPrompt: ChannelPairingPrompt | null = null;

  @state()
  private pairingNotice: string | null = null;

  @state()
  private showAdvancedSettings = false;

  private readonly wizardHost = new ChannelWizardHost({
    getContext: () => this.context,
    requestUpdate: () => this.requestUpdate(),
    clearSelection: () => {
      this.selectedChannel = null;
    },
  });

  private schemaLoadStarted = false;
  private channelsSource?: ApplicationContext["channels"];
  private gatewayPairingAuthSignature: string | null = null;
  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => this.clearNostrForm(),
    onSnapshot: (change) => this.handleGatewaySnapshot(change),
  });
  private readonly pairingPolling = new PollController(
    this,
    CHANNEL_PAIRING_POLL_INTERVAL_MS,
    () => {
      const gateway = this.context?.gateway.snapshot;
      if (gateway?.phase === "connected" && hasOperatorPairingAccess(gateway.hello?.auth ?? null)) {
        void this.context.channels.refreshPairing();
      }
    },
    false,
  );

  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.channels,
      (channels) => {
        const sourceChanged = this.channelsSource !== undefined && this.channelsSource !== channels;
        this.channelsSource = channels;
        if (sourceChanged) {
          this.invalidateNostrForm();
        }
        const handleChange = () => {
          if (this.channelsSource === channels) {
            this.reconcilePairingFilter(channels.state.pairingSnapshot);
            this.requestUpdate();
          }
        };
        handleChange();
        return channels.subscribe(handleChange);
      },
    )
    .effect(
      () => this.context?.runtimeConfig,
      (runtimeConfig) => {
        this.schemaLoadStarted = false;
        const handleChange = () => {
          if (this.context.runtimeConfig !== runtimeConfig) {
            return;
          }
          this.requestUpdate();
          this.ensureInitialData();
        };
        handleChange();
        const unsubscribe = runtimeConfig.subscribe(handleChange);
        return () => {
          unsubscribe();
          this.schemaLoadStarted = false;
        };
      },
    )
    // The advanced tier is one global display pref; theme republishes every
    // appearance setting, so this keeps the channel forms in sync with the
    // toggle on the config pages.
    .watch(
      () => this.context?.theme,
      (theme, notify) => theme.subscribe(notify),
      () => {
        this.showAdvancedSettings = loadSettings().showAdvancedSettings === true;
      },
    );

  private handleGatewaySnapshot(change: GatewayPageChange) {
    const snapshot = change.snapshot;
    const pairingAccess = hasOperatorPairingAccess(snapshot.hello?.auth ?? null);
    const pairingAuthSignature = resolveChannelPairingAuthSignature(snapshot);
    const pairingAuthChanged =
      !change.initial && this.gatewayPairingAuthSignature !== pairingAuthSignature;
    if (change.identityChanged || snapshot.phase !== "connected") {
      this.clearNostrForm();
    }
    if (
      change.identityChanged ||
      pairingAuthChanged ||
      snapshot.phase !== "connected" ||
      !pairingAccess
    ) {
      this.pairingPrompt = null;
      this.pairingChannelFilter = null;
      this.pairingAccountFilter = null;
      this.pairingNotice = null;
    }
    this.gatewayPairingAuthSignature = pairingAuthSignature;
    this.syncPairingPolling(snapshot);
    if (snapshot.phase === "connected" && snapshot.client) {
      if (!change.initial) {
        this.ensureInitialData();
      }
      if (
        !change.initial &&
        (change.identityChanged || change.connectionChanged || pairingAuthChanged) &&
        pairingAccess
      ) {
        void this.context.channels.refreshPairing();
      }
    } else {
      this.schemaLoadStarted = false;
    }
  }

  private syncPairingPolling(snapshot: ApplicationContext["gateway"]["snapshot"]) {
    if (
      snapshot.phase === "connected" &&
      snapshot.client &&
      hasOperatorPairingAccess(snapshot.hello?.auth ?? null)
    ) {
      this.pairingPolling.start();
      return;
    }
    this.pairingPolling.stop();
  }

  private ensureInitialData() {
    const context = this.context;
    const gateway = context.gateway.snapshot;
    const client = gateway.client;
    if (gateway.phase !== "connected" || !client) {
      return;
    }

    const channels = context.channels.state;
    const config = context.runtimeConfig.state;
    if (!channels.channelsSnapshot && !channels.channelsLoading) {
      void context.channels.refresh(false);
    }
    if (
      hasOperatorPairingAccess(gateway.hello?.auth ?? null) &&
      !channels.pairingSnapshot &&
      !channels.pairingLoading
    ) {
      void context.channels.refreshPairing();
    }
    if (!config.configSnapshot && !config.configLoading) {
      void context.runtimeConfig.ensureLoaded();
    }
    if (!config.configSchema && !config.configSchemaLoading && !this.schemaLoadStarted) {
      this.schemaLoadStarted = true;
      void context.runtimeConfig.ensureSchemaLoaded();
    }
  }

  override disconnectedCallback() {
    this.wizardHost.cancelOnDisconnect();
    this.selectedChannel = null;
    this.channelsSource = undefined;
    this.gatewayPairingAuthSignature = null;
    this.pairingPrompt = null;
    this.pairingChannelFilter = null;
    this.pairingAccountFilter = null;
    this.pairingNotice = null;
    this.pairingPolling.stop();
    this.invalidateNostrForm();
    this.subscriptions.clear();
    this.schemaLoadStarted = false;
    super.disconnectedCallback();
  }

  private setShowAdvancedSettings(enabled: boolean) {
    patchSettings({ showAdvancedSettings: enabled });
    // Republish so the config pages and this page read the same pref without a
    // reload; patchSettings alone only writes storage and the server pref.
    this.context.theme.refresh();
  }

  private async saveChannelConfig() {
    const context = this.context;
    if (!context) {
      return;
    }
    const saved = await context.runtimeConfig.save();
    const saveError = context.runtimeConfig.state.lastError;
    if (!saved) {
      await context.runtimeConfig.refresh();
      if (saveError && !context.runtimeConfig.state.lastError) {
        context.runtimeConfig.state.lastError = saveError;
      }
      this.requestUpdate();
      return;
    }
    await context.channels.refresh(true);
  }

  private async reloadChannelConfig() {
    const context = this.context;
    if (!context) {
      return;
    }
    await context.runtimeConfig.refresh({ discardPendingChanges: true });
    await context.channels.refresh(true);
  }

  private async confirmWhatsAppLogout() {
    const context = this.context;
    const channels = context.channels;
    const scope = this.gateway.capture();
    if (!scope || this.channelsSource !== channels) {
      return;
    }
    await runWhatsAppLogoutConfirmation({
      channels,
      getWizardAccountId: () => this.wizardHost.whatsappAccountId,
      isCurrent: () =>
        this.gateway.isCurrent(scope) &&
        this.context === context &&
        this.channelsSource === channels,
    });
  }

  private resolveNostrAccountId(): string {
    const accounts = this.context?.channels.state.channelsSnapshot?.channelAccounts?.nostr ?? [];
    return this.nostrProfileAccountId ?? accounts[0]?.accountId ?? "default";
  }

  private buildGatewayHttpHeaders(gateway: ApplicationContext["gateway"]): Record<string, string> {
    const authorization = resolveControlUiAuthHeader({
      hello: gateway.snapshot.hello,
      settings: { token: gateway.connection.token },
      password: gateway.connection.password,
    });
    return authorization ? { Authorization: authorization } : {};
  }

  private clearNostrForm() {
    this.nostrProfileFormState = null;
    this.nostrProfileAccountId = null;
  }

  private invalidateNostrForm() {
    this.gateway.invalidate();
    this.clearNostrForm();
  }

  private beginNostrOperation(): NostrOperation | null {
    const gateway = this.gateway.gateway;
    const channels = this.context.channels;
    let scope = this.gateway.capture();
    if (
      !gateway ||
      !scope ||
      this.channelsSource !== channels ||
      this.context.gateway !== gateway
    ) {
      return null;
    }
    this.gateway.invalidate();
    scope = this.gateway.capture();
    if (!scope) {
      return null;
    }
    return {
      scope,
      gateway,
      channels,
      formAccountId: this.nostrProfileAccountId,
      accountId: this.resolveNostrAccountId(),
      headers: this.buildGatewayHttpHeaders(gateway),
    };
  }

  private currentNostrForm(operation: NostrOperation): NonNullable<NostrProfileFormState> | null {
    const form = this.nostrProfileFormState;
    if (
      !form ||
      !this.gateway.isCurrent(operation.scope) ||
      this.nostrProfileAccountId !== operation.formAccountId ||
      this.context.gateway !== operation.gateway ||
      this.context.channels !== operation.channels ||
      operation.gateway.snapshot.client !== operation.scope.client
    ) {
      return null;
    }
    return form;
  }

  private editNostrProfile(accountId: string, profile: NostrProfile | null) {
    this.gateway.invalidate();
    this.nostrProfileAccountId = accountId;
    this.nostrProfileFormState = createNostrProfileFormState(profile ?? undefined);
  }

  private cancelNostrProfile() {
    this.invalidateNostrForm();
  }

  private changeNostrProfileField(field: keyof NostrProfile, value: string) {
    const form = this.nostrProfileFormState;
    if (!form) {
      return;
    }
    this.nostrProfileFormState = {
      ...form,
      values: { ...form.values, [field]: value },
      fieldErrors: { ...form.fieldErrors, [field]: "" },
    };
  }

  private toggleNostrProfileAdvanced() {
    const form = this.nostrProfileFormState;
    if (!form) {
      return;
    }
    this.nostrProfileFormState = { ...form, showAdvanced: !form.showAdvanced };
  }

  private async saveNostrProfile() {
    const form = this.nostrProfileFormState;
    if (!form || form.saving || form.importing) {
      return;
    }
    const operation = this.beginNostrOperation();
    if (!operation) {
      return;
    }
    const pendingForm = {
      ...form,
      saving: true,
      error: null,
      success: null,
      fieldErrors: {},
    };
    this.nostrProfileFormState = pendingForm;

    try {
      const { data, response } = await putNostrProfile({
        accountId: operation.accountId,
        headers: operation.headers,
        values: form.values,
      });
      const currentForm = this.currentNostrForm(operation);
      if (!currentForm) {
        return;
      }
      if (!response.ok || data?.ok === false || !data) {
        this.nostrProfileFormState = {
          ...currentForm,
          saving: false,
          error: formatUiExternalText(
            data?.error,
            t("channels.nostr.notices.updateFailedStatus", {
              status: String(response.status),
            }),
          ),
          success: null,
          fieldErrors: parseValidationErrors(data?.details),
        };
        return;
      }

      if (!data.persisted) {
        this.nostrProfileFormState = {
          ...currentForm,
          saving: false,
          error: t("channels.nostr.notices.publishFailed"),
          success: null,
        };
        return;
      }

      this.nostrProfileFormState = {
        ...currentForm,
        saving: false,
        error: null,
        success: t("channels.nostr.notices.published"),
        fieldErrors: {},
        original: { ...form.values },
      };
      await operation.channels.refresh(true);
    } catch (err) {
      const currentForm = this.currentNostrForm(operation);
      if (!currentForm) {
        return;
      }
      this.nostrProfileFormState = {
        ...currentForm,
        saving: false,
        error: formatNostrProfileOperationError(err, t("channels.nostr.notices.updateFailed")),
        success: null,
      };
    }
  }

  private async importNostrProfile() {
    const form = this.nostrProfileFormState;
    if (!form || form.importing || form.saving) {
      return;
    }
    const operation = this.beginNostrOperation();
    if (!operation) {
      return;
    }
    this.nostrProfileFormState = {
      ...form,
      importing: true,
      error: null,
      success: null,
    };

    try {
      const { data, response } = await importNostrProfile({
        accountId: operation.accountId,
        headers: operation.headers,
      });
      const currentForm = this.currentNostrForm(operation);
      if (!currentForm) {
        return;
      }
      if (!response.ok || data?.ok === false || !data) {
        this.nostrProfileFormState = {
          ...currentForm,
          importing: false,
          error: formatUiExternalText(
            data?.error,
            t("channels.nostr.notices.importFailedStatus", {
              status: String(response.status),
            }),
          ),
          success: null,
        };
        return;
      }

      const merged = data.merged ?? data.imported ?? null;
      const values = merged ? { ...currentForm.values, ...merged } : currentForm.values;
      this.nostrProfileFormState = {
        ...currentForm,
        importing: false,
        values,
        error: null,
        success: data.saved
          ? t("channels.nostr.notices.importedFromRelays")
          : t("channels.nostr.notices.imported"),
        showAdvanced: Boolean(values.banner || values.website || values.nip05 || values.lud16),
      };

      if (data.saved) {
        await operation.channels.refresh(true);
      }
    } catch (err) {
      const currentForm = this.currentNostrForm(operation);
      if (!currentForm) {
        return;
      }
      this.nostrProfileFormState = {
        ...currentForm,
        importing: false,
        error: formatNostrProfileOperationError(err, t("channels.nostr.notices.importFailed")),
        success: null,
      };
    }
  }

  private reconcilePairingFilter(snapshot: ChannelsPairingListResult | null) {
    if (!snapshot || !this.pairingChannelFilter) {
      return;
    }
    const channelAccounts = snapshot.accounts.filter(
      (account) => account.channel === this.pairingChannelFilter,
    );
    if (channelAccounts.length === 0) {
      this.pairingChannelFilter = null;
      this.pairingAccountFilter = null;
      return;
    }
    if (
      this.pairingAccountFilter &&
      !channelAccounts.some((account) => account.accountId === this.pairingAccountFilter)
    ) {
      this.pairingAccountFilter = null;
    }
  }

  private setPairingFilter(channel: string | null, accountId: string | null) {
    this.pairingChannelFilter = channel;
    this.pairingAccountFilter = channel ? accountId : null;
  }

  private reviewPairingAccount(channel: string, accountId: string) {
    this.selectedChannel = null;
    this.setPairingFilter(channel, accountId);
    void this.updateComplete.then(() => {
      this.renderRoot.querySelector("#channels-pairing-requests")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }

  private openPairingPrompt(kind: ChannelPairingPrompt["kind"], request: ChannelsPairingRequest) {
    if (this.context.channels.state.pairingBusyRequestId) {
      return;
    }
    this.pairingNotice = null;
    this.pairingPrompt = {
      kind,
      request,
      notify: false,
      bootstrapCommandOwner: false,
    };
  }

  private patchPairingPrompt(
    patch: Partial<Pick<ChannelPairingPrompt, "notify" | "bootstrapCommandOwner">>,
  ) {
    if (!this.pairingPrompt) {
      return;
    }
    this.pairingPrompt = { ...this.pairingPrompt, ...patch };
  }

  private async confirmPairingPrompt() {
    const prompt = this.pairingPrompt;
    if (!prompt) {
      return;
    }
    if (prompt.kind === "dismiss") {
      const dismissed = await this.context.channels.dismissPairing({
        channel: prompt.request.channel,
        accountId: prompt.request.accountId,
        requestId: prompt.request.requestId,
      });
      if (dismissed && this.pairingPrompt === prompt) {
        this.pairingPrompt = null;
        this.pairingNotice = t("channels.pairing.dismissedNotice");
      }
      return;
    }

    const result = await this.context.channels.approvePairing({
      channel: prompt.request.channel,
      accountId: prompt.request.accountId,
      requestId: prompt.request.requestId,
      notify: prompt.notify,
      bootstrapCommandOwner: prompt.bootstrapCommandOwner,
    });
    if (!result || this.pairingPrompt !== prompt) {
      return;
    }
    this.pairingPrompt = null;
    if (result.notification === "failed" && result.commandOwnerBootstrap === "unavailable") {
      this.pairingNotice = t("channels.pairing.approvedFollowupsFailedNotice");
    } else if (result.commandOwnerBootstrap === "unavailable") {
      this.pairingNotice = t("channels.pairing.approvedOwnerFailedNotice");
    } else if (result.notification === "failed") {
      this.pairingNotice = t("channels.pairing.approvedNotificationFailedNotice");
    } else if (result.commandOwnerBootstrap === "configured") {
      this.pairingNotice = t("channels.pairing.approvedOwnerNotice");
    } else {
      this.pairingNotice = t("channels.pairing.approvedNotice");
    }
  }

  override render() {
    const context = this.context;
    const channels = context.channels.state;
    const config = context.runtimeConfig.state;
    const auth = context.gateway.snapshot.hello?.auth ?? null;
    const canManagePairing = hasOperatorPairingAccess(auth);
    const canAdmin = hasOperatorAdminAccess(auth);
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("channels")}</div>
          <div class="page-subtitle">
            ${subtitleForRoute("channels")}
            ${renderDocsLink(CHANNELS_DOCS_URL, t("common.learnMore"))}
          </div>
        </div>
      </section>
      ${renderSettingsWorkspace(
        renderChannels({
          connected: channels.connected,
          loading: channels.channelsLoading,
          snapshot: channels.channelsSnapshot,
          lastError: channels.channelsError,
          lastSuccessAt: channels.channelsLastSuccess,
          pairingLoading: channels.pairingLoading,
          pairingSnapshot: channels.pairingSnapshot,
          pairingError: channels.pairingError,
          pairingLastSuccessAt: channels.pairingLastSuccess,
          pairingBusyRequestId: channels.pairingBusyRequestId,
          pairingChannelFilter: this.pairingChannelFilter,
          pairingAccountFilter: this.pairingAccountFilter,
          pairingPrompt: this.pairingPrompt,
          pairingNotice: this.pairingNotice,
          canManagePairing,
          canAdmin,
          whatsappMessage: channels.whatsappLoginMessage,
          whatsappQrDataUrl: channels.whatsappLoginQrDataUrl,
          whatsappConnected: channels.whatsappLoginConnected,
          whatsappBusy: channels.whatsappBusy,
          configSchema: config.configSchema,
          configSchemaLoading: config.configSchemaLoading,
          configForm: config.configForm,
          configUiHints: config.configUiHints,
          configSaving: config.configSaving,
          configFormDirty: config.configFormDirty,
          showAdvancedSettings: this.showAdvancedSettings,
          nostrProfileFormState: this.nostrProfileFormState,
          nostrProfileAccountId: this.nostrProfileAccountId,
          selectedChannel: this.selectedChannel,
          wizard: this.wizardHost.state,
          wizardMultiselect: this.wizardHost.multiselect,
          wizardTextValue: this.wizardHost.textValue,
          wizardSecretVisible: this.wizardHost.secretVisible,
          setupBlockedByDirtyConfig: this.wizardHost.blockedByDirtyConfig,
          onShowDetail: (channelId) => {
            this.selectedChannel = channelId;
          },
          onCloseDetail: () => {
            this.selectedChannel = null;
          },
          onStartSetup: (channelId) => this.wizardHost.startSetup(channelId),
          onWizardAnswer: (value) => this.wizardHost.answer(value),
          onWizardToggleMultiselect: (value) => this.wizardHost.toggleMultiselect(value),
          onWizardTextInput: (value) => this.wizardHost.setTextValue(value),
          onWizardToggleSecretVisibility: () => this.wizardHost.toggleSecretVisibility(),
          onWizardClose: () => this.wizardHost.close(),
          onRefresh: (probe) => void context.channels.refresh(probe),
          onPairingRefresh: () => void context.channels.refreshPairing(),
          onPairingFilterChange: (channel, accountId) => this.setPairingFilter(channel, accountId),
          onPairingReviewAccount: (channel, accountId) =>
            this.reviewPairingAccount(channel, accountId),
          onPairingApprove: (request) => this.openPairingPrompt("approve", request),
          onPairingDismiss: (request) => this.openPairingPrompt("dismiss", request),
          onPairingPromptChange: (patch) => this.patchPairingPrompt(patch),
          onPairingPromptCancel: () => {
            this.pairingPrompt = null;
          },
          onPairingPromptConfirm: () => void this.confirmPairingPrompt(),
          onWhatsAppStart: (force) =>
            void context.channels.startWhatsApp(force, this.wizardHost.whatsappAccountId),
          onWhatsAppWait: () =>
            void context.channels.waitWhatsApp(this.wizardHost.whatsappAccountId),
          onWhatsAppLogout: () => void this.confirmWhatsAppLogout(),
          onShowAdvancedSettings: (enabled) => this.setShowAdvancedSettings(enabled),
          onConfigPatch: (path, value) => context.runtimeConfig.patchForm(path, value),
          onConfigSave: () => void this.saveChannelConfig(),
          onConfigReload: () => void this.reloadChannelConfig(),
          onNostrProfileEdit: (accountId, profile) => this.editNostrProfile(accountId, profile),
          onNostrProfileCancel: () => this.cancelNostrProfile(),
          onNostrProfileFieldChange: (field, value) => this.changeNostrProfileField(field, value),
          onNostrProfileSave: () => void this.saveNostrProfile(),
          onNostrProfileImport: () => void this.importNostrProfile(),
          onNostrProfileToggleAdvanced: () => this.toggleNostrProfileAdvanced(),
        }),
      )}
    `;
  }
}

if (!customElements.get("openclaw-channels-page")) {
  customElements.define("openclaw-channels-page", ChannelsPage);
}
