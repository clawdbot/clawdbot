import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { markClawPackageIndependentlyOwned } from "../state/claw-package-adoption.js";
import { withClawPackageLifecycleLease } from "../state/claw-package-lifecycle-lease.js";
import type { ClawHubRiskAcknowledgementRequest } from "./clawhub.js";
import { installPluginFromNpmSpec } from "./install.js";

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

export async function runPluginUpdateWithClawHubLease<T>(params: {
  pluginId: string;
  clawhubPackage?: string;
  dryRun: boolean;
  run: () => Promise<T>;
}): Promise<T | { kind: "exception"; message: string; error: unknown }> {
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
      error,
    };
  }
}
