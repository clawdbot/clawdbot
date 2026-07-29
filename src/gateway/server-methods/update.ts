// Update gateway methods run self-update flows, report status, write restart
// sentinels, and hand off managed-service restarts when needed.
import { randomUUID } from "node:crypto";
import os from "node:os";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  validateUpdateRunParams,
  validateUpdateStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { isRestartEnabled } from "../../config/commands.flags.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GATEWAY_SERVICE_KIND, GATEWAY_SERVICE_MARKER } from "../../daemon/constants.js";
import {
  EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
  isGatewayExternallySupervised,
} from "../../infra/gateway-supervision.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { type RestartSentinelPayload, writeRestartSentinel } from "../../infra/restart-sentinel.js";
import {
  resolveGatewayRestartDeferralTimeoutMs,
  scheduleGatewaySigusr1Restart,
} from "../../infra/restart.js";
import { detectRespawnSupervisor } from "../../infra/supervisor-markers.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON } from "../../infra/update-control-plane-sentinel.js";
import {
  buildManagedServiceHandoffUnavailableMessage,
  formatManagedServiceUpdateCommand,
  startManagedServiceUpdateHandoff,
} from "../../infra/update-managed-service-handoff.js";
import type { PreUpdateConfigRestoreInput } from "../../infra/update-post-core-context.js";
import {
  foldPostCoreFinalizeIntoResult,
  runPostCoreFinalizeAfterGatewayUpdate,
} from "../../infra/update-post-core-finalize.js";
import {
  buildUpdateRestartSentinelPayload,
  type UpdateRestartSentinelMeta,
} from "../../infra/update-restart-sentinel-payload.js";
import { resolveUpdateInstallSurface, runGatewayUpdate } from "../../infra/update-runner.js";
import { getUpdateAvailable } from "../../infra/update-startup.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "../control-plane-audit.js";
import {
  getLatestUpdateRestartSentinel,
  recordLatestUpdateRestartSentinel,
  refreshLatestUpdateRestartSentinel,
} from "../server-restart-sentinel.js";
import { parseRestartRequestParams } from "./restart-request.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const MANAGED_HANDOFF_RESTART_DELAY_MS = 2000;
const MANAGED_HANDOFF_ALREADY_RUNNING_REASON = "managed-service-handoff-already-running";

function formatUpdateRunErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name;
  }
  return String(err);
}

function tryResolveProcessCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

async function readPreUpdateConfigForPostCoreFinalize(): Promise<
  PreUpdateConfigRestoreInput | undefined
> {
  const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
  if (!snapshot.valid) {
    return undefined;
  }
  return {
    sourceConfig: snapshot.sourceConfig,
    authoredConfig: isRecord(snapshot.parsed)
      ? (snapshot.parsed as OpenClawConfig)
      : snapshot.sourceConfig,
  };
}

function resolveManagedServiceHandoffRestartDelayMs(
  restartDelayMs: number | undefined,
  supervisor: ReturnType<typeof detectRespawnSupervisor>,
): number {
  const resolvedDelayMs = restartDelayMs ?? MANAGED_HANDOFF_RESTART_DELAY_MS;
  if (supervisor !== "systemd") {
    return resolvedDelayMs;
  }
  // systemd needs a short grace period after the handoff process starts before
  // the gateway exits, otherwise the service can restart before handoff state is durable.
  return Math.max(resolvedDelayMs, MANAGED_HANDOFF_RESTART_DELAY_MS);
}

function hasManagedServiceHandoffContext(
  env: NodeJS.ProcessEnv,
  supervisor: ReturnType<typeof detectRespawnSupervisor>,
): boolean {
  if (supervisor === "launchd") {
    return Boolean(
      env.OPENCLAW_LAUNCHD_LABEL?.trim() ||
      env.LAUNCH_JOB_LABEL?.trim() ||
      env.LAUNCH_JOB_NAME?.trim() ||
      env.XPC_SERVICE_NAME?.trim(),
    );
  }
  if (supervisor === "systemd") {
    // Ambient systemd markers only prove that a service manager started this
    // process. The detached CLI needs the durable unit name to stop the same
    // gateway before mutating the install root.
    return Boolean(env.OPENCLAW_SYSTEMD_UNIT?.trim());
  }
  if (supervisor === "schtasks") {
    return Boolean(
      env.OPENCLAW_WINDOWS_TASK_NAME?.trim() ||
      (env.OPENCLAW_SERVICE_MARKER?.trim() === GATEWAY_SERVICE_MARKER &&
        env.OPENCLAW_SERVICE_KIND?.trim() === GATEWAY_SERVICE_KIND),
    );
  }
  return false;
}

export const updateHandlers: GatewayRequestHandlers = {
  "update.status": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateUpdateStatusParams, "update.status", respond)) {
      return;
    }
    let sentinel: RestartSentinelPayload | null;
    try {
      sentinel = await refreshLatestUpdateRestartSentinel();
    } catch (err) {
      context?.logGateway?.warn(
        `update.status sentinel refresh failed: ${formatUpdateRunErrorMessage(err)}`,
      );
      sentinel = getLatestUpdateRestartSentinel();
    }
    respond(true, {
      sentinel,
      updateAvailable: getUpdateAvailable(),
    });
  },
  "update.run": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateUpdateRunParams, "update.run", respond)) {
      return;
    }
    const actor = resolveControlPlaneActor(client);
    const {
      sessionKey,
      deliveryContext: requestedDeliveryContext,
      threadId: requestedThreadId,
      note,
      continuationMessage,
      restartDelayMs,
    } = parseRestartRequestParams(params);
    const { deliveryContext: sessionDeliveryContext, threadId: sessionThreadId } =
      extractDeliveryInfo(sessionKey);
    const deliveryContext = requestedDeliveryContext ?? sessionDeliveryContext;
    const threadId = requestedThreadId ?? sessionThreadId;
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs =
      typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw)
        ? Math.max(1000, Math.floor(timeoutMsRaw))
        : undefined;

    let result: Awaited<ReturnType<typeof runGatewayUpdate>>;
    let handoff:
      | { status: "started"; pid?: number; command: string }
      | { status: "already-running"; command: string; message: string }
      | { status: "unavailable"; command: string; message: string }
      | null = null;
    let managedHandoffRestart: ReturnType<typeof scheduleGatewaySigusr1Restart> | null = null;
    let ownsManagedServiceHandoff = true;
    const sentinelMeta: UpdateRestartSentinelMeta = {
      ...(sessionKey ? { sessionKey } : {}),
      ...(deliveryContext ? { deliveryContext } : {}),
      ...(threadId ? { threadId } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(continuationMessage !== undefined ? { continuationMessage } : {}),
    };
    try {
      const config = context.getRuntimeConfig();
      const configChannel = normalizeUpdateChannel(config.update?.channel);
      const invocationCwd = tryResolveProcessCwd();
      const root =
        (await resolveOpenClawPackageRoot({
          moduleUrl: import.meta.url,
          argv1: process.argv[1],
          ...(invocationCwd ? { cwd: invocationCwd } : {}),
        })) ??
        invocationCwd ??
        os.homedir();
      const installSurface = await resolveUpdateInstallSurface({
        timeoutMs,
        cwd: root,
        argv1: process.argv[1],
      });
      const supervisor = detectRespawnSupervisor(process.env, process.platform);
      const hasHandoffContext = supervisor
        ? hasManagedServiceHandoffContext(process.env, supervisor)
        : false;
      const requiresManagedServiceHandoff =
        installSurface.kind === "global" || (installSurface.kind === "git" && supervisor !== null);
      if (isGatewayExternallySupervised()) {
        const beforeVersion = installSurface.root
          ? await readPackageVersion(installSurface.root)
          : null;
        result = {
          status: "skipped",
          mode: installSurface.mode,
          ...(installSurface.root ? { root: installSurface.root } : {}),
          reason: EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
          ...(beforeVersion ? { before: { version: beforeVersion } } : {}),
          steps: [],
          durationMs: 0,
        };
      } else if (configChannel === "extended-stable" && installSurface.kind === "git") {
        result = {
          status: "error",
          mode: "git",
          root: installSurface.root,
          reason: "unsupported_git_channel",
          steps: [],
          durationMs: 0,
        };
      } else if (!isRestartEnabled(config) && !supervisor) {
        // Package updates need a restart path to finish safely. Dev/git installs
        // can report the disabled restart directly, but global installs must not
        // mutate files if this process cannot come back.
        const beforeVersion = installSurface.root
          ? await readPackageVersion(installSurface.root)
          : null;
        result = {
          status: "skipped",
          mode: installSurface.mode,
          ...(installSurface.root ? { root: installSurface.root } : {}),
          reason: installSurface.kind === "global" ? "restart-unavailable" : "restart-disabled",
          ...(beforeVersion ? { before: { version: beforeVersion } } : {}),
          steps: [],
          durationMs: 0,
        };
      } else if (requiresManagedServiceHandoff) {
        const handoffChannel =
          installSurface.kind === "git" ? undefined : (configChannel ?? undefined);
        const command = formatManagedServiceUpdateCommand({
          timeoutMs,
          ...(handoffChannel ? { channel: handoffChannel } : {}),
        });
        if (supervisor && hasHandoffContext) {
          try {
            const beforeVersion = installSurface.root
              ? await readPackageVersion(installSurface.root)
              : null;
            const startedAt = Date.now();
            const handoffId = randomUUID();
            const managedRestartDelayMs = resolveManagedServiceHandoffRestartDelayMs(
              restartDelayMs,
              supervisor,
            );
            sentinelMeta.handoffId = handoffId;
            // Managed services update from a detached helper so the running
            // gateway does not replace its own package or git-built dist tree
            // while still serving RPCs.
            const started = await startManagedServiceUpdateHandoff({
              root,
              timeoutMs,
              restartDrainTimeoutMs: resolveGatewayRestartDeferralTimeoutMs(),
              ...(handoffChannel ? { channel: handoffChannel } : {}),
              restartDelayMs: managedRestartDelayMs,
              meta: sentinelMeta,
              handoffId,
              supervisor,
            });
            ownsManagedServiceHandoff = started.status === "started";
            sentinelMeta.handoffId = started.handoffId ?? handoffId;
            // The owner pairs helper creation with parent exit before any
            // persistence can fail. Joiners leave both to the active owner.
            if (ownsManagedServiceHandoff) {
              handoff = {
                status: "started",
                ...(started.pid ? { pid: started.pid } : {}),
                command: started.command,
              };
              managedHandoffRestart = scheduleGatewaySigusr1Restart({
                delayMs: managedRestartDelayMs,
                reason: "update.run",
                skipDeferral: true,
                skipCooldown: true,
                audit: {
                  actor: actor.actor,
                  deviceId: actor.deviceId,
                  clientIp: actor.clientIp,
                  changedPaths: [],
                },
              });
            } else {
              // A restart sentinel has one continuation owner. Reject this RPC
              // instead of accepting metadata that the active handoff cannot persist.
              handoff = {
                status: "already-running",
                command: started.command,
                message: "Another managed update is already running; retry after it completes.",
              };
            }
            result = {
              status: "skipped",
              mode: installSurface.mode,
              root: installSurface.root,
              reason: ownsManagedServiceHandoff
                ? CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON
                : MANAGED_HANDOFF_ALREADY_RUNNING_REASON,
              ...(beforeVersion ? { before: { version: beforeVersion } } : {}),
              steps: ownsManagedServiceHandoff
                ? [
                    {
                      name: "managed-service update handoff",
                      command: started.command,
                      cwd: root,
                      durationMs: Date.now() - startedAt,
                      exitCode: null,
                    },
                  ]
                : [],
              durationMs: Date.now() - startedAt,
            };
          } catch (err) {
            context?.logGateway?.warn(
              `update.run managed-service handoff failed ${formatControlPlaneActor(actor)} error=${formatUpdateRunErrorMessage(err)}`,
            );
            result = {
              status: "error",
              mode: installSurface.mode,
              root: installSurface.root,
              reason: "managed-service-handoff-failed",
              steps: [],
              durationMs: 0,
            };
          }
        } else {
          const beforeVersion = installSurface.root
            ? await readPackageVersion(installSurface.root)
            : null;
          handoff = {
            status: "unavailable",
            command,
            message: buildManagedServiceHandoffUnavailableMessage(command),
          };
          result = {
            status: "skipped",
            mode: installSurface.mode,
            root: installSurface.root,
            reason: "managed-service-handoff-unavailable",
            ...(beforeVersion ? { before: { version: beforeVersion } } : {}),
            steps: [],
            durationMs: 0,
          };
        }
      } else {
        const preUpdateConfig =
          installSurface.kind === "git"
            ? await readPreUpdateConfigForPostCoreFinalize().catch((err: unknown) => {
                context?.logGateway?.warn(
                  `update.run could not capture pre-update config ${formatControlPlaneActor(actor)} error=${formatUpdateRunErrorMessage(err)}`,
                );
                return undefined;
              })
            : undefined;
        // Supervised Windows gateways, including Startup-folder fallbacks, take
        // the detached handoff above. This direct path is unsupervised, so keep
        // doctor service mutation disabled: it could rewrite or terminate the
        // RPC server before the response and restart sentinel become durable.
        result = await runGatewayUpdate({
          timeoutMs,
          cwd: root,
          argv1: process.argv[1],
          channel: configChannel ?? undefined,
          allowGatewayServiceRepair: false,
          allowGatewayActivation: false,
        });
        // The CLI `openclaw update` resumes post-core plugin convergence after a
        // git/source core update; the RPC path did not, leaving official managed
        // plugins stale on the new core. Run the finalizer here to match.
        const finalizeOutcome = await runPostCoreFinalizeAfterGatewayUpdate({
          result,
          channel: configChannel ?? undefined,
          serviceRepairPolicy: "external",
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(preUpdateConfig ? { preUpdateConfig } : {}),
        });
        if (finalizeOutcome.status === "error") {
          context?.logGateway?.warn(
            `update.run post-core plugin finalize failed ${formatControlPlaneActor(actor)} reason=${finalizeOutcome.reason}`,
          );
        }
        result = foldPostCoreFinalizeIntoResult(result, finalizeOutcome);
      }
    } catch {
      result = {
        status: "error",
        mode: "unknown",
        reason: "unexpected-error",
        steps: [],
        durationMs: 0,
      };
    }

    const payload: RestartSentinelPayload = buildUpdateRestartSentinelPayload({
      result,
      meta: sentinelMeta,
    });

    let sentinelPersisted = false;
    if (ownsManagedServiceHandoff) {
      try {
        await writeRestartSentinel(payload);
        sentinelPersisted = true;
        recordLatestUpdateRestartSentinel(payload);
      } catch {
        // Best effort: the response still reports the update outcome.
      }
    }

    // Only restart the gateway when the update actually succeeded.
    // Restarting after a failed update leaves the process in a broken state
    // (corrupted node_modules, partial builds) and causes a crash loop.
    const updateWasPackageSwap = result.status === "ok" && result.mode !== "git";
    const restart =
      managedHandoffRestart ??
      (result.status === "ok"
        ? scheduleGatewaySigusr1Restart({
            delayMs: updateWasPackageSwap ? 0 : restartDelayMs,
            reason: "update.run",
            // Package swaps should restart without waiting for normal
            // deferral/cooldown windows; the new code is already staged.
            skipDeferral: updateWasPackageSwap,
            skipCooldown: updateWasPackageSwap,
            audit: {
              actor: actor.actor,
              deviceId: actor.deviceId,
              clientIp: actor.clientIp,
              changedPaths: [],
            },
          })
        : null);
    context?.logGateway?.info(
      `update.run completed ${formatControlPlaneActor(actor)} changedPaths=<n/a> restartReason=update.run status=${result.status}`,
    );
    if (restart?.coalesced) {
      context?.logGateway?.warn(
        `update.run restart coalesced ${formatControlPlaneActor(actor)} delayMs=${restart.delayMs}`,
      );
    }

    respond(
      true,
      {
        ok: result.status === "ok" || handoff?.status === "started",
        result,
        ...(handoff ? { handoff } : {}),
        restart,
        sentinel: {
          persisted: sentinelPersisted,
          payload,
        },
      },
      undefined,
    );
  },
};
