// Update failures and control-plane results share one reporting boundary.
import { theme } from "../../../packages/terminal-core/src/theme.js";
import type { EXTENDED_STABLE_TAG_UNSUPPORTED_REASON } from "../../infra/update-channels.js";
import type { ExtendedStableFailureReason } from "../../infra/update-check.js";
import {
  markControlPlaneUpdateRestartSentinelFailure,
  writeControlPlaneUpdateRestartSentinel,
  type ControlPlaneUpdateSentinelMetaFile,
} from "../../infra/update-control-plane-sentinel.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { printResult } from "./progress.js";
import type { UpdateCommandOptions } from "./shared.js";

export async function reportPreMutationUpdateFailure(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  reason:
    | ExtendedStableFailureReason
    | typeof EXTENDED_STABLE_TAG_UNSUPPORTED_REASON
    | "npm lifecycle policy preflight"
    | "unsupported-package-target";
  message?: string;
  opts: UpdateCommandOptions;
  controlPlaneUpdateSentinelMeta: ControlPlaneUpdateSentinelMetaFile["meta"] | null;
}): Promise<void> {
  const result: UpdateRunResult = {
    status: "error",
    mode: params.installKind === "git" ? "git" : "unknown",
    root: params.root,
    reason: params.reason,
    steps: [],
    durationMs: 0,
  };
  if (params.opts.dryRun !== true) {
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: params.controlPlaneUpdateSentinelMeta,
      result,
      jsonMode: Boolean(params.opts.json),
    });
  }
  if (params.message) {
    defaultRuntime.error(params.message);
  }
  printResult(result, params.opts);
  defaultRuntime.exit(1);
}

export async function writeControlPlaneUpdateRestartSentinelBestEffort(params: {
  meta: ControlPlaneUpdateSentinelMetaFile["meta"] | null;
  result: UpdateRunResult;
  jsonMode: boolean;
}): Promise<void> {
  if (!params.meta) {
    return;
  }
  try {
    await writeControlPlaneUpdateRestartSentinel({
      meta: params.meta,
      result: params.result,
    });
  } catch (err) {
    const message = `Failed to write update.run restart sentinel: ${String(err)}`;
    if (params.jsonMode) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(theme.warn(message));
    }
  }
}

export async function markControlPlaneUpdateRestartSentinelFailureBestEffort(params: {
  meta: ControlPlaneUpdateSentinelMetaFile["meta"] | null;
  reason: string;
  jsonMode: boolean;
}): Promise<void> {
  if (!params.meta) {
    return;
  }
  try {
    await markControlPlaneUpdateRestartSentinelFailure(params.reason);
  } catch (err) {
    const message = `Failed to mark update.run restart sentinel failed: ${String(err)}`;
    if (params.jsonMode) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(theme.warn(message));
    }
  }
}
