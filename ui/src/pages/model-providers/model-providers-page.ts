import { consume } from "@lit/context";
import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelsProbeResult } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  buildModelProviderCards,
  buildSelectableDefaultModels,
  buildUnconfiguredProviderOptions,
  readModelProviderConfig,
  type DefaultModelSelection,
  type ModelProviderLogoutTarget,
} from "./data.ts";
import {
  EMPTY_MODEL_PROVIDERS_DATA,
  loadModelProvidersData,
  MODEL_PROVIDERS_COST_DAYS,
  type ModelProvidersData,
} from "./load.ts";
import {
  buildDefaultModelsPatch,
  buildProviderApiKeyPatch,
  DEFAULT_MODELS_REPLACE_PATHS,
} from "./mutations.ts";
import { renderModelProviders, type ModelProviderRowMessage } from "./view.ts";

export type ModelProvidersRouteData = {
  data: ModelProvidersData;
  /** Client the loader fetched from; null when it ran disconnected. */
  client: GatewayBrowserClient | null;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return typeof error === "string" && error.trim() ? error : t("modelProviders.requestFailed");
}

function isMissingMethodError(error: unknown): boolean {
  return /method (?:not found|not supported)|unknown method/iu.test(errorMessage(error));
}

const PROBE_FAILURE_PRIORITY: readonly ModelsProbeResult["status"][] = [
  "auth",
  "billing",
  "rate_limit",
  "timeout",
  "format",
  "no_model",
  "unknown",
];

function mergeProbeResults(cardId: string, results: ModelsProbeResult[]): ModelsProbeResult {
  if (results.length === 1) {
    return results[0]!;
  }
  const status = results.some((result) => result.status === "ok")
    ? "ok"
    : (PROBE_FAILURE_PRIORITY.find((candidate) =>
        results.some((result) => result.status === candidate),
      ) ?? "unknown");
  const error = results.find((result) => result.status === status)?.error;
  return {
    provider: cardId,
    status,
    ...(error ? { error } : {}),
    results: results.flatMap((result) =>
      result.results.map((target) => ({
        ...target,
        label: `${result.provider}: ${target.label}`,
      })),
    ),
  };
}

export class ModelProvidersPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) routeData: ModelProvidersRouteData | undefined;

  @state() private data: ModelProvidersData | null = null;
  @state() private refreshing = false;
  @state() private busy: Record<string, boolean> = {};
  @state() private messages: Record<string, ModelProviderRowMessage> = {};
  @state() private probeResults: Record<string, ModelsProbeResult> = {};
  @state() private probeUnsupported = false;
  @state() private keyEditorProvider: string | null = null;
  @state() private keyDraft = "";
  @state() private pendingLogoutProvider: string | null = null;
  @state() private addProviderOpen = false;
  @state() private addProviderId = "";
  @state() private addProviderKey = "";
  @state() private defaultsDraft: DefaultModelSelection | null = null;

  /** Client the current data was loaded from; a new client means stale data. */
  private dataClient: GatewayBrowserClient | null = null;
  private observedClient: GatewayBrowserClient | null = null;
  private clientEpoch = 0;
  private refreshEpoch = 0;
  private refreshQueue: Promise<void> = Promise.resolve();
  private probeEpochs = new Map<string, number>();
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribe(notify),
  );

  override disconnectedCallback() {
    this.refreshEpoch += 1;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues) {
    if (changed.has("routeData") && this.routeData) {
      this.data = this.routeData.data;
      this.dataClient = this.routeData.client;
    }
  }

  override updated() {
    const snapshot = this.context.gateway.snapshot;
    if (snapshot.client !== this.observedClient) {
      this.resetClientState(snapshot.client);
    }
    if (!snapshot.connected || !snapshot.client || this.refreshing) {
      return;
    }
    const stale = this.data === null || this.data.updatedAt === null;
    if (stale || snapshot.client !== this.dataClient) {
      void this.refresh({ force: false });
    }
  }

  private resetClientState(client: GatewayBrowserClient | null) {
    this.observedClient = client;
    this.clientEpoch += 1;
    this.refreshEpoch += 1;
    this.refreshing = false;
    this.busy = {};
    this.messages = {};
    this.probeResults = {};
    this.probeEpochs = new Map();
    this.probeUnsupported = false;
    this.keyEditorProvider = null;
    this.keyDraft = "";
    this.pendingLogoutProvider = null;
    this.addProviderOpen = false;
    this.addProviderId = "";
    this.addProviderKey = "";
    this.defaultsDraft = null;
    if (client !== this.dataClient) {
      this.data = null;
    }
  }

  private isCurrentClient(client: GatewayBrowserClient, epoch: number): boolean {
    return (
      this.clientEpoch === epoch &&
      this.observedClient === client &&
      this.context.gateway.snapshot.client === client
    );
  }

  private refresh(opts: { force: boolean }): Promise<void> {
    const task = this.refreshQueue.then(() => this.performRefresh(opts));
    this.refreshQueue = task.catch(() => undefined);
    return task;
  }

  private async performRefresh(opts: { force: boolean }) {
    const client = this.context.gateway.snapshot.client;
    if (!client) {
      return;
    }
    const epoch = ++this.refreshEpoch;
    this.refreshing = true;
    try {
      const data = await loadModelProvidersData(client, opts.force ? { refresh: true } : undefined);
      if (epoch === this.refreshEpoch && this.context.gateway.snapshot.client === client) {
        this.data = data;
        this.dataClient = client;
      }
    } finally {
      if (epoch === this.refreshEpoch && this.context.gateway.snapshot.client === client) {
        this.refreshing = false;
      }
    }
  }

  private mutationBlockedReason(): string | null {
    const snapshot = this.context.gateway.snapshot;
    if (!snapshot.connected) {
      return t("modelProviders.readOnly.disconnected");
    }
    if (!hasOperatorAdminAccess(snapshot.hello?.auth ?? null)) {
      return t("modelProviders.readOnly.adminRequired");
    }
    if (!snapshot.client || !this.data?.config) {
      return t("modelProviders.configUnavailable");
    }
    return null;
  }

  private canMutate(): boolean {
    return this.mutationBlockedReason() === null;
  }

  private setBusy(key: string, value: boolean) {
    const next = { ...this.busy };
    if (value) {
      next[key] = true;
    } else {
      delete next[key];
    }
    this.busy = next;
  }

  private setMessage(key: string, message: ModelProviderRowMessage | null) {
    const next = { ...this.messages };
    if (message) {
      next[key] = message;
    } else {
      delete next[key];
    }
    this.messages = next;
  }

  private clearProbe(provider: string) {
    this.probeEpochs.set(provider, (this.probeEpochs.get(provider) ?? 0) + 1);
    this.setBusy(`probe:${provider}`, false);
    const next = { ...this.probeResults };
    delete next[provider];
    this.probeResults = next;
  }

  private async patchConfig(params: {
    key: string;
    raw: Record<string, unknown>;
    note: string;
    success: string;
    replacePaths?: string[];
  }): Promise<boolean> {
    if (!this.canMutate() || this.busy[params.key]) {
      return false;
    }
    const client = this.context.gateway.snapshot.client;
    if (!client) {
      return false;
    }
    const clientEpoch = this.clientEpoch;
    const runtimeConfig = this.context.runtimeConfig;
    this.setBusy(params.key, true);
    this.setMessage(params.key, null);
    try {
      await runtimeConfig.ensureLoaded();
      if (!this.isCurrentClient(client, clientEpoch)) {
        return false;
      }
      const patched = await runtimeConfig.patch({
        raw: params.raw,
        note: params.note,
        ...(params.replacePaths ? { replacePaths: params.replacePaths } : {}),
      });
      if (!this.isCurrentClient(client, clientEpoch)) {
        return false;
      }
      if (!patched) {
        this.setMessage(params.key, {
          kind: "error",
          text: runtimeConfig.state.lastError ?? t("modelProviders.configUnavailable"),
        });
        return false;
      }
      await runtimeConfig.refresh();
      if (!this.isCurrentClient(client, clientEpoch)) {
        return false;
      }
      await this.refresh({ force: true });
      if (!this.isCurrentClient(client, clientEpoch)) {
        return false;
      }
      this.setMessage(params.key, { kind: "success", text: params.success });
      return true;
    } catch (error) {
      if (this.isCurrentClient(client, clientEpoch)) {
        this.setMessage(params.key, { kind: "error", text: errorMessage(error) });
      }
      return false;
    } finally {
      if (this.isCurrentClient(client, clientEpoch)) {
        this.setBusy(params.key, false);
      }
    }
  }

  private openKeyEditor(provider: string) {
    this.keyEditorProvider = provider;
    this.keyDraft = "";
    this.setMessage(provider, null);
  }

  private closeKeyEditor() {
    this.keyEditorProvider = null;
    this.keyDraft = "";
  }

  private async saveKey(provider: string, configKey: string) {
    const apiKey = this.keyDraft.trim();
    if (!apiKey) {
      return;
    }
    this.clearProbe(provider);
    this.setMessage(provider, null);
    this.setMessage(`key:${provider}`, null);
    const ok = await this.patchConfig({
      key: `key:${provider}`,
      raw: buildProviderApiKeyPatch(configKey, apiKey),
      note: t("modelProviders.notes.saveKey", { provider }),
      success: t("modelProviders.apiKey.saved"),
    });
    if (ok) {
      this.setMessage(`key:${provider}`, null);
      this.closeKeyEditor();
      this.setMessage(provider, { kind: "success", text: t("modelProviders.apiKey.saved") });
    }
  }

  private async removeKey(provider: string, configKey: string) {
    this.clearProbe(provider);
    this.setMessage(provider, null);
    this.setMessage(`key:${provider}`, null);
    const ok = await this.patchConfig({
      key: `key:${provider}`,
      raw: buildProviderApiKeyPatch(configKey, null),
      note: t("modelProviders.notes.removeKey", { provider }),
      success: t("modelProviders.apiKey.removed"),
    });
    if (ok) {
      this.setMessage(`key:${provider}`, null);
      this.closeKeyEditor();
      this.setMessage(provider, { kind: "success", text: t("modelProviders.apiKey.removed") });
    }
  }

  private async probe(cardId: string, providers: string[]) {
    const client = this.context.gateway.snapshot.client;
    const key = `probe:${cardId}`;
    if (!client || !this.canMutate() || this.busy[key] || this.probeUnsupported) {
      return;
    }
    const clientEpoch = this.clientEpoch;
    const probeEpoch = (this.probeEpochs.get(cardId) ?? 0) + 1;
    this.probeEpochs.set(cardId, probeEpoch);
    this.setBusy(key, true);
    this.setMessage(cardId, null);
    try {
      const results: ModelsProbeResult[] = [];
      for (const provider of providers) {
        results.push(await client.request<ModelsProbeResult>("models.probe", { provider }));
      }
      if (
        this.isCurrentClient(client, clientEpoch) &&
        this.probeEpochs.get(cardId) === probeEpoch
      ) {
        this.probeResults = {
          ...this.probeResults,
          [cardId]: mergeProbeResults(cardId, results),
        };
      }
    } catch (error) {
      if (
        !this.isCurrentClient(client, clientEpoch) ||
        this.probeEpochs.get(cardId) !== probeEpoch
      ) {
        return;
      }
      if (isMissingMethodError(error)) {
        this.probeUnsupported = true;
        this.setMessage(cardId, {
          kind: "error",
          text: t("modelProviders.probe.unavailable"),
        });
      } else {
        this.setMessage(cardId, { kind: "error", text: errorMessage(error) });
      }
    } finally {
      if (
        this.isCurrentClient(client, clientEpoch) &&
        this.probeEpochs.get(cardId) === probeEpoch
      ) {
        this.setBusy(key, false);
      }
    }
  }

  private async logout(cardId: string, targets: ModelProviderLogoutTarget[]) {
    const client = this.context.gateway.snapshot.client;
    const key = `logout:${cardId}`;
    if (!client || !this.canMutate() || this.busy[key]) {
      return;
    }
    const clientEpoch = this.clientEpoch;
    this.clearProbe(cardId);
    this.setBusy(key, true);
    this.setMessage(cardId, null);
    try {
      let firstError: unknown;
      for (const target of targets) {
        try {
          await client.request("models.authLogout", target);
        } catch (error) {
          firstError ??= error;
        }
      }
      if (!this.isCurrentClient(client, clientEpoch)) {
        return;
      }
      await this.refresh({ force: true });
      if (!this.isCurrentClient(client, clientEpoch)) {
        return;
      }
      if (firstError) {
        this.setMessage(cardId, { kind: "error", text: errorMessage(firstError) });
        return;
      }
      this.pendingLogoutProvider = null;
      this.setMessage(cardId, { kind: "success", text: t("modelProviders.logout.done") });
    } catch (error) {
      if (this.isCurrentClient(client, clientEpoch)) {
        this.setMessage(cardId, { kind: "error", text: errorMessage(error) });
      }
    } finally {
      if (this.isCurrentClient(client, clientEpoch)) {
        this.setBusy(key, false);
      }
    }
  }

  private async addProvider() {
    const provider = this.addProviderId;
    const apiKey = this.addProviderKey.trim();
    if (!provider || !apiKey) {
      return;
    }
    const ok = await this.patchConfig({
      key: "add",
      raw: buildProviderApiKeyPatch(provider, apiKey),
      note: t("modelProviders.notes.addProvider", { provider }),
      success: t("modelProviders.add.saved", { provider }),
    });
    if (ok) {
      this.addProviderOpen = false;
      this.addProviderId = "";
      this.addProviderKey = "";
      this.setMessage(provider, {
        kind: "success",
        text: t("modelProviders.add.saved", { provider }),
      });
    }
  }

  private async saveDefaultModels() {
    const selection = this.defaultsDraft;
    if (!selection?.primary) {
      return;
    }
    const ok = await this.patchConfig({
      key: "defaults",
      raw: buildDefaultModelsPatch(selection.primary, selection.fallbacks, selection.utilityModel),
      note: t("modelProviders.notes.defaultModel"),
      success: t("modelProviders.defaults.saved"),
      replacePaths: DEFAULT_MODELS_REPLACE_PATHS,
    });
    if (ok) {
      this.defaultsDraft = null;
    }
  }

  override render() {
    const gatewaySnapshot = this.context.gateway.snapshot;
    const data = this.data ?? EMPTY_MODEL_PROVIDERS_DATA;
    const config = readModelProviderConfig(data.config);
    const defaults = this.defaultsDraft ?? config.defaults;
    const cards = buildModelProviderCards({
      ...data,
      configProviderIds: config.providerIds,
      configApiKeyProviderIds: config.apiKeyProviderIds,
      configProviderAuthModes: config.providerAuthModes,
    });
    const configuredProviderIds = new Set([
      ...config.providerIds,
      ...(data.authStatus?.providers
        .filter((provider) => Boolean(provider.apiKey) || provider.profiles.length > 0)
        .map((provider) => provider.provider) ?? []),
    ]);
    const advertised = isGatewayMethodAdvertised(gatewaySnapshot, "models.probe");
    const blockedReason = this.mutationBlockedReason();
    const body = renderModelProviders({
      connected: gatewaySnapshot.connected,
      loading: gatewaySnapshot.connected && this.data === null,
      refreshing: this.refreshing,
      error: data.error,
      updatedAt: data.updatedAt,
      costDays: MODEL_PROVIDERS_COST_DAYS,
      cards,
      configuredModels: buildSelectableDefaultModels(data.models, defaults),
      defaultModels: defaults,
      defaultModelsDirty: this.defaultsDraft !== null,
      unconfiguredProviders: buildUnconfiguredProviderOptions(
        data.catalogModels,
        configuredProviderIds,
      ),
      canMutate: this.canMutate(),
      mutationBlockedReason: blockedReason,
      probeAvailable: !this.probeUnsupported && advertised !== false,
      busy: this.busy,
      messages: this.messages,
      probeResults: this.probeResults,
      keyEditorProvider: this.keyEditorProvider,
      keyDraft: this.keyDraft,
      pendingLogoutProvider: this.pendingLogoutProvider,
      addProviderOpen: this.addProviderOpen,
      addProviderId: this.addProviderId,
      addProviderKey: this.addProviderKey,
      onRefresh: () => void this.refresh({ force: true }),
      onOpenKeyEditor: (provider) => this.openKeyEditor(provider),
      onCloseKeyEditor: () => this.closeKeyEditor(),
      onKeyDraftChange: (value) => (this.keyDraft = value),
      onSaveKey: (provider, configKey) => void this.saveKey(provider, configKey),
      onRemoveKey: (provider, configKey) => void this.removeKey(provider, configKey),
      onProbe: (cardId, providers) => void this.probe(cardId, providers),
      onRequestLogout: (provider) => (this.pendingLogoutProvider = provider),
      onCancelLogout: () => (this.pendingLogoutProvider = null),
      onLogout: (cardId, providers) => void this.logout(cardId, providers),
      onAddProviderToggle: () => {
        this.addProviderOpen = !this.addProviderOpen;
        this.addProviderKey = "";
        this.setMessage("add", null);
      },
      onAddProviderIdChange: (provider) => (this.addProviderId = provider),
      onAddProviderKeyChange: (value) => (this.addProviderKey = value),
      onAddProvider: () => void this.addProvider(),
      onPrimaryChange: (model) => {
        this.defaultsDraft = {
          ...defaults,
          primary: model,
          fallbacks: defaults.fallbacks.filter((fallback) => fallback !== model),
        };
        this.setMessage("defaults", null);
      },
      onFallbackAdd: (model) => {
        this.defaultsDraft = {
          ...defaults,
          fallbacks: [...defaults.fallbacks, model],
        };
        this.setMessage("defaults", null);
      },
      onFallbackRemove: (index) => {
        this.defaultsDraft = {
          ...defaults,
          fallbacks: defaults.fallbacks.filter((_, candidate) => candidate !== index),
        };
        this.setMessage("defaults", null);
      },
      onUtilityChange: (model) => {
        this.defaultsDraft = { ...defaults, utilityModel: model };
        this.setMessage("defaults", null);
      },
      onDefaultModelsSave: () => void this.saveDefaultModels(),
      onDefaultModelsReset: () => {
        this.defaultsDraft = null;
        this.setMessage("defaults", null);
      },
    });
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${titleForRoute("model-providers")}</div>
          <div class="page-sub">${subtitleForRoute("model-providers")}</div>
        </div>
      </section>
      ${renderSettingsWorkspace(body)}
    `;
  }
}

customElements.define("openclaw-model-providers-page", ModelProvidersPage);
