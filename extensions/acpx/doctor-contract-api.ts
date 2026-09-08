// ACPX doctor contract repairs shipped config and migrates plugin-owned runtime state.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  archiveLegacyStateSource,
  asObjectRecord,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  normalizeAcpxProcessLease,
  normalizeAcpxProcessLeaseFile,
  openAcpxProcessLeaseStateStore,
  type AcpxProcessLease,
} from "./src/process-lease.js";
import {
  ACPX_GATEWAY_INSTANCE_KEY,
  ACPX_GATEWAY_INSTANCE_MAX_ENTRIES,
  ACPX_GATEWAY_INSTANCE_NAMESPACE,
  ACPX_LEGACY_GATEWAY_INSTANCE_FILE,
  ACPX_LEGACY_PROCESS_LEASE_FILE,
  normalizeAcpxGatewayInstanceRecord,
  type AcpxGatewayInstanceRecord,
} from "./src/state.js";

const ACPX_CONFIG_PATH = ["plugins", "entries", "acpx", "config"] as const;
const RETIRED_ACPX_CONFIG_KEYS = ["strictWindowsCmdWrapper", "queueOwnerTtlSeconds"] as const;

/** Retired ACPX config that `openclaw doctor --fix` removes before strict validation. */
export const legacyConfigRules = RETIRED_ACPX_CONFIG_KEYS.map((key) => ({
  path: [...ACPX_CONFIG_PATH, key],
  message: `${[...ACPX_CONFIG_PATH, key].join(".")} is retired and ignored by the embedded ACPX runtime. Run "openclaw doctor --fix".`,
}));

/** Removes retired plugin-owned config without keeping runtime compatibility keys. */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const entry = asObjectRecord(cfg.plugins?.entries?.acpx);
  const pluginConfig = asObjectRecord(entry?.config);
  const retiredKeys = RETIRED_ACPX_CONFIG_KEYS.filter((key) =>
    Object.hasOwn(pluginConfig ?? {}, key),
  );
  if (!pluginConfig || retiredKeys.length === 0) {
    return { config: cfg, changes: [] };
  }

  const nextConfig = structuredClone(cfg);
  const nextEntry = asObjectRecord(nextConfig.plugins?.entries?.acpx);
  const nextPluginConfig = asObjectRecord(nextEntry?.config);
  if (!nextPluginConfig) {
    return { config: cfg, changes: [] };
  }
  for (const key of retiredKeys) {
    delete nextPluginConfig[key];
  }

  return {
    config: nextConfig,
    changes: [
      `Removed retired ACPX plugin config: ${retiredKeys.map((key) => [...ACPX_CONFIG_PATH, key].join(".")).join(", ")}.`,
    ],
  };
}

function resolveLegacyGatewayInstancePath(stateDir: string): string {
  return path.join(stateDir, ACPX_LEGACY_GATEWAY_INSTANCE_FILE);
}

function resolveLegacyProcessLeasePath(stateDir: string): string {
  return path.join(stateDir, "acpx", ACPX_LEGACY_PROCESS_LEASE_FILE);
}

async function readLegacyGatewayInstanceId(filePath: string): Promise<string | null> {
  try {
    const value = (await fs.readFile(filePath, "utf8")).trim();
    return value || null;
  } catch {
    return null;
  }
}

async function readLegacyOpenProcessLeases(filePath: string): Promise<AcpxProcessLease[]> {
  try {
    const leaseFile = normalizeAcpxProcessLeaseFile(
      JSON.parse(await fs.readFile(filePath, "utf8")),
    );
    return leaseFile.leases.filter((lease) => lease.state === "open" || lease.state === "closing");
  } catch {
    return [];
  }
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "acpx-runtime-state-to-plugin-state",
    label: "ACPX runtime state",
    async detectLegacyState(params) {
      const gatewayInstanceId = await readLegacyGatewayInstanceId(
        resolveLegacyGatewayInstancePath(params.stateDir),
      );
      const openLeases = await readLegacyOpenProcessLeases(
        resolveLegacyProcessLeasePath(params.stateDir),
      );
      if (!gatewayInstanceId && openLeases.length === 0) {
        return null;
      }
      const preview: string[] = [];
      if (gatewayInstanceId) {
        preview.push(
          `- ACPX gateway instance id: ${resolveLegacyGatewayInstancePath(params.stateDir)} -> plugin state (${ACPX_GATEWAY_INSTANCE_NAMESPACE})`,
        );
      }
      if (openLeases.length > 0) {
        preview.push(
          `- ACPX process leases: ${resolveLegacyProcessLeasePath(params.stateDir)} -> plugin state (${openLeases.length} open lease(s))`,
        );
      }
      return { preview };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const gatewayInstancePath = resolveLegacyGatewayInstancePath(params.stateDir);
      const gatewayInstanceId = await readLegacyGatewayInstanceId(gatewayInstancePath);
      const processLeasePath = resolveLegacyProcessLeasePath(params.stateDir);
      const openLeases = await readLegacyOpenProcessLeases(processLeasePath);
      const processLeaseStore = openAcpxProcessLeaseStateStore(
        params.context.openPluginStateKeyedStore,
      );
      const gatewayStore = params.context.openPluginStateKeyedStore<AcpxGatewayInstanceRecord>({
        namespace: ACPX_GATEWAY_INSTANCE_NAMESPACE,
        maxEntries: ACPX_GATEWAY_INSTANCE_MAX_ENTRIES,
      });
      const existingGateway = normalizeAcpxGatewayInstanceRecord(
        await gatewayStore.lookup(ACPX_GATEWAY_INSTANCE_KEY),
      );
      const existingLiveLeases = (await processLeaseStore.entries())
        .map((entry) => normalizeAcpxProcessLease(entry.value))
        .filter(
          (lease): lease is AcpxProcessLease =>
            lease != null && (lease.state === "open" || lease.state === "closing"),
        );
      const leaseGatewayIds = new Set(openLeases.map((lease) => lease.gatewayInstanceId));
      const onlyLeaseGatewayId = leaseGatewayIds.size === 1 ? [...leaseGatewayIds][0] : null;
      const canAdoptLegacyGateway =
        existingGateway &&
        gatewayInstanceId &&
        existingGateway.instanceId !== gatewayInstanceId &&
        onlyLeaseGatewayId === gatewayInstanceId &&
        existingLiveLeases.length === 0;
      const canonicalGatewayInstanceId =
        canAdoptLegacyGateway || !existingGateway
          ? (gatewayInstanceId ?? onlyLeaseGatewayId)
          : existingGateway.instanceId;

      if (
        openLeases.length > 0 &&
        (!canonicalGatewayInstanceId ||
          [...leaseGatewayIds].some(
            (leaseGatewayId) => leaseGatewayId !== canonicalGatewayInstanceId,
          ))
      ) {
        warnings.push(
          "Skipped ACPX process lease migration because legacy leases do not match the canonical gateway instance id; left legacy sources in place for manual cleanup",
        );
        return { changes, warnings };
      }

      if (canAdoptLegacyGateway && canonicalGatewayInstanceId) {
        await gatewayStore.register(ACPX_GATEWAY_INSTANCE_KEY, {
          instanceId: canonicalGatewayInstanceId,
          createdAt: Date.now(),
        });
        changes.push("Migrated ACPX gateway instance id -> plugin state");
      } else if (canonicalGatewayInstanceId && !existingGateway) {
        await gatewayStore.register(ACPX_GATEWAY_INSTANCE_KEY, {
          instanceId: canonicalGatewayInstanceId,
          createdAt: Date.now(),
        });
        changes.push("Migrated ACPX gateway instance id -> plugin state");
      } else if (gatewayInstanceId && existingGateway?.instanceId !== gatewayInstanceId) {
        warnings.push(
          "Skipped ACPX gateway instance id import because plugin state already differs",
        );
      }

      if (gatewayInstanceId) {
        await archiveLegacyStateSource({
          filePath: gatewayInstancePath,
          label: "ACPX gateway-instance-id",
          changes,
          warnings,
        });
      }

      if (openLeases.length > 0) {
        let imported = 0;
        let alreadyPresent = 0;
        for (const lease of openLeases) {
          const inserted = await processLeaseStore.registerIfAbsent(lease.leaseId, lease);
          if (inserted) {
            imported++;
          } else {
            alreadyPresent++;
          }
        }
        changes.push(
          `Migrated ACPX process leases -> plugin state (${imported} imported, ${alreadyPresent} already present)`,
        );
        await archiveLegacyStateSource({
          filePath: processLeasePath,
          label: "ACPX process-leases",
          changes,
          warnings,
        });
      }

      return { changes, warnings };
    },
  },
  {
    id: "acpx-session-owner-resources",
    label: "ACP session owners",
    doctorOnly: true,
    phase: "after-session-repair",
    async detectLegacyState(input) {
      return (
        await import("./src/session-owner-migration.js")
      ).acpxSessionOwnerMigration.detectLegacyState(input);
    },
    async migrateLegacyState(input) {
      return (
        await import("./src/session-owner-migration.js")
      ).acpxSessionOwnerMigration.migrateLegacyState(input);
    },
  },
];
