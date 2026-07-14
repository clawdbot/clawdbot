import { consume } from "@lit/context";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { NostrProfile } from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { resolveControlUiAuthHeader } from "../../app/control-ui-auth.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { importNostrProfile, parseValidationErrors, putNostrProfile } from "./nostr-profile-ops.ts";
import { createNostrProfileFormState } from "./view.nostr-profile-form.ts";
import { renderChannels } from "./view.ts";
import { ChannelWizardHost } from "./wizard-host.ts";

type NostrProfileFormState = ReturnType<typeof createNostrProfileFormState> | null;

type NostrOperation = {
  generation: number;
  gateway: ApplicationContext["gateway"];
  channels: ApplicationContext["channels"];
  client: GatewayBrowserClient;
  formAccountId: string | null;
  accountId: string;
  headers: Record<string, string>;
};

class ChannelsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state()
  private nostrProfileFormState: NostrProfileFormState = null;

  @state()
  private nostrProfileAccountId: string | null = null;

  @state()
  private selectedChannel: string | null = null;

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
  private hasGatewaySnapshot = false;
  private nostrOperationGeneration = 0;

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
      this.hasGatewaySnapshot && this.gatewayConnected !== snapshot.connected;
    if (!this.hasGatewaySnapshot || sourceChanged || clientChanged || connectionChanged) {
      this.nostrOperationGeneration += 1;
    }
    if (sourceChanged || clientChanged || !snapshot.connected) {
      this.clearNostrForm();
    }
    this.hasGatewaySnapshot = true;
    this.gatewayClient = snapshot.client;
    this.gatewayConnected = snapshot.connected;
    if (snapshot.connected && snapshot.client) {
      this.ensureInitialData();
    } else {
      this.schemaLoadStarted = false;
    }
  }

  private ensureInitialData() {
    const context = this.context;
    const gateway = context.gateway.snapshot;
    const client = gateway.client;
    if (!gateway.connected || !client) {
      return;
    }

    const channels = context.channels.state;
    const config = context.runtimeConfig.state;
    if (!channels.channelsSnapshot && !channels.channelsLoading) {
      void context.channels.refresh(false);
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
    this.hasGatewaySnapshot = false;
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
      !gateway.snapshot.connected ||
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
      !operation.gateway.snapshot.connected
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
        error: `Profile update failed: ${String(err)}`,
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
        error: `Profile import failed: ${String(err)}`,
        success: null,
      };
    }
  }

  override render() {
    const context = this.context;
    const channels = context.channels.state;
    const config = context.runtimeConfig.state;
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
          onWhatsAppStart: (force) =>
            void context.channels.startWhatsApp(force, this.wizardHost.whatsappAccountId),
          onWhatsAppWait: () =>
            void context.channels.waitWhatsApp(this.wizardHost.whatsappAccountId),
          onWhatsAppLogout: () => void context.channels.logoutWhatsApp(),
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
