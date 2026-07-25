// Narrow shared secret-ref helpers for plugin config and secret-contract paths.

import fs from "node:fs/promises";
import { sameFileIdentity } from "../infra/fs-safe-advanced.js";
import {
  assertValidPluginModelProviderId,
  assertValidPluginSecretProviderAlias,
  buildPluginSecretRefSetupPlan,
  parsePluginSecretTargetSpecifier,
} from "../secrets/plugin-setup-plan.js";
import { createPrivateWindowsPlanFile } from "../secrets/private-plan-file.js";
import { resolveSecretPlanTargetByPath as resolveSecretPlanTargetByPathInternal } from "../secrets/target-registry-query.js";
import {
  resolveTrustedExecutablePath,
  resolveTrustedPlanDirectoryPath,
} from "../secrets/trusted-plan-path.js";

type PlanFileIdentity = { dev: bigint; ino: bigint };

function throwPlanFileError(error: unknown, planPath: string): never {
  if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
    throw new Error(`Plan path already exists; choose a new --plan-out path: ${planPath}`, {
      cause: error,
    });
  }
  throw error;
}

async function writeSecretPlanFile(params: {
  planPath: string;
  content: string;
  platform?: NodeJS.Platform;
  createPrivateWindowsFile?: (filePath: string, content: string) => Promise<void>;
}): Promise<void> {
  const platform = params.platform ?? process.platform;
  if (platform === "win32") {
    await (params.createPrivateWindowsFile ?? createPrivateWindowsPlanFile)(
      params.planPath,
      params.content,
    ).catch((error: unknown) => throwPlanFileError(error, params.planPath));
    return;
  }
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let identity: PlanFileIdentity | undefined;
  try {
    handle = await fs.open(params.planPath, "wx", 0o600);
    identity = await handle.stat({ bigint: true });
    await handle.chmod(0o600);
    if (((await handle.stat()).mode & 0o777) !== 0o600) {
      throw new Error("Unable to verify owner-only permissions for the generated plan file.");
    }
    const pathStat = await fs.lstat(params.planPath, { bigint: true });
    const handleStat = await handle.stat({ bigint: true });
    // Keep the pathname and open handle bound to the same new file before secrets are written.
    if (
      pathStat.isSymbolicLink() ||
      !sameFileIdentity(identity, handleStat) ||
      !sameFileIdentity(identity, pathStat)
    ) {
      throw new Error("Generated plan path changed during permission setup.");
    }
    await handle.writeFile(params.content, "utf8");
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throwPlanFileError(error, params.planPath);
    }
    if (identity) {
      try {
        const current = await fs.lstat(params.planPath, { bigint: true });
        if (!current.isSymbolicLink() && sameFileIdentity(current, identity)) {
          await fs.rm(params.planPath, { force: true });
        }
      } catch {
        // The write failure is authoritative; cleanup is best effort.
      }
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export { coerceSecretRef } from "../config/types.secrets.js";
export type { SecretInput, SecretRef } from "../config/types.secrets.js";
export { resolveSecretRefValues } from "../secrets/resolve.js";
export { applyResolvedAssignments, createResolverContext } from "../secrets/runtime-shared.js";

/** Shared validation and apply-plan construction for plugin-owned SecretRef setup CLIs. */
export const pluginSecretRefSetup = {
  assertValidModelProviderId: assertValidPluginModelProviderId,
  assertValidProviderAlias: assertValidPluginSecretProviderAlias,
  buildPlan: buildPluginSecretRefSetupPlan,
  parseTargetSpecifier: parsePluginSecretTargetSpecifier,
  resolveTrustedDirectoryPath: resolveTrustedPlanDirectoryPath,
  resolveTrustedExecutablePath,
  writePlanFile: writeSecretPlanFile,
};

export type ResolvedSecretPlanTarget = {
  targetType: string;
  providerId?: string;
  accountId?: string;
};

export function resolveSecretPlanTargetByPath(params: {
  configFile: "openclaw.json" | "auth-profiles.json";
  pathSegments: string[];
}): ResolvedSecretPlanTarget | null {
  const resolved = resolveSecretPlanTargetByPathInternal(params);
  if (!resolved) {
    return null;
  }
  return {
    targetType: resolved.entry.targetType,
    ...(resolved.providerId ? { providerId: resolved.providerId } : {}),
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
  };
}
