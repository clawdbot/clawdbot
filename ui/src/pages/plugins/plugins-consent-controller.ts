import type { CapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import {
  inspectPlugin,
  readPluginCapabilityConsentError,
} from "../../lib/plugins/capability-consent-error.ts";
import {
  installPlugin,
  pluginInstallNeedsRiskAcknowledgement,
  readPluginInstallTrustError,
  runPluginConfigMutation,
  setPluginEnabled,
  type PluginInstallRequest,
  type PluginListResult,
  type PluginMutationResult,
  type PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import type { PluginConsentIntent, PluginConsentState } from "./consent-dialog.ts";
import { readPluginInstallPolicyWarning } from "./install-policy-warning.ts";
import { pluginRowKey, type PluginRowMessage } from "./view.ts";

type PluginMutationSuccess<Result> = (
  result: Result,
  refreshError: string | null,
  client: GatewayBrowserClient,
  isCurrent: () => boolean,
  isLatest: () => boolean,
) => Promise<void>;

type PluginsConsentControllerHost = {
  gateway: GatewayPageController;
  getContext: () => ApplicationContext;
  getResult: () => PluginListResult | null;
  canMutate: () => boolean;
  isBusy: (rowKey: string) => boolean;
  setBusy: (rowKey: string, busy: boolean) => void;
  setMessage: (rowKey: string, message: PluginRowMessage | null) => void;
  clearPageNotice: () => void;
  closeDetails: () => void;
  applyMutationResult: (result: PluginMutationResult) => void;
  refreshCatalogAfterMutation: (client: GatewayBrowserClient) => Promise<void>;
  requestUpdate: () => void;
};

function committedMutationMessage(
  action: "installed" | "enabled" | "disabled",
  result: PluginMutationResult,
  refreshError: string | null,
): PluginRowMessage {
  const key = result.restartRequired
    ? `pluginsPage.${action}Restart`
    : `pluginsPage.${action}Success`;
  const warnings = "warnings" in result ? (result.warnings ?? []) : [];
  return {
    kind: "success",
    text: [
      t(key, { name: result.plugin.name }),
      ...warnings.map((warning) => formatUiExternalText(warning)),
      refreshError ? t("pluginsPage.configRefreshFailed", { error: refreshError }) : null,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export class PluginsConsentController {
  consent: PluginConsentState | null = null;
  inspection: PluginsInspectResult | null = null;
  inspectionLoading = false;
  inspectionError: string | null = null;

  private mutationToken = 0;
  private readonly mutationTokens = new Map<string, number>();

  constructor(private readonly host: PluginsConsentControllerHost) {}

  reset(): void {
    this.close();
    this.mutationTokens.clear();
  }

  async runMutation<Result>(
    rowKey: string,
    mutate: (client: GatewayBrowserClient) => Promise<Result>,
    onSuccess: PluginMutationSuccess<Result>,
    onError: (error: unknown) => void = (error) => {
      this.host.setMessage(rowKey, { kind: "error", text: formatUiError(error) });
    },
    options: { preserveMessageWhilePending?: boolean } = {},
  ): Promise<void> {
    const scope = this.host.gateway.capture();
    if (!scope || !this.host.canMutate() || this.host.isBusy(rowKey)) {
      return;
    }
    this.host.clearPageNotice();
    const mutationToken = ++this.mutationToken;
    this.mutationTokens.set(rowKey, mutationToken);
    const isCurrent = () =>
      this.host.gateway.isCurrent(scope) && this.mutationTokens.get(rowKey) === mutationToken;
    const isLatest = () => isCurrent() && this.mutationToken === mutationToken;
    this.host.setBusy(rowKey, true);
    if (!options.preserveMessageWhilePending) {
      this.host.setMessage(rowKey, null);
    }
    try {
      const mutation = await runPluginConfigMutation(
        this.host.getContext().runtimeConfig,
        scope.client,
        mutate,
      );
      if (isCurrent()) {
        await onSuccess(mutation.value, mutation.refreshError, scope.client, isCurrent, isLatest);
      }
    } catch (error) {
      if (isCurrent()) {
        onError(error);
      }
    } finally {
      if (this.mutationTokens.get(rowKey) === mutationToken) {
        this.mutationTokens.delete(rowKey);
        this.host.setBusy(rowKey, false);
      }
    }
  }

  private open(
    intent: PluginConsentIntent,
    pluginId: string,
    details?: CapabilityConsentErrorDetails,
  ): void {
    if (!this.host.canMutate()) {
      return;
    }
    const plugin = this.host.getResult()?.plugins.find((entry) => entry.id === pluginId);
    this.host.closeDetails();
    this.inspection = null;
    this.inspectionError = null;
    this.inspectionLoading = true;
    this.consent = {
      intent,
      pluginId,
      fallback: {
        name: plugin?.name ?? pluginId,
        ...(plugin?.version ? { version: plugin.version } : {}),
        ...(plugin?.origin === "official" ? { official: true } : {}),
      },
      ...(details ? { details } : {}),
    };
    this.host.requestUpdate();
    void this.inspect();
  }

  close(): void {
    this.consent = null;
    this.inspection = null;
    this.inspectionLoading = false;
    this.inspectionError = null;
    this.host.requestUpdate();
  }

  async inspect(): Promise<void> {
    const consent = this.consent;
    const scope = this.host.gateway.capture();
    if (!consent?.pluginId || !scope) {
      return;
    }
    this.inspectionLoading = true;
    this.inspectionError = null;
    this.host.requestUpdate();
    try {
      const inspection = await inspectPlugin(scope.client, consent.pluginId);
      if (this.host.gateway.isCurrent(scope) && this.consent === consent) {
        this.inspection = inspection;
      }
    } catch (error) {
      if (this.host.gateway.isCurrent(scope) && this.consent === consent) {
        this.inspectionError = formatUiError(error);
      }
    } finally {
      if (this.host.gateway.isCurrent(scope) && this.consent === consent) {
        this.inspectionLoading = false;
        this.host.requestUpdate();
      }
    }
  }

  confirm(): void {
    const intent = this.consent?.intent;
    const reviewToken = this.inspection?.reviewToken;
    if (!intent || this.inspectionLoading || this.inspectionError || !reviewToken) {
      return;
    }
    this.close();
    if (intent.kind === "install") {
      void this.install(
        {
          ...intent.request,
          acknowledgeCapabilities: { reviewToken },
        },
        intent.installIdentity,
      );
    } else {
      void this.updateEnabled(intent.pluginId, true, intent.rowKey, {
        acknowledgeCapabilities: { reviewToken },
      });
    }
  }

  async install(request: PluginInstallRequest, installIdentity: string): Promise<void> {
    // The server stages and inspects the requested artifact before asking for consent.
    // Catalog/search metadata cannot authorize that artifact's capabilities.
    await this.runMutation(
      installIdentity,
      (client) => installPlugin(client, request),
      async (result, refreshError, client) => {
        const installedPluginKey = pluginRowKey(result.plugin.id);
        this.host.applyMutationResult(result);
        if (installedPluginKey !== installIdentity) {
          this.host.setMessage(installIdentity, null);
        }
        this.host.setMessage(
          installedPluginKey,
          committedMutationMessage("installed", result, refreshError),
        );
        await this.host.refreshCatalogAfterMutation(client);
      },
      (error) => {
        const consentDetails = readPluginCapabilityConsentError(error);
        if (consentDetails) {
          this.open(
            { kind: "install", request, installIdentity },
            consentDetails.pluginId,
            consentDetails,
          );
          return;
        }
        const policyWarning = readPluginInstallPolicyWarning(error);
        if (policyWarning) {
          this.host.setMessage(installIdentity, {
            kind: "warning",
            text: policyWarning.reason,
            installPolicyWarning: { details: policyWarning, request },
          });
          return;
        }
        const trust = readPluginInstallTrustError(error);
        const packageName = request.source === "clawhub" ? request.packageName : null;
        if (packageName && pluginInstallNeedsRiskAcknowledgement(error)) {
          this.host.setMessage(installIdentity, {
            kind: "error",
            text: trust?.warning ?? t("pluginsPage.defaultRiskWarning"),
            acknowledge: {
              packageName,
              ...(trust?.version ? { version: trust.version } : {}),
            },
          });
          return;
        }
        this.host.setMessage(installIdentity, { kind: "error", text: formatUiError(error) });
      },
      { preserveMessageWhilePending: request.acknowledgeInstallPolicyWarning === true },
    );
  }

  async updateEnabled(
    pluginId: string,
    enabled: boolean,
    key = pluginRowKey(pluginId),
    options: Parameters<typeof setPluginEnabled>[3] = {},
  ): Promise<void> {
    // The server owns whether stored acceptance still covers the installed artifact.
    await this.runMutation(
      key,
      (client) => setPluginEnabled(client, pluginId, enabled, options),
      async (result, refreshError, client, isCurrent) => {
        this.host.applyMutationResult(result);
        this.host.setMessage(
          key,
          committedMutationMessage(enabled ? "enabled" : "disabled", result, refreshError),
        );
        await this.host.refreshCatalogAfterMutation(client);
        if (isCurrent() && !result.restartRequired) {
          // Plugin tabs come from hello; reconnect after the registry refresh.
          this.host.getContext().gateway.connect();
        }
      },
      (error) => {
        const details = readPluginCapabilityConsentError(error);
        if (enabled && details) {
          this.open({ kind: "enable", pluginId, rowKey: key }, details.pluginId, details);
          return;
        }
        this.host.setMessage(key, { kind: "error", text: formatUiError(error) });
      },
    );
  }
}
