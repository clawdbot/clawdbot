import { consume } from "@lit/context";
import { html, LitElement } from "lit";
import { state } from "lit/decorators.js";
import type { NostrProfile } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { resolveControlUiAuthHeader } from "../../app/control-ui-auth.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { createNostrProfileFormState } from "./view.nostr-profile-form.ts";
import { renderChannels } from "./view.ts";

type NostrProfileFormState = ReturnType<typeof createNostrProfileFormState> | null;

function parseValidationErrors(details: unknown): Record<string, string> {
  if (!Array.isArray(details)) {
    return {};
  }
  const errors: Record<string, string> = {};
  for (const entry of details) {
    if (typeof entry !== "string") {
      continue;
    }
    const [rawField, ...rest] = entry.split(":");
    if (!rawField || rest.length === 0) {
      continue;
    }
    const field = rawField.trim();
    const message = rest.join(":").trim();
    if (field && message) {
      errors[field] = message;
    }
  }
  return errors;
}

function buildNostrProfileUrl(accountId: string, suffix = ""): string {
  return `/api/channels/nostr/${encodeURIComponent(accountId)}/profile${suffix}`;
}

class ChannelsPage extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @consume({ context: applicationContext, subscribe: false })
  private context!: ApplicationContext;

  @state()
  private nostrProfileFormState: NostrProfileFormState = null;

  @state()
  private nostrProfileAccountId: string | null = null;

  private stopChannelsSubscription?: () => void;
  private stopConfigSubscription?: () => void;
  private stopGatewaySubscription?: () => void;
  private schemaLoadStarted = false;

  private readonly requestPageUpdate = () => this.requestUpdate();

  override connectedCallback() {
    super.connectedCallback();
    this.ensureSubscriptions();
    this.ensureInitialData();
  }

  private ensureSubscriptions() {
    const context = this.context;
    if (!context || this.stopChannelsSubscription) {
      return;
    }
    this.stopChannelsSubscription = context.channels.subscribe(this.requestPageUpdate);
    this.stopConfigSubscription = context.runtimeConfig.subscribe(() => {
      this.requestPageUpdate();
      this.ensureInitialData();
    });
    this.stopGatewaySubscription = context.gateway.subscribe((snapshot) => {
      if (snapshot.connected && snapshot.client) {
        this.ensureInitialData();
      } else {
        this.schemaLoadStarted = false;
      }
    });
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
    this.stopChannelsSubscription?.();
    this.stopChannelsSubscription = undefined;
    this.stopConfigSubscription?.();
    this.stopConfigSubscription = undefined;
    this.stopGatewaySubscription?.();
    this.stopGatewaySubscription = undefined;
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
    return accounts[0]?.accountId ?? this.nostrProfileAccountId ?? "default";
  }

  private buildGatewayHttpHeaders(): Record<string, string> {
    const context = this.context;
    if (!context) {
      return {};
    }
    const authorization = resolveControlUiAuthHeader({
      hello: context.gateway.snapshot.hello,
      settings: { token: context.gateway.connection.token },
      password: context.gateway.connection.password,
    });
    return authorization ? { Authorization: authorization } : {};
  }

  private editNostrProfile(accountId: string, profile: NostrProfile | null) {
    this.nostrProfileAccountId = accountId;
    this.nostrProfileFormState = createNostrProfileFormState(profile ?? undefined);
  }

  private cancelNostrProfile() {
    this.nostrProfileFormState = null;
    this.nostrProfileAccountId = null;
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
    if (!form || form.saving) {
      return;
    }
    const accountId = this.resolveNostrAccountId();
    this.nostrProfileFormState = {
      ...form,
      saving: true,
      error: null,
      success: null,
      fieldErrors: {},
    };

    try {
      const response = await fetch(buildNostrProfileUrl(accountId), {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...this.buildGatewayHttpHeaders(),
        },
        body: JSON.stringify(form.values),
      });
      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        details?: unknown;
        persisted?: boolean;
      } | null;

      if (!response.ok || data?.ok === false || !data) {
        this.nostrProfileFormState = {
          ...form,
          saving: false,
          error: data?.error ?? `Profile update failed (${response.status})`,
          success: null,
          fieldErrors: parseValidationErrors(data?.details),
        };
        return;
      }

      if (!data.persisted) {
        this.nostrProfileFormState = {
          ...form,
          saving: false,
          error: "Profile publish failed on all relays.",
          success: null,
        };
        return;
      }

      this.nostrProfileFormState = {
        ...form,
        saving: false,
        error: null,
        success: "Profile published to relays.",
        fieldErrors: {},
        original: { ...form.values },
      };
      await this.context?.channels.refresh(true);
    } catch (err) {
      this.nostrProfileFormState = {
        ...form,
        saving: false,
        error: `Profile update failed: ${String(err)}`,
        success: null,
      };
    }
  }

  private async importNostrProfile() {
    const form = this.nostrProfileFormState;
    if (!form || form.importing) {
      return;
    }
    const accountId = this.resolveNostrAccountId();
    this.nostrProfileFormState = {
      ...form,
      importing: true,
      error: null,
      success: null,
    };

    try {
      const response = await fetch(buildNostrProfileUrl(accountId, "/import"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.buildGatewayHttpHeaders(),
        },
        body: JSON.stringify({ autoMerge: true }),
      });
      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        imported?: NostrProfile;
        merged?: NostrProfile;
        saved?: boolean;
      } | null;

      if (!response.ok || data?.ok === false || !data) {
        this.nostrProfileFormState = {
          ...form,
          importing: false,
          error: data?.error ?? `Profile import failed (${response.status})`,
          success: null,
        };
        return;
      }

      const merged = data.merged ?? data.imported ?? null;
      const values = merged ? { ...form.values, ...merged } : form.values;
      this.nostrProfileFormState = {
        ...form,
        importing: false,
        values,
        error: null,
        success: data.saved
          ? "Profile imported from relays. Review and publish."
          : "Profile imported. Review and publish.",
        showAdvanced: Boolean(values.banner || values.website || values.nip05 || values.lud16),
      };

      if (data.saved) {
        await this.context?.channels.refresh(true);
      }
    } catch (err) {
      this.nostrProfileFormState = {
        ...form,
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
          <div class="page-sub">${subtitleForRoute("channels")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(
        context.basePath,
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
          onRefresh: (probe) => void context.channels.refresh(probe),
          onWhatsAppStart: (force) => void context.channels.startWhatsApp(force),
          onWhatsAppWait: () => void context.channels.waitWhatsApp(),
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
        "channels",
        (routeId) => context.navigate(routeId),
        (routeId) => context.preload(routeId),
        { hostPolicy: context.hostPolicy },
      )}
    `;
  }
}

if (!customElements.get("openclaw-channels-page")) {
  customElements.define("openclaw-channels-page", ChannelsPage);
}
