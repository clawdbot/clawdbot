import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import type { PluginDiscoveryDetailResult, PluginListResult } from "../../lib/plugins/index.ts";
import {
  installedPluginWizardStage,
  installRequestForDiscoveryDetail,
  type PluginInstallWizardState,
} from "./install-wizard-model.ts";
import { pluginRowKey } from "./plugin-row-message.ts";
import type { PluginsConsentController } from "./plugins-consent-controller.ts";

const INSTALL_RECONNECT_TIMEOUT_MS = 30_000;

type InstallWizardControllerHost = {
  getState: () => PluginInstallWizardState | null;
  setState: (state: PluginInstallWizardState | null) => void;
  getCatalog: () => PluginListResult | null;
  getRuntimeConfig: () => ApplicationContext["runtimeConfig"];
  getConsentController: () => PluginsConsentController;
  isConnected: () => boolean;
  canMutate: () => boolean;
  canEditConfig: () => boolean;
  refreshCatalog: () => Promise<void>;
  requestUpdate: () => void;
  onManage: (pluginId: string) => void;
};

export class InstallWizardController {
  private reconnectTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  constructor(private readonly host: InstallWizardControllerHost) {}

  get busy(): boolean {
    const state = this.host.getState();
    return Boolean(state && ["installing", "reconnecting", "enabling"].includes(state.stage));
  }

  disconnect(): void {
    this.clearReconnectTimeout();
  }

  invalidate(): void {
    const state = this.host.getState();
    if (!this.busy || !state) {
      return;
    }
    this.host.setState({ ...state, stage: "reconnecting", error: undefined });
    this.armReconnectTimeout(state.catalogId);
  }

  open(result: PluginDiscoveryDetailResult): void {
    const request = installRequestForDiscoveryDetail(result);
    if (!request) {
      return;
    }
    this.clearReconnectTimeout();
    this.host.setState({
      catalogId: result.plugin.id,
      detail: result,
      request,
      stage: "review",
    });
    // Prepare the canonical form before the intentional restart so setup can resume immediately.
    void this.host.getRuntimeConfig().ensureLoaded();
    void this.host.getRuntimeConfig().ensureSchemaLoaded();
  }

  close(): void {
    this.clearReconnectTimeout();
    const key = this.key();
    if (key) {
      this.host.getConsentController().cancelMutationObserver(key);
    }
    this.host.setState(null);
  }

  cancelConsent(): void {
    this.host.getConsentController().close();
    const state = this.host.getState();
    if (!state) {
      return;
    }
    this.clearReconnectTimeout();
    this.host.setState({
      ...state,
      stage: "error",
      error: t("pluginsPage.installWizard.consentCancelled"),
    });
  }

  begin(): void {
    const state = this.host.getState();
    const key = this.key(state);
    if (!state || !key || !this.host.canMutate()) {
      return;
    }
    this.host.setState({ ...state, stage: "installing", error: undefined });
    void this.host.getConsentController().install(state.request, key, {
      reviewConfirmed: true,
      onCommitted: (result) => {
        const current = this.host.getState();
        if (current?.catalogId !== state.catalogId) {
          return;
        }
        this.host.setState({
          ...current,
          pluginId: result.plugin.id,
          stage: "reconnecting",
          policyReason: undefined,
          error: undefined,
        });
        if (result.restartRequired) {
          this.armReconnectTimeout(state.catalogId);
        } else {
          void this.resume();
        }
      },
      onFailure: (error) => this.fail(state.catalogId, error),
      onInstallPolicyWarning: (_request, reason) => {
        const current = this.host.getState();
        if (current?.catalogId === state.catalogId) {
          this.host.setState({ ...current, stage: "policy-warning", policyReason: reason });
        }
      },
    });
  }

  continuePolicyWarning(): void {
    const state = this.host.getState();
    const key = this.key(state);
    if (!state || !key) {
      return;
    }
    this.host.setState({ ...state, stage: "installing", error: undefined });
    void this.host
      .getConsentController()
      .install({ ...state.request, acknowledgeInstallPolicyWarning: true }, key);
  }

  async resume(): Promise<void> {
    const state = this.host.getState();
    if (!state || state.stage !== "reconnecting" || !this.host.isConnected()) {
      return;
    }
    this.clearReconnectTimeout();
    const plugin = this.installedPlugin(state);
    if (!plugin) {
      this.fail(state.catalogId, t("pluginsPage.installWizard.installedStateMissing"));
      return;
    }
    const stage = installedPluginWizardStage(plugin);
    this.host.setState({ ...state, pluginId: plugin.id, stage });
    if (stage === "configuring") {
      const runtimeConfig = this.host.getRuntimeConfig();
      if (runtimeConfig.state.connected) {
        await Promise.all([runtimeConfig.ensureLoaded(), runtimeConfig.ensureSchemaLoaded()]);
      }
      this.host.requestUpdate();
    } else if (stage === "enabling") {
      this.enable(plugin.id);
    }
  }

  async saveConfiguration(): Promise<void> {
    const state = this.host.getState();
    if (!state?.pluginId || state.stage !== "configuring" || !this.host.canEditConfig()) {
      return;
    }
    const runtimeConfig = this.host.getRuntimeConfig();
    if (!(await runtimeConfig.save())) {
      this.fail(
        state.catalogId,
        runtimeConfig.state.lastError ?? t("pluginsPage.installWizard.configSaveFailed"),
      );
      return;
    }
    await this.host.refreshCatalog();
    this.enable(state.pluginId);
  }

  retry(): void {
    const state = this.host.getState();
    if (!state) {
      return;
    }
    if (state.pluginId) {
      this.host.setState({ ...state, stage: "reconnecting", error: undefined });
      this.armReconnectTimeout(state.catalogId);
      void this.host.refreshCatalog().then(() => this.resume());
      return;
    }
    this.host.setState({ ...state, stage: "review", error: undefined });
  }

  manage(): void {
    const pluginId = this.host.getState()?.pluginId;
    if (!pluginId) {
      return;
    }
    this.close();
    this.host.onManage(pluginId);
  }

  private key(state = this.host.getState()): string | null {
    return state ? `install:${state.catalogId}` : null;
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimer !== null) {
      globalThis.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private armReconnectTimeout(catalogId: string): void {
    this.clearReconnectTimeout();
    this.reconnectTimer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      const state = this.host.getState();
      if (state?.catalogId === catalogId && state.stage === "reconnecting") {
        this.fail(catalogId, t("pluginsPage.installWizard.reconnectTimedOut"));
      }
    }, INSTALL_RECONNECT_TIMEOUT_MS);
  }

  private fail(catalogId: string, error: string): void {
    const state = this.host.getState();
    if (state?.catalogId === catalogId) {
      this.clearReconnectTimeout();
      this.host.setState({ ...state, stage: "error", error });
    }
  }

  private installedPlugin(state: PluginInstallWizardState) {
    const packageName = state.request.source === "clawhub" ? state.request.packageName : undefined;
    const officialId = state.request.source === "official" ? state.request.pluginId : undefined;
    return (
      this.host
        .getCatalog()
        ?.plugins.find(
          (plugin) =>
            plugin.installed &&
            (plugin.id === state.pluginId ||
              plugin.id === officialId ||
              (packageName !== undefined && plugin.packageName === packageName)),
        ) ?? null
    );
  }

  private enable(pluginId: string): void {
    const state = this.host.getState();
    if (!state) {
      return;
    }
    const key = pluginRowKey(pluginId);
    this.host.setState({ ...state, pluginId, stage: "enabling", error: undefined });
    void this.host.getConsentController().updateEnabled(
      pluginId,
      true,
      key,
      {},
      {
        onCommitted: (result) => {
          const current = this.host.getState();
          if (current?.catalogId !== state.catalogId) {
            return;
          }
          this.host.setState({
            ...current,
            pluginId: result.plugin.id,
            stage: result.restartRequired ? "reconnecting" : "success",
          });
          if (result.restartRequired) {
            this.armReconnectTimeout(state.catalogId);
          } else {
            this.clearReconnectTimeout();
          }
        },
        onFailure: (error) => this.fail(state.catalogId, error),
      },
    );
  }
}
