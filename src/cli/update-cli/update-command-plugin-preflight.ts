import { collectConfiguredNpmPluginTargets } from "../../commands/doctor/shared/missing-configured-plugin-install.targets.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveNpmSpecMetadata } from "../../infra/install-source-utils.js";
import { resolveRegistryUpdateChannel, type UpdateChannel } from "../../infra/update-channels.js";
import { resolveNpmInstallSpecsForUpdateChannel } from "../../plugins/install-channel-specs.js";
import { UpdatePreMutationError } from "./shared.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";

/** Admit configured npm targets without installing plugins or changing live state. */
export async function preflightConfiguredNpmPluginTargets(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  targetVersion: string | null;
  channel: UpdateChannel;
  timeoutMs: number;
}): Promise<void> {
  const failures: string[] = [];
  try {
    await withOwnedManagedUpdateEnv(params.env, async () => {
      const targets = await collectConfiguredNpmPluginTargets({
        config: params.config,
        env: params.env,
        targetVersion: params.targetVersion ?? "",
        channel: resolveRegistryUpdateChannel({
          configChannel: params.channel,
          currentVersion: params.targetVersion,
        }),
      });
      for (const target of targets) {
        if (!params.targetVersion) {
          failures.push(
            `Plugin "${target.pluginId}" (${target.spec}): cannot determine the required version because the target core version is unknown. Select an exact registry target.`,
          );
          continue;
        }
        let requiredSpec = target.spec;
        try {
          const selected = await resolveNpmInstallSpecsForUpdateChannel({
            ...target,
            timeoutMs: params.timeoutMs,
          });
          requiredSpec = selected.installSpec;
          const resolution = selected.npmResolution
            ? { ok: true as const, metadata: selected.npmResolution }
            : await resolveNpmSpecMetadata({ spec: requiredSpec, timeoutMs: params.timeoutMs });
          if (!resolution.ok) {
            failures.push(
              `Plugin "${target.pluginId}" requires ${requiredSpec} for core ${params.targetVersion}: ${resolution.error}`,
            );
          }
        } catch (error) {
          failures.push(
            `Plugin "${target.pluginId}" requires ${requiredSpec} for core ${params.targetVersion}: ${formatErrorMessage(error)}`,
          );
        }
      }
    });
  } catch (error) {
    failures.push(`Could not inspect configured npm plugins: ${formatErrorMessage(error)}`);
  }
  if (failures.length > 0) {
    throw new UpdatePreMutationError(
      "plugin-target-unavailable",
      [
        "Update refused: configured npm plugin targets are unavailable.",
        ...failures,
        "Retry after the packages or registry are available, use `openclaw update --tag <older-version>`, or disable the affected plugin and retry.",
        ...(params.channel === "extended-stable"
          ? ["Extended-stable does not accept --tag; retry later or explicitly switch channels."]
          : []),
      ].join("\n"),
    );
  }
}
