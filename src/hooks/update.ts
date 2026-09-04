// Hook update helpers refresh installed hook records and config references.
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import { buildNpmResolutionFields } from "../infra/install-source-utils.js";
import {
  expectedIntegrityForUpdate,
  isPackageVersionDowngrade,
  readInstalledPackageVersion,
} from "../infra/package-update-utils.js";
import type { InstallSafetyOverrides } from "../plugins/install-security-scan.types.js";
import { resolvePluginInstallTransactionSink } from "../plugins/install-transaction.js";
import type { PluginLifecycleLeaseContext } from "../plugins/plugin-lifecycle-lease.js";
import { stageHookInstall } from "./install-record-transaction.js";
import {
  installHooksFromNpmSpec,
  type HookNpmIntegrityDriftParams,
  resolveHookInstallDir,
} from "./install.js";
import { readHookInstalls } from "./installs.js";

/** Logger contract for hook pack update operations. */
type HookPackUpdateLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

/** Per-pack update status emitted by updateNpmInstalledHookPacks. */
type HookPackUpdateStatus = "updated" | "unchanged" | "skipped" | "error";

/** Outcome for one hook pack update attempt. */
type HookPackUpdateOutcome = {
  hookId: string;
  status: HookPackUpdateStatus;
  message: string;
  currentVersion?: string;
  nextVersion?: string;
};

/** Aggregate update result with the possibly updated config. */
type HookPackUpdateSummary = {
  config: OpenClawConfig;
  changed: boolean;
  outcomes: HookPackUpdateOutcome[];
};

/** Integrity drift payload enriched with hook pack identity and dry-run state. */
type HookPackUpdateIntegrityDriftParams = HookNpmIntegrityDriftParams & {
  hookId: string;
  resolvedSpec?: string;
  resolvedVersion?: string;
  dryRun: boolean;
};

function createHookPackUpdateIntegrityDriftHandler(params: {
  hookId: string;
  dryRun: boolean;
  logger: HookPackUpdateLogger;
  onIntegrityDrift?: (params: HookPackUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
}) {
  return async (drift: HookNpmIntegrityDriftParams) => {
    const payload: HookPackUpdateIntegrityDriftParams = {
      hookId: params.hookId,
      spec: drift.spec,
      expectedIntegrity: drift.expectedIntegrity,
      actualIntegrity: drift.actualIntegrity,
      resolution: drift.resolution,
      resolvedSpec: drift.resolution.resolvedSpec,
      resolvedVersion: drift.resolution.version,
      dryRun: params.dryRun,
    };
    if (params.onIntegrityDrift) {
      return await params.onIntegrityDrift(payload);
    }
    params.logger.warn?.(
      `Integrity drift for hook pack "${params.hookId}" (${payload.resolvedSpec ?? payload.spec}): expected ${payload.expectedIntegrity}, got ${payload.actualIntegrity}`,
    );
    return false;
  };
}

/** Update npm-installed hook packs and return config changes plus per-pack outcomes. */
export async function updateNpmInstalledHookPacks(params: {
  config: OpenClawConfig;
  dangerouslyForceUnsafeInstall?: boolean;
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
  logger?: HookPackUpdateLogger;
  hookIds?: string[];
  dryRun?: boolean;
  lease?: PluginLifecycleLeaseContext;
  beforePersistentApply?: () => void;
  specOverrides?: Record<string, string>;
  onIntegrityDrift?: (params: HookPackUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
}): Promise<HookPackUpdateSummary> {
  const logger = params.logger ?? {};
  // The caller owns the config commit and settles every staged payload/record together.
  const persistence = params.dryRun
    ? undefined
    : {
        lease: expectDefined(params.lease, "hook update lifecycle lease"),
        transactions: expectDefined(
          resolvePluginInstallTransactionSink(params),
          "hook update transaction sink",
        ),
      };
  const beforePersistentApply = () => {
    persistence?.lease.assertOwned();
    params.beforePersistentApply?.();
  };
  if (persistence) {
    beforePersistentApply();
  }
  const installs = readHookInstalls(persistence ? { path: persistence.lease.databasePath } : {});
  const targets = params.hookIds?.length ? params.hookIds : Object.keys(installs);
  const outcomes: HookPackUpdateOutcome[] = [];
  let changed = false;

  for (const hookId of targets) {
    const record = installs[hookId];
    if (!record) {
      outcomes.push({
        hookId,
        status: "skipped",
        message: `No install record for hook pack "${hookId}".`,
      });
      continue;
    }
    if (record.source !== "npm") {
      outcomes.push({
        hookId,
        status: "skipped",
        message: `Skipping hook pack "${hookId}" (source: ${record.source}).`,
      });
      continue;
    }

    const effectiveSpec = params.specOverrides?.[hookId] ?? record.spec;
    // Only enforce the stored integrity when the update uses the same spec.
    // Spec overrides intentionally resolve a new tarball identity.
    const expectedIntegrity =
      effectiveSpec === record.spec
        ? expectedIntegrityForUpdate(record.spec, record.integrity)
        : undefined;
    if (!effectiveSpec) {
      outcomes.push({
        hookId,
        status: "skipped",
        message: `Skipping hook pack "${hookId}" (missing npm spec).`,
      });
      continue;
    }

    let installPath: string;
    try {
      installPath = record.installPath ?? resolveHookInstallDir(hookId);
    } catch (err) {
      outcomes.push({
        hookId,
        status: "error",
        message: `Invalid install path for hook pack "${hookId}": ${String(err)}`,
      });
      continue;
    }
    const currentVersion = await readInstalledPackageVersion(installPath);
    const result = await installHooksFromNpmSpec(
      requestDeferredPackageDirInstall({
        config: params.config,
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        onInstallPolicyWarning: params.onInstallPolicyWarning,
        spec: effectiveSpec,
        mode: "update",
        dryRun: params.dryRun,
        beforePersistentApply,
        expectedHookPackId: hookId,
        expectedIntegrity,
        onIntegrityDrift: createHookPackUpdateIntegrityDriftHandler({
          hookId,
          dryRun: Boolean(params.dryRun),
          logger,
          onIntegrityDrift: params.onIntegrityDrift,
        }),
        logger,
      }),
    );

    if (!result.ok) {
      outcomes.push({
        hookId,
        status: "error",
        message: `Failed to ${params.dryRun ? "check" : "update"} hook pack "${hookId}": ${result.error}`,
      });
      continue;
    }

    const nextVersion = result.version ?? (await readInstalledPackageVersion(result.targetDir));
    const currentLabel = currentVersion ?? "unknown";
    const nextLabel = nextVersion ?? "unknown";
    const status =
      currentVersion && nextVersion && currentVersion === nextVersion ? "unchanged" : "updated";
    const downgraded = isPackageVersionDowngrade(currentVersion, nextVersion);

    if (!persistence) {
      outcomes.push({
        hookId,
        status,
        currentVersion: currentVersion ?? undefined,
        nextVersion: nextVersion ?? undefined,
        message:
          status === "unchanged"
            ? `Hook pack "${hookId}" is up to date (${currentLabel}).`
            : `${downgraded ? "Would downgrade" : "Would update"} hook pack "${hookId}": ${currentLabel} -> ${nextLabel}.`,
      });
      continue;
    }

    persistence.transactions.push(
      await stageHookInstall({
        update: {
          hookId,
          source: "npm",
          spec: effectiveSpec,
          installPath: result.targetDir,
          version: nextVersion,
          ...buildNpmResolutionFields(result.npmResolution),
          hooks: result.hooks,
        },
        payloadTransaction: resolvePackageDirInstallTransaction(result),
        lease: persistence.lease,
        beforePersistentApply,
      }),
    );
    changed = true;

    outcomes.push({
      hookId,
      status,
      currentVersion: currentVersion ?? undefined,
      nextVersion: nextVersion ?? undefined,
      message:
        status === "unchanged"
          ? `Hook pack "${hookId}" already at ${currentLabel}.`
          : `${downgraded ? "Downgraded" : "Updated"} hook pack "${hookId}": ${currentLabel} -> ${nextLabel}.`,
    });
  }

  return { config: params.config, changed, outcomes };
}
