import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readConfigIncludeFileWithGuards, resolveConfigIncludes } from "../../config/includes.js";
import { resolveIncludeRoots } from "../../config/paths.js";
import { withConfigWriteLock } from "../../config/write-lock.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { hasErrnoCode } from "../../infra/errors.js";
import {
  captureUpdateCheckpointPreimages,
  reopenUpdateCheckpointPreimages,
  type UpdateCheckpointResource,
} from "../../infra/update-checkpoint.js";
import { bindUpdateRecoveryPreimages } from "../../infra/update-run-recovery-preimage.js";
import { assertExactUpdateRecoveryClaim } from "../../infra/update-run-recovery.js";
import { parseJsonWithJson5Fallback } from "../../utils/parse-json-compat.js";
import {
  UpdateCommandRecoveryPendingError,
  type UpdateCommandRecovery,
} from "./update-command-recovery.js";
import { gatewayServiceCommandUsesRoot } from "./update-command-service-plan.js";

/** Resolve the whole authored graph with the config owner's guarded reader.
 * A malformed/missing include is a refusal, not an incomplete capture inventory.
 */
async function configSources(configPath: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const raw = await fs.readFile(configPath, "utf8").catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  const files = new Set([configPath]);
  if (raw !== null) {
    resolveConfigIncludes(
      parseJsonWithJson5Fallback(raw),
      configPath,
      {
        readFile: (file) => fsSync.readFileSync(file, "utf8"),
        parseJson: parseJsonWithJson5Fallback,
        readFileWithGuards: (params) =>
          readConfigIncludeFileWithGuards({
            ...params,
            onResolvedPath: (file) => {
              files.add(file);
            },
          }),
      },
      { allowedRoots: resolveIncludeRoots(env) },
    );
  }
  return [...files].toSorted();
}

/** Capture and bind original file bytes under their existing write owners.
 * Native-manager facts and full-state capture remain separate prerequisites.
 * The native file inventory is reread under its lifecycle lock, not reconstructed
 * from paths or stale observations supplied by a caller.
 */
export async function captureUpdateCommandPreimages(params: {
  recovery: UpdateCommandRecovery;
  env: NodeJS.ProcessEnv;
  managedService?: boolean;
  timeoutMs?: number;
}) {
  const recovery = params.recovery;
  const expected = recovery.getRecord();
  if (!expected.source || expected.preimages) {
    throw new UpdateCommandRecoveryPendingError("Original files require a fresh startup claim.");
  }
  const { source } = expected;
  const artifactRoot = path.join(
    path.dirname(source.stateDir),
    `.${path.basename(source.stateDir)}-update-checkpoints`,
  );
  const binding = {
    runId: expected.runId,
    stateDir: source.stateDir,
    configPath: source.configPath,
    fromRuntime: {
      root: expected.from.root,
      nodePath: expected.from.nodePath,
      version: expected.from.version,
    },
  };
  return await withGatewayServiceOperationLock(params.env, async (assertNative) => {
    const command = params.managedService
      ? await resolveGatewayService().readCommand(params.env, {
          requireEffective: true,
          requireLoaded: true,
          timeoutMs: params.timeoutMs,
        })
      : null;
    if (
      params.managedService &&
      (!command?.sourcePath ||
        (await gatewayServiceCommandUsesRoot({
          root: expected.from.root,
          env: params.env,
          command,
        })) !== true)
    ) {
      throw new UpdateCommandRecoveryPendingError(
        "Original service files no longer belong to the admitted installation.",
      );
    }
    assertNative();
    recovery.fence.assertCurrent();
    const serviceFiles = command?.sourcePath
      ? [command.sourcePath, ...(command.definitionPaths ?? [])]
      : [];
    return await withConfigWriteLock(
      source.configPath,
      async () => {
        const originalSources = await configSources(source.configPath, params.env);
        const includes = originalSources.filter((file) => file !== source.configPath);
        const lockNext = async (
          index: number,
        ): Promise<Awaited<ReturnType<typeof reopenUpdateCheckpointPreimages>>> => {
          const includePath = includes[index];
          if (includePath !== undefined) {
            return await withConfigWriteLock(includePath, () => lockNext(index + 1), params.env);
          }
          const currentSources = await configSources(source.configPath, params.env);
          if (!isDeepStrictEqual(originalSources, currentSources)) {
            throw new UpdateCommandRecoveryPendingError(
              "Config include graph changed while acquiring source locks.",
            );
          }
          const resources: UpdateCheckpointResource[] = [
            ...currentSources.map((sourcePath) => ({
              sourcePath,
              kind: "config" as const,
              restore: "replace" as const,
            })),
            ...[...new Set(serviceFiles)].map((sourcePath) => ({
              sourcePath,
              kind: "service" as const,
              restore: "replace" as const,
            })),
          ];
          const assertCurrent = (): undefined => {
            assertNative();
            recovery.fence.assertCurrent();
          };
          assertExactUpdateRecoveryClaim(expected, { assertCurrent }, recovery.options);
          const ref = await captureUpdateCheckpointPreimages({
            artifactRoot,
            binding,
            resources,
            assertSourcesQuiescent: assertCurrent,
          });
          const next = await bindUpdateRecoveryPreimages(
            expected,
            { ref, artifactRoot },
            { assertCurrent },
            recovery.options,
          );
          recovery.onRecord(next);
          const reopened = await reopenUpdateCheckpointPreimages(ref, { artifactRoot, binding });
          assertExactUpdateRecoveryClaim(next, { assertCurrent }, recovery.options);
          return reopened;
        };
        return await lockNext(0);
      },
      params.env,
    );
  });
}
