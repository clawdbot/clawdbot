// Resume post-core plugin convergence after a gateway control-plane git/source
// update.
//
// `runGatewayUpdate` (git mode) runs `openclaw doctor --fix` with
// `OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE=1`, which makes the doctor
// pass DEFER configured-plugin repair to a later convergence step (see
// `shouldDeferConfiguredPluginInstallRepair`). The `openclaw update` CLI resumes
// that deferred work in a fresh post-core process; the gateway `update.run` RPC
// did not, so a git/source core update would restart on the new core with stale
// official plugins still pinned to versions built against removed core APIs.
//
// This helper closes that CLI/RPC asymmetry by spawning the freshly-built
// binary's hidden `openclaw update finalize` entrypoint — the designed
// "external core runtime change" finalizer that runs doctor plus
// `updatePluginsAfterCoreUpdate` (which calls
// `updateNpmInstalledPlugins({ syncOfficialPluginInstalls: true, disableOnFailure: true })`
// and `runPostCorePluginConvergence`). Finalization never restarts, so the RPC
// handler keeps ownership of the gateway restart.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GATEWAY_SERVICE_RUNTIME_PID_ENV } from "../daemon/constants.js";
import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { trimLogTail } from "./restart-sentinel.js";
import { resolveStableNodePath } from "./stable-node-path.js";
import {
  DEFAULT_GIT_CHANNEL,
  type UpdateChannel,
  UPDATE_EFFECTIVE_CHANNEL_ENV,
} from "./update-channels.js";
import {
  POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV,
  type PreUpdateConfigRestoreInput,
} from "./update-post-core-context.js";
import type { UpdateRunResult } from "./update-runner.js";

// Whole-process backstop for the finalizer. `update finalize` runs several timed
// steps (doctor + plugin update/convergence), each bounded by its own per-step
// `--timeout`. The outer process kill must therefore be larger than a single
// per-step bound, or a valid multi-step run would be killed and falsely reported
// as `post-core-plugin-finalize-failed` (blocking the restart). We use a generous
// floor and, when a larger per-step timeout is requested, scale the outer bound
// above it rather than reusing the per-step value as the whole-process kill.
const FINALIZE_PROCESS_TIMEOUT_FLOOR_MS = 30 * 60_000;
const FINALIZE_PROCESS_STEP_BUDGET_MULTIPLIER = 6;

// Strip the running gateway's service identity from the finalizer child so it is
// not mistaken for the managed service process (matches the CLI post-core spawn).
// Also carry the effective update channel so convergence runs on the channel the
// core update actually used (git/dev for an unconfigured source update) — passed
// as the *effective* channel, never a *requested* one, so `update finalize` does
// not persist `update.channel`.
function buildFinalizeEnv(
  baseEnv: NodeJS.ProcessEnv,
  effectiveChannel: UpdateChannel,
  compatHostVersion?: string,
  sourceConfigPath?: string,
  serviceRepairPolicy?: "external",
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  delete env.OPENCLAW_SERVICE_MARKER;
  delete env.OPENCLAW_SERVICE_KIND;
  delete env[GATEWAY_SERVICE_RUNTIME_PID_ENV];
  env[UPDATE_EFFECTIVE_CHANNEL_ENV] = effectiveChannel;
  if (compatHostVersion) {
    env.OPENCLAW_COMPATIBILITY_HOST_VERSION = compatHostVersion;
  }
  if (sourceConfigPath) {
    env[POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV] = sourceConfigPath;
  }
  if (serviceRepairPolicy) {
    env.OPENCLAW_SERVICE_REPAIR_POLICY = serviceRepairPolicy;
  }
  return env;
}

type PostCoreFinalizeOutcome =
  | { status: "skipped"; reason: "not-git-update" | "entrypoint-missing" }
  | { status: "ok"; entrypoint: string }
  | {
      status: "error";
      reason: "nonzero-exit" | "spawn-failed";
      entrypoint: string;
      exitCode?: number;
      message?: string;
    };

type FinalizeSpawnResult = { code: number | null; stderr?: string };

type PostCoreFinalizeSpawner = (params: {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}) => Promise<FinalizeSpawnResult>;

const defaultFinalizeSpawner: PostCoreFinalizeSpawner = async ({ argv, cwd, timeoutMs, env }) => {
  const res = await runCommandWithTimeout(argv, { cwd, timeoutMs, env });
  return { code: res.code, ...(res.stderr ? { stderr: res.stderr } : {}) };
};

// Only git/source updates routed through `runGatewayUpdate` defer-and-drop
// plugin convergence. Package-manager/global installs already converge because
// the RPC routes them through `startManagedServiceUpdateHandoff`, which
// re-enters the full `openclaw update` CLI. Re-run convergence on no-op retries:
// an earlier finalizer failure must not be bypassed by a same-SHA update that
// would otherwise restart the gateway with stale plugins.
function isGitUpdateNeedingFinalize(
  result: UpdateRunResult,
): result is UpdateRunResult & { root: string } {
  return (
    result.status === "ok" &&
    result.mode === "git" &&
    typeof result.root === "string" &&
    result.root.length > 0
  );
}

function buildFinalizeArgv(params: {
  nodePath: string;
  entrypoint: string;
  timeoutMs?: number;
}): string[] {
  // No `--channel`: the effective channel is passed via env (convergence-only,
  // not persisted). `update finalize` would persist any `--channel` it sees.
  const argv = [
    params.nodePath,
    params.entrypoint,
    "update",
    "finalize",
    "--json",
    "--yes",
    "--no-restart",
  ];
  if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) {
    // `update finalize --timeout` is per-step seconds.
    argv.push("--timeout", String(Math.max(1, Math.ceil(params.timeoutMs / 1000))));
  }
  return argv;
}

export async function runPostCoreFinalizeAfterGatewayUpdate(params: {
  result: UpdateRunResult;
  channel?: UpdateChannel;
  timeoutMs?: number;
  preUpdateConfig?: PreUpdateConfigRestoreInput;
  serviceRepairPolicy?: "external";
  resolveEntrypoint?: (root: string) => Promise<string | undefined>;
  spawnFinalize?: PostCoreFinalizeSpawner;
  env?: NodeJS.ProcessEnv;
}): Promise<PostCoreFinalizeOutcome> {
  const { result } = params;
  if (!isGitUpdateNeedingFinalize(result)) {
    return { status: "skipped", reason: "not-git-update" };
  }
  const resolveEntrypoint = params.resolveEntrypoint ?? resolveGatewayInstallEntrypoint;
  const entrypoint = await resolveEntrypoint(result.root);
  if (!entrypoint) {
    return { status: "skipped", reason: "entrypoint-missing" };
  }

  const spawnFinalize = params.spawnFinalize ?? defaultFinalizeSpawner;
  const perStepTimeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? params.timeoutMs
      : undefined;
  // This helper only runs for git/source updates, where `runGatewayUpdate` ran
  // the core update on `configChannel ?? DEFAULT_GIT_CHANNEL` (dev). Carry that
  // same effective channel into the finalizer so plugin convergence matches the
  // core update instead of falling back to the package (stable) channel. It is
  // passed via env as the *effective* (not requested) channel, so the finalizer
  // does not persist `update.channel` when the user never configured one.
  const effectiveChannel: UpdateChannel = params.channel ?? DEFAULT_GIT_CHANNEL;
  const nodePath = await resolveStableNodePath(process.execPath);
  const argv = buildFinalizeArgv({
    nodePath,
    entrypoint,
    ...(perStepTimeoutMs === undefined ? {} : { timeoutMs: perStepTimeoutMs }),
  });
  // Pin the finalizer's host-compat resolution to the just-installed core
  // version so plugins reconcile against the new core, not the running process.
  const compatHostVersion = result.after?.version ?? undefined;
  // Outer whole-process backstop, decoupled from the per-step `--timeout` above.
  const processTimeoutMs = Math.max(
    FINALIZE_PROCESS_TIMEOUT_FLOOR_MS,
    (perStepTimeoutMs ?? 0) * FINALIZE_PROCESS_STEP_BUDGET_MULTIPLIER,
  );

  let sourceConfigDir: string | undefined;
  try {
    let sourceConfigPath: string | undefined;
    if (params.preUpdateConfig) {
      sourceConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-post-core-"));
      sourceConfigPath = path.join(sourceConfigDir, "source-config.json");
      await fs.writeFile(sourceConfigPath, `${JSON.stringify(params.preUpdateConfig)}\n`, "utf-8");
    }
    const env = buildFinalizeEnv(
      params.env ?? process.env,
      effectiveChannel,
      compatHostVersion,
      sourceConfigPath,
      params.serviceRepairPolicy,
    );
    const spawnResult = await spawnFinalize({
      argv,
      cwd: path.dirname(entrypoint),
      timeoutMs: processTimeoutMs,
      env,
    });
    if (spawnResult.code === 0) {
      return { status: "ok", entrypoint };
    }
    return {
      status: "error",
      reason: "nonzero-exit",
      entrypoint,
      ...(typeof spawnResult.code === "number" ? { exitCode: spawnResult.code } : {}),
      ...(spawnResult.stderr ? { message: spawnResult.stderr } : {}),
    };
  } catch (err) {
    return {
      status: "error",
      reason: "spawn-failed",
      entrypoint,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (sourceConfigDir) {
      await fs.rm(sourceConfigDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

// Fold a finalize failure into the update result so the RPC handler's existing
// `result.status === "ok"` restart gate skips the restart: restarting on the new
// core after convergence failed would load the stale plugins we just failed to
// reconcile. Mirrors the CLI, which exits non-zero before restarting on
// post-core convergence failure.
export function foldPostCoreFinalizeIntoResult(
  result: UpdateRunResult,
  outcome: PostCoreFinalizeOutcome,
): UpdateRunResult {
  if (outcome.status !== "error") {
    return result;
  }
  return {
    ...result,
    status: "error",
    reason: "post-core-plugin-finalize-failed",
    steps: [
      ...result.steps,
      {
        name: "post-core plugin finalize",
        command: "openclaw update finalize",
        cwd: result.root ?? process.cwd(),
        durationMs: 0,
        exitCode: outcome.reason === "nonzero-exit" ? (outcome.exitCode ?? 1) : 1,
        ...(outcome.message ? { stderrTail: trimLogTail(outcome.message) } : {}),
      },
    ],
  };
}
