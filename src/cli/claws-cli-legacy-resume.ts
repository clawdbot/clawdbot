import { readClawInstallRecord, type PersistedClawInstall } from "../claws/provenance.js";
import type { ClawManifest, ClawSourceIdentity } from "../claws/types.js";
import type { ClawsAddOptions } from "./claws-cli.js";

export function authorizeLegacyV1Resume(params: {
  manifest: ClawManifest;
  source: Pick<ClawSourceIdentity, "kind" | "name" | "version" | "packageRoot" | "manifestPath">;
  opts: ClawsAddOptions;
}): PersistedClawInstall | undefined {
  const finalAgentId = params.opts.agentId?.trim() || params.manifest.agent?.id?.trim();
  const consentPlanIntegrity = params.opts.planIntegrity?.trim();
  if (!finalAgentId || !consentPlanIntegrity) {
    return undefined;
  }
  const record = readClawInstallRecord(finalAgentId);
  if (
    !record ||
    record.schemaVersion !== "openclaw.clawInstallRecord.v1" ||
    record.status === "complete" ||
    record.planIntegrity !== consentPlanIntegrity ||
    record.claw.kind !== params.source.kind ||
    record.claw.name !== params.source.name ||
    record.claw.version !== params.source.version ||
    record.claw.packageRoot !== params.source.packageRoot ||
    record.claw.manifestPath !== params.source.manifestPath
  ) {
    return undefined;
  }
  return record;
}
