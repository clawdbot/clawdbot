/**
 * ACP stateful target driver for configured bindings.
 *
 * Ensures ACP-backed bound sessions exist, are ready, and can be reset by Gateway.
 */
import {
  ensureConfiguredAcpBindingReady,
  ensureConfiguredAcpBindingSession,
} from "../../acp/persistent-bindings.lifecycle.js";
import { resolveConfiguredAcpBindingSpecBySessionKey } from "../../acp/persistent-bindings.resolve.js";
import { resolveConfiguredAcpBindingSpecFromRecord } from "../../acp/persistent-bindings.types.js";
import { readAcpSessionEntry } from "../../acp/runtime/session-meta.js";
import { resolveSessionEntryAccessTarget } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAcpSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { performGatewaySessionReset } from "./acp-stateful-target-reset.runtime.js";
import type {
  ConfiguredBindingResolution,
  StatefulBindingTargetDescriptor,
} from "./binding-types.js";
import type {
  StatefulBindingTargetDriver,
  StatefulBindingTargetResetResult,
  StatefulBindingTargetReadyResult,
  StatefulBindingTargetSessionResult,
} from "./stateful-target-drivers.js";

function toAcpStatefulBindingTargetDescriptor(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): StatefulBindingTargetDescriptor | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const meta = readAcpSessionEntry({
    ...params,
    sessionKey,
  })?.acp;
  const metaAgentId = meta?.agent?.trim();
  if (metaAgentId) {
    return {
      kind: "stateful",
      driverId: "acp",
      sessionKey,
      agentId: metaAgentId,
    };
  }
  const spec = resolveConfiguredAcpBindingSpecBySessionKey({
    ...params,
    sessionKey,
  });
  if (!spec) {
    if (!isAcpSessionKey(sessionKey)) {
      return null;
    }
    // Bound ACP sessions can intentionally clear their ACP metadata after a
    // reset. The native /reset path still needs to recognize the ACP session
    // key as resettable while that metadata is absent.
    return {
      kind: "stateful",
      driverId: "acp",
      sessionKey,
      agentId: resolveAgentIdFromSessionKey(sessionKey),
    };
  }
  return {
    kind: "stateful",
    driverId: "acp",
    sessionKey,
    agentId: spec.agentId,
    ...(spec.label ? { label: spec.label } : {}),
  };
}

async function ensureAcpTargetReady(params: {
  cfg: OpenClawConfig;
  bindingResolution: ConfiguredBindingResolution;
}): Promise<StatefulBindingTargetReadyResult> {
  const configuredBinding = resolveConfiguredAcpBindingSpecFromRecord(
    params.bindingResolution.record,
  );
  if (!configuredBinding) {
    return {
      ok: false,
      error: "Configured ACP binding unavailable",
    };
  }
  return await ensureConfiguredAcpBindingReady({
    cfg: params.cfg,
    configuredBinding: {
      spec: configuredBinding,
      record: params.bindingResolution.record,
    },
  });
}

async function ensureAcpTargetSession(params: {
  cfg: OpenClawConfig;
  bindingResolution: ConfiguredBindingResolution;
}): Promise<StatefulBindingTargetSessionResult> {
  const spec = resolveConfiguredAcpBindingSpecFromRecord(params.bindingResolution.record);
  if (!spec) {
    return {
      ok: false,
      sessionKey: params.bindingResolution.statefulTarget.sessionKey,
      error: "Configured ACP binding unavailable",
    };
  }
  return await ensureConfiguredAcpBindingSession({
    cfg: params.cfg,
    spec,
  });
}

async function resetAcpTargetInPlace(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  bindingTarget: StatefulBindingTargetDescriptor;
  reason: "new" | "reset";
  commandSource?: string;
}): Promise<StatefulBindingTargetResetResult> {
  if (
    resolveSessionEntryAccessTarget({ cfg: params.cfg, sessionKey: params.sessionKey }).entry
      ?.incognito === true
  ) {
    return { ok: false, error: "Incognito sessions cannot reset in place." };
  }
  const result = await performGatewaySessionReset({
    key: params.sessionKey,
    reason: params.reason,
    commandSource: params.commandSource ?? "stateful-target:acp-reset-in-place",
  });
  if (result.ok) {
    if ("incognitoDeleted" in result) {
      return { ok: true, sessionKey: result.key, storePath: result.storePath };
    }
    return {
      ok: true,
      sessionKey: result.key,
      sessionId: result.entry.sessionId,
      storePath: result.storePath,
    };
  }
  return {
    ok: false,
    error: result.error.message,
  };
}

export const acpStatefulBindingTargetDriver: StatefulBindingTargetDriver = {
  id: "acp",
  ensureReady: ensureAcpTargetReady,
  ensureSession: ensureAcpTargetSession,
  resolveTargetBySessionKey: toAcpStatefulBindingTargetDescriptor,
  resetInPlace: resetAcpTargetInPlace,
};
