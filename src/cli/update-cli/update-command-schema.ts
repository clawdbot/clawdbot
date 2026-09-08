import type { UpdateChannel } from "../../infra/update-channels.js";
import type { DevUpdateTarget } from "../../infra/update-dev-target.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import { recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import type { OpenClawDatabaseSchemaPreflight } from "../../state/openclaw-database-preflight.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import {
  checkTargetDatabaseSchemasForContexts,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
} from "./schema-preflight.js";
import {
  resolveGitInstallDir,
  UpdatePreMutationError,
  type UpdateCommandOptions,
} from "./shared.js";
import { handleDryRunPreflightError } from "./update-command-dry-run.js";
import type { ManagedServiceRootRedirect } from "./update-command-service-plan.js";

/** Record validation, then inspect package admission or Git previews before mutation. */
export async function preflightUpdateCommandSchemas(params: {
  root: string;
  updateInstallKind: "git" | "package" | "unknown";
  switchToGit: boolean;
  shouldRestart: boolean;
  updateStepTimeoutMs: number;
  invocationCwd?: string;
  managedServiceRootRedirect: ManagedServiceRootRedirect | null;
  channel: UpdateChannel;
  devTarget?: DevUpdateTarget;
  packageTargetSchemaVersions?: OpenClawSchemaVersions;
  packageTargetVersion?: string;
  packageInstallSpec?: string | null;
  opts: Pick<UpdateCommandOptions, "dryRun" | "json" | "run">;
  refuseUpdate: (reason: string, message?: string) => Promise<void>;
}): Promise<
  { packageSchemaPreflight: OpenClawDatabaseSchemaPreflight; preflightNotes: string[] } | undefined
> {
  const {
    root,
    updateInstallKind,
    switchToGit,
    shouldRestart,
    updateStepTimeoutMs,
    invocationCwd,
    managedServiceRootRedirect,
    channel,
    devTarget,
    packageTargetSchemaVersions,
    opts,
    refuseUpdate,
  } = params;
  const run = opts.run!;
  recordUpdateRunPhase(run.runId, "validating", undefined, { env: run.env });
  let packageSchemaPreflight: OpenClawDatabaseSchemaPreflight = {
    incompatible: [],
    indeterminate: [],
  };
  const preflightNotes: string[] = [];
  if ((opts.dryRun || updateInstallKind === "package") && updateInstallKind !== "unknown") {
    try {
      const { inspectUpdateDatabaseContexts } =
        await import("./update-command-database-context.js");
      const { inspectGitDryRunTargetSchemaVersions } = await import("./update-command-git.js");
      const admission = await inspectUpdateDatabaseContexts({
        roots: switchToGit ? [root, resolveGitInstallDir()] : [root],
        updateInstallKind,
        shouldRestart,
        jsonMode: Boolean(opts.json),
        timeoutMs: updateStepTimeoutMs,
        invocationCwd,
        managedServiceRootRedirect,
      });
      const target =
        updateInstallKind === "git"
          ? await inspectGitDryRunTargetSchemaVersions({
              root: switchToGit ? resolveGitInstallDir() : root,
              timeoutMs: updateStepTimeoutMs,
              channel,
              devTarget,
            })
          : { schemaVersions: packageTargetSchemaVersions };
      if ("metadataUnreadable" in target && target.metadataUnreadable) {
        throw new UpdatePreMutationError(
          "target-metadata-preflight",
          `Could not preview Git target schema support without changing the checkout: ${target.metadataUnreadable}`,
        );
      }
      packageSchemaPreflight = await checkTargetDatabaseSchemasForContexts(
        target.schemaVersions,
        admission.contexts,
      );
      if (opts.dryRun && updateInstallKind === "package") {
        if (
          params.packageInstallSpec &&
          !canResolveRegistryVersionForPackageTarget(params.packageInstallSpec)
        ) {
          preflightNotes.push(
            "Configured plugin availability will be checked against the staged package before rehearsal or activation; this preview does not stage the target.",
          );
        } else {
          const { preflightConfiguredNpmPluginTargets } =
            await import("./update-command-plugin-preflight.js");
          const context = admission.contexts.at(-1)!;
          await preflightConfiguredNpmPluginTargets({
            config: context.configSnapshot.sourceConfig,
            env: context.env,
            targetVersion: params.packageTargetVersion ?? null,
            channel,
            timeoutMs: updateStepTimeoutMs,
          });
        }
      }
    } catch (error) {
      if (!opts.dryRun) {
        if (error instanceof UpdatePreMutationError) {
          await refuseUpdate(error.reason, error.message);
          return undefined;
        }
        throw error;
      }
      packageSchemaPreflight = await handleDryRunPreflightError(
        error,
        preflightNotes,
        refuseUpdate,
      );
    }
  }
  if (!opts.dryRun && hasSchemaRefusal(packageSchemaPreflight)) {
    await refuseUpdate(
      "database-schema-preflight",
      formatSchemaRefusalLines(packageSchemaPreflight).join("\n"),
    );
    return undefined;
  }
  return { packageSchemaPreflight, preflightNotes };
}
