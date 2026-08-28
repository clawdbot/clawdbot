import {
  activatePluginRecordLifecycleEpoch,
  isPluginRecordLifecycleEpochActive,
  isPluginRegistryActivated,
  isPluginRegistryRetired,
} from "./registry-lifecycle.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  attachBrowserNodeDelegationResolver,
  type BrowserNodeDelegationRuntime,
} from "./runtime/browser-node-delegation.js";
import { withPluginRuntimeGatewayRequestAuthority } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";

function isTrustedBrowserPluginRecord(record: PluginRecord | undefined): boolean {
  return record?.origin === "bundled" || record?.trustedOfficialInstall === true;
}

export function attachBrowserNodeDelegationRuntime(params: {
  runtime: PluginRuntime;
  registry: PluginRegistry;
  pluginId: string;
  record: PluginRecord;
  pluginRuntimeRecordById: Map<string, PluginRecord>;
  activePluginRuntimeRecords: WeakSet<PluginRecord>;
  browserNodeDelegationEpochByRecord: WeakMap<PluginRecord, object>;
  runWithPluginScope: <T>(run: () => T) => T;
}): void {
  const {
    runtime,
    registry,
    pluginId,
    record,
    pluginRuntimeRecordById,
    activePluginRuntimeRecords,
    browserNodeDelegationEpochByRecord,
    runWithPluginScope,
  } = params;

  attachBrowserNodeDelegationResolver(runtime, (): BrowserNodeDelegationRuntime | undefined => {
    const registration = registry.browserNodeDelegations.find((entry) =>
      entry.delegation.consumerPluginIds.includes(pluginId),
    );
    if (!registration) {
      return undefined;
    }
    const providerRecord = registration.providerRecord;
    const isProviderRuntimeActive = () =>
      pluginRuntimeRecordById.get(registration.pluginId) === providerRecord &&
      activePluginRuntimeRecords.has(providerRecord) &&
      isTrustedBrowserPluginRecord(providerRecord) &&
      providerRecord.status === "loaded" &&
      providerRecord.enabled &&
      providerRecord.origin === registration.provider.origin &&
      providerRecord.source === registration.provider.source &&
      providerRecord.rootDir === registration.provider.rootDir &&
      providerRecord.trustedOfficialInstall === registration.provider.trustedOfficialInstall;
    if (!isProviderRuntimeActive()) {
      return undefined;
    }
    if (
      pluginRuntimeRecordById.get(pluginId) !== record ||
      !isTrustedBrowserPluginRecord(record) ||
      record.status !== "loaded" ||
      !record.enabled
    ) {
      return undefined;
    }
    const consumerRecord = record;
    let consumerEpoch = browserNodeDelegationEpochByRecord.get(consumerRecord);
    const resolveConsumerEpoch = () => {
      if (consumerEpoch) {
        return consumerEpoch;
      }
      if (!isPluginRegistryActivated(registry) || isPluginRegistryRetired(registry)) {
        return undefined;
      }
      if (
        pluginRuntimeRecordById.get(pluginId) !== consumerRecord ||
        !activePluginRuntimeRecords.has(consumerRecord) ||
        consumerRecord.status !== "loaded" ||
        !consumerRecord.enabled ||
        !registry.plugins.some(
          (candidateRecord) =>
            candidateRecord === consumerRecord && candidateRecord.status === "loaded",
        )
      ) {
        return undefined;
      }
      consumerEpoch = activatePluginRecordLifecycleEpoch(registry, consumerRecord);
      if (consumerEpoch) {
        browserNodeDelegationEpochByRecord.set(consumerRecord, consumerEpoch);
      }
      return consumerEpoch;
    };
    const isConsumerRuntimeActive = () => {
      const epoch = resolveConsumerEpoch();
      return Boolean(
        epoch &&
        pluginRuntimeRecordById.get(pluginId) === consumerRecord &&
        activePluginRuntimeRecords.has(consumerRecord) &&
        consumerRecord.status === "loaded" &&
        consumerRecord.enabled &&
        registry.plugins.some(
          (candidateRecord) =>
            candidateRecord === consumerRecord && candidateRecord.status === "loaded",
        ) &&
        isPluginRecordLifecycleEpochActive(registry, consumerRecord, epoch),
      );
    };
    const isBrowserNodeDelegationActive = () =>
      registry.browserNodeDelegations.includes(registration) &&
      isProviderRuntimeActive() &&
      isConsumerRuntimeActive();
    return {
      request: async (requestParams) => {
        if (!registry.browserNodeDelegations.includes(registration)) {
          throw new Error("Browser node delegation is no longer active.");
        }
        if (!isProviderRuntimeActive()) {
          throw new Error("Browser node delegation provider lifecycle is no longer active.");
        }
        if (!isConsumerRuntimeActive()) {
          throw new Error("Browser node delegation consumer lifecycle is no longer active.");
        }
        return await withPluginRuntimeGatewayRequestAuthority(isBrowserNodeDelegationActive, () =>
          runWithPluginScope(() =>
            registration.delegation.request({ ...requestParams, consumerPluginId: pluginId }),
          ),
        );
      },
    };
  });
}
