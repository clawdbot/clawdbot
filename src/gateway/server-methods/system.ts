// System gateway methods expose device and host identity, heartbeat controls,
// presence snapshots, and normalized system events.
import os from "node:os";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SystemInfoResult,
  validateSystemInfoParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { validateSystemEventParams } from "../../../packages/gateway-protocol/src/schema.js";
import { listAgentIds } from "../../agents/agent-scope.js";
import { resolveGatewayPort, resolveStateDir } from "../../config/paths.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import { resolveAdvertisedLanHost } from "../../infra/advertised-lan-host.js";
import {
  loadOrCreateProcessDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../../infra/device-identity.js";
import { tryReadDiskSpace } from "../../infra/disk-space.js";
import { getLastHeartbeatEvent } from "../../infra/heartbeat-events.js";
import { setHeartbeatsEnabled } from "../../infra/heartbeat-runner.js";
import { requestHeartbeat } from "../../infra/heartbeat-wake.js";
import { getMachineDisplayName } from "../../infra/machine-name.js";
import { resolveRuntimeOsLabel } from "../../infra/os-summary.js";
import { enqueueSystemEvent, isSystemEventContextChanged } from "../../infra/system-events.js";
import { listSystemPresence, updateSystemPresence } from "../../infra/system-presence.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
import { broadcastPresenceSnapshot } from "../server/presence-events.js";
import { loadGatewaySessionRow } from "../session-utils.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

let advertisedLanHostPromise: Promise<string | null> | null = null;

function resolveCachedAdvertisedLanHost(): Promise<string | null> {
  // Route discovery may spawn a platform command. Keep the result process-stable
  // so each visible Settings page does not repeat that work every ten seconds.
  advertisedLanHostPromise ??= resolveAdvertisedLanHost().catch(() => null);
  return advertisedLanHostPromise;
}

async function collectSystemInfo(context: GatewayRequestContext): Promise<SystemInfoResult> {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model.trim() || undefined;
  const [oneMinute = 0, fiveMinutes = 0, fifteenMinutes = 0] = os.loadavg();
  const loadAverage: [number, number, number] = [oneMinute, fiveMinutes, fifteenMinutes];
  const stateDir = resolveStateDir();
  const disk = tryReadDiskSpace(stateDir);
  const port = resolveGatewayPort(context.getRuntimeConfig());
  const lanAddress = (await resolveCachedAdvertisedLanHost()) ?? undefined;

  return {
    machineName: await getMachineDisplayName(),
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    osLabel: resolveRuntimeOsLabel(),
    ...(lanAddress ? { lanAddress } : {}),
    port,
    nodeVersion: process.version,
    pid: process.pid,
    processInstanceId: getGatewayProcessInstanceId(),
    uptimeMs: Math.round(process.uptime() * 1000),
    cpuCount: cpus.length,
    ...(cpuModel ? { cpuModel } : {}),
    ...(loadAverage.some((value) => value !== 0) ? { loadAverage } : {}),
    memoryTotalBytes: os.totalmem(),
    memoryFreeBytes: os.freemem(),
    ...(disk?.totalBytes != null
      ? {
          diskTotalBytes: disk.totalBytes,
          diskAvailableBytes: disk.availableBytes,
          diskPath: stateDir,
        }
      : {}),
  };
}

/** Gateway handlers for identity, host information, heartbeat toggles, and presence events. */
export const systemHandlers: GatewayRequestHandlers = {
  "gateway.identity.get": ({ respond }) => {
    const identity = loadOrCreateProcessDeviceIdentity();
    respond(
      true,
      {
        deviceId: identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      },
      undefined,
    );
  },
  "last-heartbeat": ({ respond }) => {
    respond(true, getLastHeartbeatEvent(), undefined);
  },
  "set-heartbeats": ({ params, respond }) => {
    const enabled = params.enabled;
    if (typeof enabled !== "boolean") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "invalid set-heartbeats params: enabled (boolean) required",
        ),
      );
      return;
    }
    setHeartbeatsEnabled(enabled);
    respond(true, { ok: true, enabled }, undefined);
  },
  "system-presence": ({ respond }) => {
    const presence = listSystemPresence();
    respond(true, presence, undefined);
  },
  "system.info": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSystemInfoParams, "system.info", respond)) {
      return;
    }
    respond(true, await collectSystemInfo(context), undefined);
  },
  "system-event": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSystemEventParams, "system-event", respond)) {
      return;
    }
    // `system-event` is operator.admin-only; role policy rejects node connections before dispatch.
    // Payload classification below selects behavior and is never an authorization boundary.
    const text = normalizeOptionalString(params.text) ?? "";
    if (!text) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "text required"));
      return;
    }
    const requestedSessionKey = normalizeOptionalString(params.sessionKey);
    const sessionKey = requestedSessionKey ?? resolveMainSessionKeyFromConfig();
    const wake = params.wake === true;
    const isNodePresenceLine = text.startsWith("Node:");
    if (wake && isNodePresenceLine) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "wake is not supported for node presence events"),
      );
      return;
    }
    if (wake && requestedSessionKey) {
      const targetAgentId = normalizeAgentId(resolveAgentIdFromSessionKey(requestedSessionKey));
      const configuredAgentIds = listAgentIds(context.getRuntimeConfig()).map(normalizeAgentId);
      if (!configuredAgentIds.includes(targetAgentId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${targetAgentId}"`),
        );
        return;
      }
      // A targeted wake starts a model run. Require a live persisted session
      // so malformed keys cannot create phantom work under agent defaults.
      const targetSession = loadGatewaySessionRow(requestedSessionKey, { agentId: targetAgentId });
      if (!targetSession || targetSession.archived) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Unknown or archived session "${requestedSessionKey}"`,
          ),
        );
        return;
      }
    }
    const deviceId = readStringValue(params.deviceId);
    const instanceId = readStringValue(params.instanceId);
    const host = readStringValue(params.host);
    const ip = readStringValue(params.ip);
    const mode = readStringValue(params.mode);
    const version = readStringValue(params.version);
    const platform = readStringValue(params.platform);
    const deviceFamily = readStringValue(params.deviceFamily);
    const modelIdentifier = readStringValue(params.modelIdentifier);
    const lastInputSeconds =
      typeof params.lastInputSeconds === "number" && Number.isFinite(params.lastInputSeconds)
        ? params.lastInputSeconds
        : undefined;
    const reason = readStringValue(params.reason);
    const roles =
      Array.isArray(params.roles) && params.roles.every((t) => typeof t === "string")
        ? params.roles
        : undefined;
    const scopes =
      Array.isArray(params.scopes) && params.scopes.every((t) => typeof t === "string")
        ? params.scopes
        : undefined;
    const tags =
      Array.isArray(params.tags) && params.tags.every((t) => typeof t === "string")
        ? params.tags
        : undefined;
    const presenceUpdate = updateSystemPresence({
      text,
      deviceId,
      instanceId,
      host,
      ip,
      mode,
      version,
      platform,
      deviceFamily,
      modelIdentifier,
      lastInputSeconds,
      reason,
      roles,
      scopes,
      tags,
    });
    if (isNodePresenceLine) {
      // Node presence heartbeats are noisy; only enqueue user-visible system
      // events when routing context or meaningful node metadata changes.
      const next = presenceUpdate.next;
      const changed = new Set(presenceUpdate.changedKeys);
      const reasonValue = next.reason ?? reason;
      const normalizedReason = normalizeLowercaseStringOrEmpty(reasonValue);
      const ignoreReason =
        normalizedReason.startsWith("periodic") ||
        normalizedReason === "heartbeat" ||
        normalizedReason === "connect" ||
        normalizedReason === "launch" ||
        normalizedReason === "instances-refresh";
      const hostChanged = changed.has("host");
      const ipChanged = changed.has("ip");
      const versionChanged = changed.has("version");
      const modeChanged = changed.has("mode");
      const reasonChanged = changed.has("reason") && !ignoreReason;
      const hasChanges = hostChanged || ipChanged || versionChanged || modeChanged || reasonChanged;
      if (hasChanges) {
        const contextChanged = isSystemEventContextChanged(sessionKey, presenceUpdate.key);
        const parts: string[] = [];
        // Re-state node identity only when the line would otherwise lose
        // routing context or the host/IP changed.
        if (contextChanged || hostChanged || ipChanged) {
          const hostLabel = normalizeOptionalString(next.host) ?? "Unknown";
          const ipLabel = normalizeOptionalString(next.ip);
          parts.push(`Node: ${hostLabel}${ipLabel ? ` (${ipLabel})` : ""}`);
        }
        if (versionChanged) {
          parts.push(`app ${normalizeOptionalString(next.version) ?? "unknown"}`);
        }
        if (modeChanged) {
          parts.push(`mode ${normalizeOptionalString(next.mode) ?? "unknown"}`);
        }
        if (reasonChanged) {
          parts.push(`reason ${normalizeOptionalString(reasonValue) ?? "event"}`);
        }
        const deltaText = parts.join(" · ");
        if (deltaText) {
          enqueueSystemEvent(deltaText, {
            sessionKey,
            contextKey: presenceUpdate.key,
          });
        }
      }
    } else {
      enqueueSystemEvent(text, { sessionKey });
      if (wake) {
        // Targeted admin events may need a proactive response. Carry the exact
        // session through the wake so its delivery context, not main, wins.
        requestHeartbeat({
          source: "notifications-event",
          intent: "immediate",
          // The dispatcher recognizes "wake" as a payload-bearing run, so an
          // empty HEARTBEAT.md cannot suppress this queued system event.
          reason: "wake",
          sessionKey,
          heartbeat: { target: "last" },
        });
      }
    }
    // Presence changes are observable even when noisy node heartbeat text is
    // suppressed from the transcript-style system event queue.
    broadcastPresenceSnapshot({
      broadcast: context.broadcast,
      incrementPresenceVersion: context.incrementPresenceVersion,
      getHealthVersion: context.getHealthVersion,
    });
    respond(true, { ok: true }, undefined);
  },
};
