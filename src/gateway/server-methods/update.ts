// Update gateway methods run self-update flows, report status, write restart
// sentinels, and hand off managed-service restarts when needed.
import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  validateUpdateRunParams,
  validateUpdateStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { isRestartEnabled } from "../../config/commands.flags.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { type RestartSentinelPayload, writeRestartSentinel } from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { detectRespawnSupervisor } from "../../infra/supervisor-markers.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON } from "../../infra/update-control-plane-sentinel.js";
import {
  buildManagedServiceHandoffUnavailableMessage,
  formatManagedServiceUpdateCommand,
  startManagedServiceUpdateHandoff,
} from "../../infra/update-managed-service-handoff.js";
import {
  buildUpdateRestartSentinelPayload,
  type UpdateRestartSentinelMeta,
} from "../../infra/update-restart-sentinel-payload.js";
import { resolveUpdateInstallSurface, runGatewayUpdate } from "../../infra/update-runner.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "../control-plane-audit.js";
import {
  getLatestUpdateRestartSentinel,
  recordLatestUpdateRestartSentinel,
} from "../server-restart-sentinel.js";
import { parseRestartRequestParams } from "./restart-request.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const SYSTEMD_HANDOFF_RESTART_GRACE_MS = 2000;

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

function resolveManagedServiceHandoffRestartDelayMs(
  restartDelayMs: number | undefined,
  supervisor: ReturnType<typeof detectRespawnSupervisor>,
): number | undefined {
  if (supervisor !== "systemd") {
    return restartDelayMs;
  }
  // systemd needs a short grace period after the handoff process starts before
  // the gateway exits, otherwise the service can restart before handoff state is durable.
  return Math.max(
    restartDelayMs ?? SYSTEMD_HANDOFF_RESTART_GRACE_MS,
    SYSTEMD_HANDOFF_RESTART_GRACE_MS,
  );
}

export const updateHandlers: GatewayRequestHandlers = {
  "update.status": async ({ params, respond }) => {
    if (!assertValidParams(params, validateUpdateStatusParams, "update.status", respond)) {
      return;
    }
    respond(true, {
      sentinel: getLatestUpdateRestartSentinel(),
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
      | { status: "unavailable"; command: string; message: string }
      | null = null;
    const sentinelMeta: UpdateRestartSentinelMeta = {
      ...(sessionKey ? { sessionKey } : {}),
      ...(deliveryContext ? { deliveryContext } : {}),
      ...(threadId ? { threadId } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(continuationMessage !== undefined ? { continuationMessage } : {}),
    };
    let supervisor: ReturnType<typeof detectRespawnSupervisor> = null;
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
      supervisor = detectRespawnSupervisor(process.env, process.platform);
      if (!isRestartEnabled(config) && !supervisor) {
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
      } else if (installSurface.kind === "global") {
        const command = formatManagedServiceUpdateCommand({
          timeoutMs,
          channel: configChannel ?? undefined,
        });
        if (supervisor) {
          try {
            const startedAt = Date.now();
            const handoffId = randomUUID();
            sentinelMeta.handoffId = handoffId;
            // Managed services update from a detached helper so the running
            // gateway does not replace its own package while still serving RPCs.
            const started = await startManagedServiceUpdateHandoff({
              root,
              timeoutMs,
              channel: configChannel ?? undefined,
              restartDelayMs,
              meta: sentinelMeta,
              handoffId,
              supervisor,
            });
            handoff = {
              status: "started",
              ...(started.pid ? { pid: started.pid } : {}),
              command: started.command,
            };
            const beforeVersion = installSurface.root
              ? await readPackageVersion(installSurface.root)
              : null;
            result = {
              status: "skipped",
              mode: installSurface.mode,
              root: installSurface.root,
              reason: CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON,
              ...(beforeVersion ? { before: { version: beforeVersion } } : {}),
              steps: [
                {
                  name: "managed-service update handoff",
                  command: started.command,
                  cwd: root,
                  durationMs: Date.now() - startedAt,
                  exitCode: null,
                },
              ],
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
        result = await runGatewayUpdate({
          timeoutMs,
          cwd: root,
          argv1: process.argv[1],
          channel: configChannel ?? undefined,
        });
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

    let sentinelPath: string | null;
    try {
      sentinelPath = await writeRestartSentinel(payload);
      recordLatestUpdateRestartSentinel(payload);
    } catch {
      sentinelPath = null;
    }

    // Only restart the gateway when the update actually succeeded.
    // Restarting after a failed update leaves the process in a broken state
    // (corrupted node_modules, partial builds) and causes a crash loop.
    const updateWasPackageSwap = result.status === "ok" && result.mode !== "git";
    const restart =
      handoff?.status === "started" || result.status === "ok"
        ? scheduleGatewaySigusr1Restart({
            delayMs:
              handoff?.status === "started"
                ? resolveManagedServiceHandoffRestartDelayMs(restartDelayMs, supervisor)
                : updateWasPackageSwap
                  ? 0
                  : restartDelayMs,
            reason: "update.run",
            // Package swaps and managed handoffs should restart without waiting
            // for normal deferral/cooldown windows; the new code is already staged.
            skipDeferral: updateWasPackageSwap || handoff?.status === "started",
            skipCooldown: updateWasPackageSwap || handoff?.status === "started",
            audit: {
              actor: actor.actor,
              deviceId: actor.deviceId,
              clientIp: actor.clientIp,
              changedPaths: [],
            },
          })
        : null;
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
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
  },
};
