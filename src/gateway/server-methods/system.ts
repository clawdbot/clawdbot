import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveMainSessionKeyFromConfig } from "../../config/sessions.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../../infra/device-identity.js";
import { getLastHeartbeatEvent } from "../../infra/heartbeat-events.js";
import { setHeartbeatsEnabled } from "../../infra/heartbeat-runner.js";
import { enqueueSystemEvent, isSystemEventContextChanged } from "../../infra/system-events.js";
import { listSystemPresence, updateSystemPresence } from "../../infra/system-presence.js";
import { broadcastPresenceSnapshot } from "../server/presence-events.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Gateway handlers for identity, heartbeat toggles, and system presence events. */
export const systemHandlers: GatewayRequestHandlers = {
  "gateway.identity.get": ({ respond }) => {
    const identity = loadOrCreateDeviceIdentity();
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
  "system-event": ({ params, respond, context }) => {
    // System events come from mixed RPC clients; normalize fields before
    // presence state decides whether this event should fan out or be elided.
    const text = normalizeOptionalString(params.text) ?? "";
    if (!text) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "text required"));
      return;
    }
    const sessionKey = resolveMainSessionKeyFromConfig();
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
    const isNodePresenceLine = text.startsWith("Node:");
    if (isNodePresenceLine) {
      // Node presence heartbeats are noisy; only enqueue user-visible system
      // events when routing context or meaningful node metadata changes.
      const next = presenceUpdate.next;
      const changed = new Set(presenceUpdate.changedKeys);
      const reasonValue = next.reason ?? reason;
      const normalizedReason = normalizeLowercaseStringOrEmpty(reasonValue);
      const ignoreReason =
        normalizedReason.startsWith("periodic") || normalizedReason === "heartbeat";
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
