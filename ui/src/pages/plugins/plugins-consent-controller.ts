import type { CapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
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
  type PluginSearchResult,
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
  getSearchResults: () => PluginSearchResult[] | null;
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
    this.invalidateMutations();
  }

  invalidateMutations(): void {
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

  requestInstallConsent(request: PluginInstallRequest, installIdentity: string): void {
    if (
      request.acknowledgeCapabilities ||
      request.acknowledgeInstallPolicyWarning ||
      (request.source === "clawhub" && request.acknowledgeClawHubRisk)
    ) {
      void this.install(request, installIdentity);
      return;
    }
    const pluginId = installIdentity.startsWith("plugin:")
      ? installIdentity.slice("plugin:".length)
      : null;
    const catalogPlugin = pluginId
      ? this.host.getResult()?.plugins.find((plugin) => plugin.id === pluginId)
      : undefined;
    const searchPackage =
      request.source === "clawhub"
        ? this.host.getSearchResults()?.find((entry) => entry.package.name === request.packageName)
            ?.package
        : undefined;
    const fallback = {
      name:
        catalogPlugin?.name ??
        searchPackage?.displayName ??
        (request.source === "official" ? request.pluginId : request.packageName),
      ...(catalogPlugin?.version || searchPackage?.latestVersion
        ? { version: catalogPlugin?.version ?? searchPackage?.latestVersion }
        : {}),
      ...(catalogPlugin || searchPackage
        ? { official: catalogPlugin?.origin === "official" || searchPackage?.isOfficial === true }
        : {}),
      ...(searchPackage?.verificationTier
        ? { verificationTier: searchPackage.verificationTier }
        : {}),
    };
    this.open({ kind: "install", request, installIdentity }, pluginId, undefined, fallback);
  }

  private open(
    intent: PluginConsentIntent,
    pluginId: string | null,
    details?: CapabilityConsentErrorDetails,
    fallback?: PluginConsentState["fallback"],
  ): void {
    if (!this.host.canMutate()) {
      return;
    }
    let resolvedFallback = fallback;
    if (!resolvedFallback && pluginId) {
      const plugin = this.host.getResult()?.plugins.find((entry) => entry.id === pluginId);
      resolvedFallback = {
        name: plugin?.name ?? pluginId,
        ...(plugin?.version ? { version: plugin.version } : {}),
        ...(plugin?.origin === "official" ? { official: true } : {}),
      };
    }
    this.host.closeDetails();
    this.inspection = null;
    this.inspectionError = null;
    this.inspectionLoading = Boolean(pluginId);
    this.consent = {
      intent,
      pluginId,
      fallback: resolvedFallback ?? null,
      ...(details ? { details } : {}),
    };
    this.host.requestUpdate();
    if (pluginId) {
      void this.inspect();
    }
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
        const unavailableBeforeInstall =
          consent.intent.kind === "install" &&
          !consent.details &&
          error instanceof GatewayRequestError &&
          error.code === "INVALID_REQUEST";
        this.inspectionError = unavailableBeforeInstall ? null : formatUiError(error);
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
    if (
      !intent ||
      this.inspectionLoading ||
      this.inspectionError ||
      (!reviewToken && (intent.kind === "enable" || Boolean(this.consent?.details)))
    ) {
      return;
    }
    this.close();
    if (intent.kind === "install") {
      void this.install(
        {
          ...intent.request,
          ...(reviewToken ? { acknowledgeCapabilities: { reviewToken } } : {}),
        },
        intent.installIdentity,
      );
    } else if (reviewToken) {
      void this.setEnabled(intent.pluginId, true, intent.rowKey, {
        acknowledgeCapabilities: { reviewToken },
      });
    }
  }

  async install(request: PluginInstallRequest, installIdentity: string): Promise<void> {
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
  ): Promise<void> {
    const plugin = this.host.getResult()?.plugins.find((entry) => entry.id === pluginId);
    // Bundled code ships with the release; external code needs an explicit consent moment.
    if (enabled && plugin && plugin.origin !== "bundled") {
      this.open({ kind: "enable", pluginId, rowKey: key }, pluginId);
      return;
    }
    await this.setEnabled(pluginId, enabled, key);
  }

  private async setEnabled(
    pluginId: string,
    enabled: boolean,
    key: string,
    options: Parameters<typeof setPluginEnabled>[3] = {},
  ): Promise<void> {
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
