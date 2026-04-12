import type { SessionAcpMeta } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { getAcpSessionManager } from "./control-plane/manager.js";
import { resolveConfiguredAcpBindingSpecBySessionKey } from "./persistent-bindings.resolve.js";
import {
  buildConfiguredAcpSessionKey,
  normalizeText,
  type ConfiguredAcpBindingSpec,
  type ResolvedConfiguredAcpBinding,
} from "./persistent-bindings.types.js";
import { readAcpSessionEntry } from "./runtime/session-meta.js";

function sessionMatchesConfiguredBinding(params: {
  cfg: OpenClawConfig;
  spec: ConfiguredAcpBindingSpec;
  meta: SessionAcpMeta;
}): boolean {
  if (params.meta.state === "error") {
    return false;
  }

  const desiredAgent = normalizeLowercaseStringOrEmpty(
    params.spec.acpAgentId ?? params.spec.agentId,
  );
  const currentAgent = normalizeLowercaseStringOrEmpty(params.meta.agent);
  if (!currentAgent || currentAgent !== desiredAgent) {
    return false;
  }

  if (params.meta.mode !== params.spec.mode) {
    return false;
  }

  const desiredBackend =
    normalizeText(params.spec.backend) ?? normalizeText(params.cfg.acp?.backend) ?? "";
  if (desiredBackend) {
    const currentBackend = (params.meta.backend ?? "").trim();
    if (!currentBackend || currentBackend !== desiredBackend) {
      return false;
    }
  }

  const desiredCwd = normalizeText(params.spec.cwd);
  if (desiredCwd !== undefined) {
    const currentCwd = (params.meta.runtimeOptions?.cwd ?? params.meta.cwd ?? "").trim();
    if (desiredCwd !== currentCwd) {
      return false;
    }
  }
  return true;
}

export async function ensureConfiguredAcpBindingSession(params: {
  cfg: OpenClawConfig;
  spec: ConfiguredAcpBindingSpec;
}): Promise<{ ok: true; sessionKey: string } | { ok: false; sessionKey: string; error: string }> {
  const sessionKey = buildConfiguredAcpSessionKey(params.spec);
  const acpManager = getAcpSessionManager();
  try {
    const resolution = acpManager.resolveSession({
      cfg: params.cfg,
      sessionKey,
    });
    if (
      resolution.kind === "ready" &&
      sessionMatchesConfiguredBinding({
        cfg: params.cfg,
        spec: params.spec,
        meta: resolution.meta,
      })
    ) {
      return {
        ok: true,
        sessionKey,
      };
    }

    if (resolution.kind !== "none") {
      await acpManager.closeSession({
        cfg: params.cfg,
        sessionKey,
        reason: "config-binding-reconfigure",
        clearMeta: false,
        allowBackendUnavailable: true,
        requireAcpSession: false,
      });
    }

    await acpManager.initializeSession({
      cfg: params.cfg,
      sessionKey,
      agent: params.spec.acpAgentId ?? params.spec.agentId,
      mode: params.spec.mode,
      cwd: params.spec.cwd,
      backendId: params.spec.backend,
    });

    return {
      ok: true,
      sessionKey,
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    logVerbose(
      `acp-configured-binding: failed ensuring ${params.spec.channel}:${params.spec.accountId}:${params.spec.conversationId} -> ${sessionKey}: ${message}`,
    );
    return {
      ok: false,
      sessionKey,
      error: message,
    };
  }
}

export async function ensureConfiguredAcpBindingReady(params: {
  cfg: OpenClawConfig;
  configuredBinding: ResolvedConfiguredAcpBinding | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!params.configuredBinding) {
    return { ok: true };
  }
  const ensured = await ensureConfiguredAcpBindingSession({
    cfg: params.cfg,
    spec: params.configuredBinding.spec,
  });
  if (ensured.ok) {
    return { ok: true };
  }
  return {
    ok: false,
    error: ensured.error ?? "unknown error",
  };
}

export async function resetAcpSessionInPlace(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  reason: "new" | "reset";
  clearMeta?: boolean;
}): Promise<{ ok: true } | { ok: false; skipped?: boolean; error?: string }> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return {
      ok: false,
      skipped: true,
    };
  }

  const meta = readAcpSessionEntry({
    cfg: params.cfg,
    sessionKey,
  })?.acp;
  const configuredBinding = resolveConfiguredAcpBindingSpecBySessionKey({
    cfg: params.cfg,
    sessionKey,
  });
  const clearMeta = params.clearMeta ?? Boolean(configuredBinding);
  if (!meta) {
    if (clearMeta) {
      return { ok: true };
    }
    return {
      ok: false,
      skipped: true,
    };
  }

  const acpManager = getAcpSessionManager();

  try {
    await acpManager.closeSession({
      cfg: params.cfg,
      sessionKey,
      reason: `${params.reason}-in-place-reset`,
      discardPersistentState: true,
      clearMeta,
      allowBackendUnavailable: true,
      requireAcpSession: false,
    });

    return { ok: true };
  } catch (error) {
    const message = formatErrorMessage(error);
    logVerbose(`acp-configured-binding: failed reset for ${sessionKey}: ${message}`);
    return {
      ok: false,
      error: message,
    };
  }
}
