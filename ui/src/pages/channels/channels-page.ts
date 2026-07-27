import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ChannelsPairingListResult,
  ChannelsPairingRequest,
  NostrProfile,
} from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { resolveControlUiAuthHeader } from "../../app/control-ui-auth.ts";
import { hasOperatorAdminAccess, hasOperatorPairingAccess } from "../../app/operator-access.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { resolveChannelPairingAuthSignature } from "../../lib/channels/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { importNostrProfile, parseValidationErrors, putNostrProfile } from "./nostr-profile-ops.ts";
import { createNostrProfileFormState } from "./view.nostr-profile-form.ts";
import { renderChannels } from "./view.ts";
import type { ChannelPairingPrompt } from "./view.types.ts";
import { ChannelWizardHost } from "./wizard-host.ts";

type NostrProfileFormState = ReturnType<typeof createNostrProfileFormState> | null;

const CHANNEL_PAIRING_POLL_INTERVAL_MS = 30_000;

const NOSTR_PROFILE_TIMEOUT_ERROR =
  "Request timed out after 30 seconds; the server may still have applied the change — check the profile before retrying.";

type NostrOperation = {
  generation: number;
  gateway: ApplicationContext["gateway"];
  channels: ApplicationContext["channels"];
  client: GatewayBrowserClient;
  formAccountId: string | null;
  accountId: string;
  headers: Record<string, string>;
};

function formatNostrProfileOperationError(error: unknown, prefix: string): string {
  return error instanceof DOMException && error.name === "TimeoutError"
    ? NOSTR_PROFILE_TIMEOUT_ERROR
    : `${prefix}: ${String(error)}`;
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

  private readonly wizardHost = new ChannelWizardHost({
    getContext: () => this.context,
    requestUpdate: () => this.requestUpdate(),
    clearSelection: () => {
      this.selectedChannel = null;
    },
  });

  private schemaLoadStarted = false;
  private gatewaySource?: ApplicationContext["gateway"];
  private channelsSource?: ApplicationContext["channels"];
  private gatewayClient: GatewayBrowserClient | null = null;
  private gatewayConnected = false;
  private gatewayPairingAuthSignature: string | null = null;
  private hasGatewaySnapshot = false;
  private nostrOperationGeneration = 0;
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
    .effect(
      () => this.context?.gateway,
      (gateway) => {
        const sourceChanged = this.gatewaySource !== undefined && this.gatewaySource !== gateway;
        this.gatewaySource = gateway;
        this.applyGatewaySnapshot(gateway.snapshot, sourceChanged);
        return gateway.subscribe((snapshot) => {
          if (this.gatewaySource !== gateway) {
            return;
          }
          this.applyGatewaySnapshot(snapshot, false);
        });
      },
    );

  private applyGatewaySnapshot(
    snapshot: ApplicationContext["gateway"]["snapshot"],
    sourceChanged: boolean,
  ) {
    const clientChanged = this.hasGatewaySnapshot && this.gatewayClient !== snapshot.client;
    const connectionChanged =
      this.hasGatewaySnapshot && this.gatewayConnected !== (snapshot.phase === "connected");
    const pairingAccess = hasOperatorPairingAccess(snapshot.hello?.auth ?? null);
    const pairingAuthSignature = resolveChannelPairingAuthSignature(snapshot);
    const pairingAuthChanged =
      this.hasGatewaySnapshot && this.gatewayPairingAuthSignature !== pairingAuthSignature;
    if (!this.hasGatewaySnapshot || sourceChanged || clientChanged || connectionChanged) {
      this.nostrOperationGeneration += 1;
    }
    if (sourceChanged || clientChanged || snapshot.phase !== "connected") {
      this.clearNostrForm();
    }
    if (
      sourceChanged ||
      clientChanged ||
      pairingAuthChanged ||
      snapshot.phase !== "connected" ||
      !pairingAccess
    ) {
      this.pairingPrompt = null;
      this.pairingChannelFilter = null;
      this.pairingAccountFilter = null;
      this.pairingNotice = null;
    }
    this.hasGatewaySnapshot = true;
    this.gatewayClient = snapshot.client;
    this.gatewayConnected = snapshot.phase === "connected";
    this.gatewayPairingAuthSignature = pairingAuthSignature;
    this.syncPairingPolling(snapshot);
    if (snapshot.phase === "connected" && snapshot.client) {
      this.ensureInitialData();
      if (
        (sourceChanged || clientChanged || connectionChanged || pairingAuthChanged) &&
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
    this.gatewaySource = undefined;
    this.channelsSource = undefined;
    this.gatewayClient = null;
    this.gatewayConnected = false;
    this.gatewayPairingAuthSignature = null;
    this.hasGatewaySnapshot = false;
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
    this.nostrOperationGeneration += 1;
    this.clearNostrForm();
  }

  private beginNostrOperation(): NostrOperation | null {
    const gateway = this.context.gateway;
    const channels = this.context.channels;
    const client = gateway.snapshot.client;
    if (
      !this.isConnected ||
      this.gatewaySource !== gateway ||
      this.channelsSource !== channels ||
      gateway.snapshot.phase !== "connected" ||
      !client
    ) {
      return null;
    }
    const generation = this.nostrOperationGeneration + 1;
    this.nostrOperationGeneration = generation;
    return {
      generation,
      gateway,
      channels,
      client,
      formAccountId: this.nostrProfileAccountId,
      accountId: this.resolveNostrAccountId(),
      headers: this.buildGatewayHttpHeaders(gateway),
    };
  }

  private currentNostrForm(operation: NostrOperation): NonNullable<NostrProfileFormState> | null {
    const form = this.nostrProfileFormState;
    if (
      !form ||
      !this.isConnected ||
      this.nostrOperationGeneration !== operation.generation ||
      this.nostrProfileAccountId !== operation.formAccountId ||
      this.context.gateway !== operation.gateway ||
      this.context.channels !== operation.channels ||
      operation.gateway.snapshot.client !== operation.client ||
      operation.gateway.snapshot.phase !== "connected"
    ) {
      return null;
    }
    return form;
  }

  private editNostrProfile(accountId: string, profile: NostrProfile | null) {
    this.nostrOperationGeneration += 1;
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
          error: data?.error ?? `Profile update failed (${response.status})`,
          success: null,
          fieldErrors: parseValidationErrors(data?.details),
        };
        return;
      }

      if (!data.persisted) {
        this.nostrProfileFormState = {
          ...currentForm,
          saving: false,
          error: "Profile publish failed on all relays.",
          success: null,
        };
        return;
      }

      this.nostrProfileFormState = {
        ...currentForm,
        saving: false,
        error: null,
        success: "Profile published to relays.",
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
        error: formatNostrProfileOperationError(err, "Profile update failed"),
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
          error: data?.error ?? `Profile import failed (${response.status})`,
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
          ? "Profile imported from relays. Review and publish."
          : "Profile imported. Review and publish.",
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
        error: formatNostrProfileOperationError(err, "Profile import failed"),
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
          nostrProfileFormState: this.nostrProfileFormState,
          nostrProfileAccountId: this.nostrProfileAccountId,
          selectedChannel: this.selectedChannel,
          wizard: this.wizardHost.state,
          wizardMultiselect: this.wizardHost.multiselect,
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
          onWhatsAppLogout: () =>
            void context.channels.logoutWhatsApp(this.wizardHost.whatsappAccountId),
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
