import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  expectedIntegrityForUpdate,
  readInstalledPackageVersion,
} from "../infra/package-update-utils.js";
import {
  installHooksFromNpmSpec,
  type HookNpmIntegrityDriftParams,
  resolveHookInstallDir,
} from "./install.js";
import { recordHookInstall } from "./installs.js";

export type HookPackUpdateLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type HookPackUpdateStatus = "updated" | "unchanged" | "skipped" | "error";

export type HookPackUpdateOutcome = {
  hookId: string;
  status: HookPackUpdateStatus;
  message: string;
  currentVersion?: string;
  nextVersion?: string;
};

export type HookPackUpdateSummary = {
  config: OpenClawConfig;
  changed: boolean;
  outcomes: HookPackUpdateOutcome[];
};

export type HookPackUpdateIntegrityDriftParams = HookNpmIntegrityDriftParams & {
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

export async function updateNpmInstalledHookPacks(params: {
  config: OpenClawConfig;
  logger?: HookPackUpdateLogger;
  hookIds?: string[];
  dryRun?: boolean;
  specOverrides?: Record<string, string>;
  onIntegrityDrift?: (params: HookPackUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
}): Promise<HookPackUpdateSummary> {
  const logger = params.logger ?? {};
  const installs = params.config.hooks?.internal?.installs ?? {};
  const targets = params.hookIds?.length ? params.hookIds : Object.keys(installs);
  const outcomes: HookPackUpdateOutcome[] = [];
  let next = params.config;
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
    const result = await installHooksFromNpmSpec({
      spec: effectiveSpec,
      mode: "update",
      dryRun: params.dryRun,
      expectedHookPackId: hookId,
      expectedIntegrity,
      onIntegrityDrift: createHookPackUpdateIntegrityDriftHandler({
        hookId,
        dryRun: Boolean(params.dryRun),
        logger,
        onIntegrityDrift: params.onIntegrityDrift,
      }),
      logger,
    });

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

    if (params.dryRun) {
      outcomes.push({
        hookId,
        status,
        currentVersion: currentVersion ?? undefined,
        nextVersion: nextVersion ?? undefined,
        message:
          status === "unchanged"
            ? `Hook pack "${hookId}" is up to date (${currentLabel}).`
            : `Would update hook pack "${hookId}": ${currentLabel} -> ${nextLabel}.`,
      });
      continue;
    }

    next = recordHookInstall(next, {
      hookId,
      source: "npm",
      spec: effectiveSpec,
      installPath: result.targetDir,
      version: nextVersion,
      resolvedName: result.npmResolution?.name,
      resolvedSpec: result.npmResolution?.resolvedSpec,
      integrity: result.npmResolution?.integrity,
      hooks: result.hooks,
    });
    changed = true;

    outcomes.push({
      hookId,
      status,
      currentVersion: currentVersion ?? undefined,
      nextVersion: nextVersion ?? undefined,
      message:
        status === "unchanged"
          ? `Hook pack "${hookId}" already at ${currentLabel}.`
          : `Updated hook pack "${hookId}": ${currentLabel} -> ${nextLabel}.`,
    });
  }

  return { config: next, changed, outcomes };
}
