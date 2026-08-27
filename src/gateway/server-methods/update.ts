// Update gateway methods run self-update flows, report status, write restart
// sentinels, and hand off managed-service restarts when needed.
import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  validateUpdateHoldParams,
  validateUpdateHoldResult,
  validateUpdateRunParams,
  validateUpdateStatusParams,
  validateUpdateStatusResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { isRestartEnabled } from "../../config/commands.flags.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON,
  isGatewayExternallySupervised,
} from "../../infra/gateway-supervision.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { type RestartSentinelPayload, writeRestartSentinel } from "../../infra/restart-sentinel.js";
import {
  normalizeGatewayRestartDelayMs,
  resolveGatewayRestartDeferralTimeoutMs,
  scheduleGatewaySigusr1Restart,
} from "../../infra/restart.js";
import { detectRespawnSupervisor } from "../../infra/supervisor-markers.js";
import { gatewayUpdateCampaign } from "../../infra/update-campaign.js";
import {
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
} from "../../infra/update-channels.js";
import { CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON } from "../../infra/update-control-plane-sentinel.js";
import { devUpdateTargetFromGitTarget } from "../../infra/update-dev-target.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
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
  normalizeControlPlaneUpdateResult,
  type UpdateRestartSentinelMeta,
} from "../../infra/update-restart-sentinel-payload.js";
import {
  resolveUpdateInstallSurface,
  runGatewayUpdate,
  runGatewayUpdatePreflight,
} from "../../infra/update-runner.js";
import {
  getUpdateAvailable,
  getUpdateEffectiveChannel,
  getUpdateSchedule,
  initializeGatewayUpdateStatus,
  refreshGatewayUpdateStatus,
} from "../../infra/update-startup.js";
import { VERSION } from "../../version.js";
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

// Explicit callers share only active checkout work for the exact config snapshot.
// Reloaded config must never join work started under an older snapshot.
const updateStatusCheckoutRefreshes = new WeakMap<OpenClawConfig, Promise<void>>();

function refreshUpdateStatusCheckout(config: OpenClawConfig): Promise<void> {
  const current = updateStatusCheckoutRefreshes.get(config);
  if (current) {
    return current;
  }
  const refresh = refreshGatewayUpdateStatus(config).finally(() => {
    if (updateStatusCheckoutRefreshes.get(config) === refresh) {
      updateStatusCheckoutRefreshes.delete(config);
    }
  });
  updateStatusCheckoutRefreshes.set(config, refresh);
  return refresh;
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
    const config = context?.getRuntimeConfig?.();
    const configChannel = normalizeUpdateChannel(config?.update?.channel);
    if (params.refreshCheckout === true && config) {
      try {
        await refreshUpdateStatusCheckout(config);
      } catch (err) {
        context?.logGateway?.warn(
          `update.status checkout refresh failed: ${formatUpdateRunErrorMessage(err)}`,
        );
      }
    }
    const schedule = getUpdateSchedule();
    let effectiveChannel = configChannel ?? normalizeUpdateChannel(schedule?.channel);
    if (!effectiveChannel) {
      try {
        effectiveChannel = await getUpdateEffectiveChannel();
      } catch (err) {
        context?.logGateway?.warn(
          `update.status install identity failed: ${formatUpdateRunErrorMessage(err)}`,
        );
      }
    }
    const result = {
      sentinel,
      updateAvailable: getUpdateAvailable(),
      ...(effectiveChannel ? { effectiveChannel } : {}),
      ...(schedule ? { schedule } : {}),
    };
    if (!validateUpdateStatusResult(result)) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: "update status is temporarily unavailable",
      });
      return;
    }
    respond(true, result);
  },
  "update.hold": ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateUpdateHoldParams, "update.hold", respond)) {
      return;
    }
    const actor = resolveControlPlaneActor(client);
    const campaignBeforeHold = gatewayUpdateCampaign.getState();
    const ok = gatewayUpdateCampaign.hold();
    const schedule = getUpdateSchedule();
    if (ok) {
      const heldCampaign = gatewayUpdateCampaign.getState();
      context?.logGateway?.info(
        `update.hold granted ${formatControlPlaneActor(actor)} holdUntilMs=${heldCampaign?.holdUntilMs} forceAtMs=${heldCampaign?.forceAtMs}`,
      );
    } else {
      const reason = !campaignBeforeHold
        ? "no campaign"
        : campaignBeforeHold.state === "applying"
          ? "applying"
          : "already held";
      context?.logGateway?.info(`update.hold refused ${formatControlPlaneActor(actor)}`, {
        reason,
      });
    }
    const result = {
      ok,
      ...(schedule ? { schedule } : {}),
    };
    if (!validateUpdateHoldResult(result)) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: "update hold status is temporarily unavailable",
      });
      return;
    }
    respond(true, result);
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
      restartDelayMs: requestedRestartDelayMs,
    } = parseRestartRequestParams(params);
    const restartDelayMs = normalizeGatewayRestartDelayMs(requestedRestartDelayMs);
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
    let adoptedCampaignId: string | undefined;
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
      const { root, status } = await initializeGatewayUpdateStatus();
      const installSurface = await resolveUpdateInstallSurface({
        root,
        installKind: status.installKind,
        timeoutMs,
      });
      const installRoot = installSurface.root;
      const effectiveChannel = resolveEffectiveUpdateChannel({
        configChannel,
        currentVersion: VERSION,
        installKind: status.installKind,
        git: status.git,
      }).channel;
      const requestedTarget = params.target;
      const explicitDevTarget =
        isRecord(requestedTarget) &&
        requestedTarget.kind === "git" &&
        typeof requestedTarget.upstreamRef === "string" &&
        /^[^\s\p{Cc}]+$/u.test(requestedTarget.upstreamRef) &&
        typeof requestedTarget.upstreamSha === "string" &&
        /^[a-f\d]{40}$/iu.test(requestedTarget.upstreamSha)
          ? devUpdateTargetFromGitTarget({
              upstreamRef: requestedTarget.upstreamRef,
              upstreamSha: requestedTarget.upstreamSha,
            })
          : undefined;
      let targetFailureReason =
        requestedTarget !== undefined && !explicitDevTarget
          ? "invalid-update-target"
          : explicitDevTarget && (installSurface.kind !== "git" || effectiveChannel !== "dev")
            ? "unsupported-update-target"
            : explicitDevTarget && explicitDevTarget.upstreamRef !== status.git?.upstream
              ? "update-target-upstream-mismatch"
              : undefined;
      const adoption = targetFailureReason
        ? undefined
        : gatewayUpdateCampaign.adopt(explicitDevTarget);
      if (adoption?.status === "mismatch") {
        targetFailureReason = "update-target-campaign-mismatch";
      } else if (adoption?.status === "applying") {
        targetFailureReason = "update-campaign-applying";
      }
      const adoptedCampaign = adoption?.status === "adopted" ? adoption : undefined;
      adoptedCampaignId = adoptedCampaign?.campaignId;
      const adoptedDevTarget =
        adoptedCampaign?.target.kind === "git"
          ? devUpdateTargetFromGitTarget(adoptedCampaign.target)
          : undefined;
      const adoptedPackageTargetVersion =
        adoptedCampaign?.target.kind === "package"
          ? adoptedCampaign.target.version.trim() || undefined
          : undefined;
      if (adoptedCampaign) {
        context?.logGateway?.info(
          `update.run adopted campaign ${adoptedCampaign.campaignId} ${formatControlPlaneActor(actor)}`,
          { target: adoptedCampaign.target },
        );
      }
      const devTarget = explicitDevTarget ?? adoptedDevTarget;
      const supervisor = detectRespawnSupervisor(process.env, process.platform, {
        includeLinuxOpenClawGatewayServiceMarker: true,
      });
      const requiresManagedServiceHandoff =
        installSurface.kind === "global" || (installSurface.kind === "git" && supervisor !== null);
      const managedGitPreflightFailure =
        !targetFailureReason &&
        installSurface.kind === "git" &&
        effectiveChannel === "dev" &&
        supervisor &&
        !isGatewayExternallySupervised()
          ? await runGatewayUpdatePreflight(installRoot, timeoutMs, devTarget)
          : undefined;
      if (targetFailureReason) {
        result = {
          status: "error",
          mode: installSurface.mode,
          ...(installRoot ? { root: installRoot } : {}),
          reason: targetFailureReason,
          steps: [],
          durationMs: 0,
        };
      } else if (installSurface.kind === "missing") {
        result = {
          status: "error",
          mode: "unknown",
          reason: "not-openclaw-root",
          steps: [],
          durationMs: 0,
        };
      } else if (isGatewayExternallySupervised()) {
        const beforeVersion = await readPackageVersion(installSurface.root);
        result = {
          status: "skipped",
          mode: installSurface.mode,
          root: installSurface.root,
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
      } else if (managedGitPreflightFailure) {
        result = managedGitPreflightFailure;
      } else if (requiresManagedServiceHandoff) {
        if (!installRoot) {
          throw new Error("managed update install root is unavailable");
        }
        const handoffChannel =
          installSurface.kind === "git"
            ? undefined
            : effectiveChannel === "extended-stable"
              ? effectiveChannel
              : (configChannel ?? undefined);
        const command = formatManagedServiceUpdateCommand({
          timeoutMs,
          ...(handoffChannel ? { channel: handoffChannel } : {}),
          ...(adoptedPackageTargetVersion ? { tag: adoptedPackageTargetVersion } : {}),
        });
        if (supervisor) {
          try {
            const beforeVersion = await readPackageVersion(installRoot);
            const startedAt = Date.now();
            const handoffId = randomUUID();
            // systemd needs startup grace before the Gateway exits and its state becomes durable.
            const managedRestartDelayMs =
              supervisor === "systemd"
                ? Math.max(restartDelayMs, MANAGED_HANDOFF_RESTART_DELAY_MS)
                : restartDelayMs;
            sentinelMeta.handoffId = handoffId;
            sentinelMeta.root = resolveUpdateInstallRoot(installRoot);
            // Managed services update from a detached helper so the running
            // gateway does not replace its own package or git-built dist tree
            // while still serving RPCs.
            const started = await startManagedServiceUpdateHandoff({
              root: installRoot,
              timeoutMs,
              restartDrainTimeoutMs: resolveGatewayRestartDeferralTimeoutMs(),
              ...(handoffChannel ? { channel: handoffChannel } : {}),
              ...(adoptedPackageTargetVersion ? { tag: adoptedPackageTargetVersion } : {}),
              ...(devTarget ? { devTarget } : {}),
              restartDelayMs: managedRestartDelayMs,
              meta: sentinelMeta,
              handoffId,
              supervisor,
            });
            ownsManagedServiceHandoff = started.status === "started";
            sentinelMeta.handoffId = started.handoffId ?? handoffId;
            // The owner pairs helper creation with parent exit before any
            // persistence can fail. Joiners leave both to the active owner.
            if (started.status === "started") {
              handoff = {
                status: "started",
                ...(started.pid ? { pid: started.pid } : {}),
                command: started.command,
              };
              managedHandoffRestart = scheduleGatewaySigusr1Restart({
                delayMs: managedRestartDelayMs,
                reason: "update.run",
                successorOwner: {
                  kind: "managed-update-handoff",
                  handoffId: started.handoffId,
                  installRoot: started.installRoot,
                },
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
              root: installRoot,
              reason: ownsManagedServiceHandoff
                ? CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON
                : MANAGED_HANDOFF_ALREADY_RUNNING_REASON,
              ...(beforeVersion ? { before: { version: beforeVersion } } : {}),
              steps: ownsManagedServiceHandoff
                ? [
                    {
                      name: "managed-service update handoff",
                      command: started.command,
                      cwd: installRoot,
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
              root: installRoot,
              reason: "managed-service-handoff-failed",
              steps: [],
              durationMs: 0,
            };
          }
        } else {
          const beforeVersion = await readPackageVersion(installRoot);
          handoff = {
            status: "unavailable",
            command,
            message: buildManagedServiceHandoffUnavailableMessage(command),
          };
          result = {
            status: "skipped",
            mode: installSurface.mode,
            root: installRoot,
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
          cwd: installSurface.root,
          channel:
            installSurface.kind === "git"
              ? (configChannel ?? undefined)
              : effectiveChannel === "extended-stable"
                ? effectiveChannel
                : (configChannel ?? undefined),
          ...(adoptedPackageTargetVersion ? { tag: adoptedPackageTargetVersion } : {}),
          ...(devTarget ? { devTarget } : {}),
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

    result = normalizeControlPlaneUpdateResult(result);

    // A failed RPC owns the adopted campaign until it explicitly releases it;
    // only a started handoff may leave "applying" for the successor process.
    if (
      result.status !== "ok" &&
      handoff?.status !== "started" &&
      adoptedCampaignId !== undefined &&
      gatewayUpdateCampaign.getState()?.id === adoptedCampaignId
    ) {
      gatewayUpdateCampaign.clear();
      context?.logGateway?.info("update.run failed; adopted campaign cleared", {
        campaignId: adoptedCampaignId,
      });
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
