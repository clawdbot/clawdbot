import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readInstallPolicyWarningErrorDetails } from "../../packages/gateway-protocol/src/install-policy-warning-error-details.js";
import type { PluginsInstallResult } from "../../packages/gateway-protocol/src/schema/plugins.js";
import { ManagedPluginLifecycleError } from "../plugins/management-lifecycle-error.js";
import type { installManagedPlugin } from "../plugins/management-mutations.js";
import type { PluginLifecycleGateway } from "./plugins-lifecycle-client.js";

/** Keep CLI prompts local; both transports use the same public install request. */
export function createGatewayPluginInstaller(
  gateway: PluginLifecycleGateway,
): typeof installManagedPlugin {
  return async (params) => {
    if (
      params.request.source === "clawhub" &&
      params.request.mode !== "update" &&
      params.confirmInstall &&
      !(await params.confirmInstall())
    ) {
      throw new ManagedPluginLifecycleError("Install cancelled.", { installRejected: true });
    }
    let result: PluginsInstallResult;
    try {
      try {
        result = await gateway<PluginsInstallResult>(
          "plugins.install",
          params.request,
          params.onCapabilityConsent,
        );
      } catch (error) {
        const details = readInstallPolicyWarningErrorDetails(
          error instanceof Error && "details" in error ? error.details : undefined,
        );
        if (
          !details ||
          !params.safetyOverrides?.onInstallPolicyWarning ||
          (await params.safetyOverrides.onInstallPolicyWarning(details)).status !== "approved"
        ) {
          throw error;
        }
        result = await gateway<PluginsInstallResult>(
          "plugins.install",
          { ...params.request, acknowledgeInstallPolicyWarning: true },
          params.onCapabilityConsent,
        );
      }
    } catch (error) {
      const details = error instanceof Error && "details" in error ? error.details : undefined;
      // Only an explicit install-owner refusal permits hook fallback. A lost reply
      // or runtime-apply failure can follow a committed plugin mutation.
      if (isRecord(details) && details.pluginInstallRejected === true) {
        const source = details.pluginInstallSource;
        const installSource: ManagedPluginLifecycleError["installSource"] =
          isRecord(source) &&
          (source.source === "npm" || source.source === "clawhub") &&
          typeof source.spec === "string"
            ? {
                source: source.source,
                spec: source.spec,
                ...(typeof source.expectedIntegrity === "string"
                  ? { expectedIntegrity: source.expectedIntegrity }
                  : {}),
              }
            : undefined;
        throw new ManagedPluginLifecycleError(
          error instanceof Error ? error.message : String(error),
          {
            installRejected: true,
            installSource,
            ...(typeof details.pluginInstallCode === "string"
              ? { code: details.pluginInstallCode }
              : {}),
            cause: error,
          },
        );
      }
      throw error;
    }
    return { plugin: result.plugin, warnings: result.warnings, application: result.runtime };
  };
}
