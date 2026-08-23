import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { markClawPackageIndependentlyOwned } from "../state/claw-package-adoption.js";
import { withClawPackageLifecycleLease } from "../state/claw-package-lifecycle-lease.js";
import type { ClawHubRiskAcknowledgementRequest } from "./clawhub.js";
import { installPluginFromNpmSpec } from "./install.js";
import type { PluginUpdateChannelFallback, PluginUpdateOutcome } from "./update-source.js";

type ClawHubInstallRecord = {
  source?: string;
  clawhubPackage?: string;
  spec?: string;
  resolvedSpec?: string;
};

export function resolveRecordedClawHubPackage(record: ClawHubInstallRecord): string | undefined {
  if (record.source !== "clawhub") {
    return undefined;
  }
  return (
    record.clawhubPackage ??
    parseClawHubPluginSpec(record.spec ?? "")?.name ??
    parseClawHubPluginSpec(record.resolvedSpec ?? "")?.name
  );
}

export function createTrackedNpmUpdateInstaller(onRun: () => void) {
  return async (params: Parameters<typeof installPluginFromNpmSpec>[0]) => {
    onRun();
    return await installPluginFromNpmSpec(params);
  };
}

export function resolveClawHubRiskAcknowledgementOptions(params: {
  dryRun?: boolean;
  acknowledgeClawHubRisk?: boolean;
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => boolean | Promise<boolean>;
}) {
  return {
    ...(params.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
    ...(!params.dryRun && params.onClawHubRisk ? { onClawHubRisk: params.onClawHubRisk } : {}),
  };
}

export function buildPluginUpdateVersionOutcome(params: {
  pluginId: string;
  currentVersion?: string;
  nextVersion?: string;
  channelFallbackSuffix: string;
  channelFallback?: PluginUpdateChannelFallback;
}): PluginUpdateOutcome {
  const currentLabel = params.currentVersion ?? "unknown";
  const nextLabel = params.nextVersion ?? "unknown";
  const unchanged = Boolean(
    params.currentVersion && params.nextVersion && params.currentVersion === params.nextVersion,
  );
  return {
    pluginId: params.pluginId,
    status: unchanged ? "unchanged" : "updated",
    currentVersion: params.currentVersion,
    nextVersion: params.nextVersion,
    message: unchanged
      ? `${params.pluginId} already at ${currentLabel}.${params.channelFallbackSuffix}`
      : `Updated ${params.pluginId}: ${currentLabel} -> ${nextLabel}.${params.channelFallbackSuffix}`,
    ...(params.channelFallback ? { channelFallback: params.channelFallback } : {}),
  };
}

export async function runPluginUpdateWithClawHubLease<T>(params: {
  pluginId: string;
  clawhubPackage?: string;
  dryRun: boolean;
  run: () => Promise<T>;
}): Promise<T | { kind: "exception"; message: string }> {
  try {
    if (!params.clawhubPackage || params.dryRun) {
      return await params.run();
    }
    return await withClawPackageLifecycleLease(
      { kind: "plugin", source: "clawhub", ref: params.clawhubPackage },
      async () => {
        markClawPackageIndependentlyOwned({
          kind: "plugin",
          source: "clawhub",
          ref: params.clawhubPackage!,
        });
        return await params.run();
      },
      { required: true },
    );
  } catch (error) {
    return {
      kind: "exception",
      message: `Failed to update ${params.pluginId}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
