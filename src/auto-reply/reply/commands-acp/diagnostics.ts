import { getAcpSessionManager } from "../../../acp/control-plane/manager.js";
import { formatAcpRuntimeErrorText } from "../../../acp/runtime/error-text.js";
import { toAcpRuntimeError } from "../../../acp/runtime/errors.js";
import { getAcpRuntimeBackend, requireAcpRuntimeBackend } from "../../../acp/runtime/registry.js";
import { resolveSessionStorePathForAcp } from "../../../acp/runtime/session-meta.js";
import { loadSessionStore } from "../../../config/sessions.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { getSessionBindingService } from "../../../infra/outbound/session-binding-service.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../../shared/string-coerce.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
import { resolveAcpCommandBindingContext } from "./context.js";
import { resolveAcpInstallCommandHint } from "./install-hints.js";
import {
  ACP_DOCTOR_USAGE,
  ACP_INSTALL_USAGE,
  ACP_SESSIONS_USAGE,
  formatAcpCapabilitiesText,
  stopWithText,
} from "./shared.js";
import { resolveBoundAcpThreadSessionKey } from "./targets.js";

function isBackendPluginBlockedByAllowlist(params: {
  cfg: HandleCommandsParams["cfg"];
  backendId: string;
}): boolean {
  const allow = params.cfg.plugins?.allow;
  if (!Array.isArray(allow) || allow.length === 0) {
    return false;
  }
  const normalizedBackendId = normalizeLowercaseStringOrEmpty(params.backendId);
  if (!normalizedBackendId) {
    return false;
  }
  return !allow.some(
    (pluginId) => normalizeLowercaseStringOrEmpty(pluginId) === normalizedBackendId,
  );
}

export async function handleAcpDoctorAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  if (restTokens.length > 0) {
    return stopWithText(`⚠️ ${ACP_DOCTOR_USAGE}`);
  }

  const backendId = normalizeOptionalString(params.cfg.acp?.backend) ?? "acpx";
  const installHint = resolveAcpInstallCommandHint(params.cfg);
  const registeredBackend = getAcpRuntimeBackend(backendId);
  const managerSnapshot = getAcpSessionManager().getObservabilitySnapshot(params.cfg);
  const lines = ["ACP doctor:", "-----", `configuredBackend: ${backendId}`];
  lines.push(`activeRuntimeSessions: ${managerSnapshot.runtimeCache.activeSessions}`);
  lines.push(`runtimeIdleTtlMs: ${managerSnapshot.runtimeCache.idleTtlMs}`);
  lines.push(`evictedIdleRuntimes: ${managerSnapshot.runtimeCache.evictedTotal}`);
  lines.push(`activeTurns: ${managerSnapshot.turns.active}`);
  lines.push(`queueDepth: ${managerSnapshot.turns.queueDepth}`);
  lines.push(
    `turnLatencyMs: avg=${managerSnapshot.turns.averageLatencyMs}, max=${managerSnapshot.turns.maxLatencyMs}`,
  );
  lines.push(
    `turnCounts: completed=${managerSnapshot.turns.completed}, failed=${managerSnapshot.turns.failed}`,
  );
  const errorStatsText =
    Object.entries(managerSnapshot.errorsByCode)
      .map(([code, count]) => `${code}=${count}`)
      .join(", ") || "(none)";
  lines.push(`errorCodes: ${errorStatsText}`);
  if (registeredBackend) {
    lines.push(`registeredBackend: ${registeredBackend.id}`);
  } else {
    lines.push("registeredBackend: (none)");
  }
  const backendBlockedByAllowlist = isBackendPluginBlockedByAllowlist({
    cfg: params.cfg,
    backendId,
  });
  if (backendBlockedByAllowlist) {
    lines.push(`pluginActivation: blocked (${backendId} is missing from plugins.allow)`);
  }

  if (registeredBackend?.runtime.doctor) {
    try {
      const report = await registeredBackend.runtime.doctor();
      lines.push(`runtimeDoctor: ${report.ok ? "ok" : "error"} (${report.message})`);
      if (report.code) {
        lines.push(`runtimeDoctorCode: ${report.code}`);
      }
      if (report.installCommand) {
        lines.push(`runtimeDoctorInstall: ${report.installCommand}`);
      }
      for (const detail of report.details ?? []) {
        lines.push(`runtimeDoctorDetail: ${detail}`);
      }
    } catch (error) {
      lines.push(
        `runtimeDoctor: error (${
          toAcpRuntimeError({
            error,
            fallbackCode: "ACP_TURN_FAILED",
            fallbackMessage: "Runtime doctor failed.",
          }).message
        })`,
      );
    }
  }

  try {
    const backend = requireAcpRuntimeBackend(backendId);
    const capabilities = backend.runtime.getCapabilities
      ? await backend.runtime.getCapabilities({})
      : { controls: [] as string[], configOptionKeys: [] as string[] };
    lines.push("healthy: yes");
    lines.push(`capabilities: ${formatAcpCapabilitiesText(capabilities.controls ?? [])}`);
    if ((capabilities.configOptionKeys?.length ?? 0) > 0) {
      lines.push(`configKeys: ${capabilities.configOptionKeys?.join(", ")}`);
    }
    return stopWithText(lines.join("\n"));
  } catch (error) {
    const acpError = toAcpRuntimeError({
      error,
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "ACP backend doctor failed.",
    });
    lines.push("healthy: no");
    lines.push(formatAcpRuntimeErrorText(acpError));
    if (backendBlockedByAllowlist) {
      lines.push(`next: add "${backendId}" to plugins.allow or unset plugins.allow.`);
    }
    lines.push(`next: ${installHint}`);
    lines.push(`next: openclaw config set plugins.entries.${backendId}.enabled true`);
    if (normalizeLowercaseStringOrEmpty(backendId) === "acpx") {
      lines.push("next: verify acpx is installed (`acpx --help`).");
    }
    return stopWithText(lines.join("\n"));
  }
}

export function handleAcpInstallAction(
  params: HandleCommandsParams,
  restTokens: string[],
): CommandHandlerResult {
  if (restTokens.length > 0) {
    return stopWithText(`⚠️ ${ACP_INSTALL_USAGE}`);
  }
  const backendId = normalizeOptionalString(params.cfg.acp?.backend) ?? "acpx";
  const installHint = resolveAcpInstallCommandHint(params.cfg);
  const lines = [
    "ACP install:",
    "-----",
    `configuredBackend: ${backendId}`,
    `run: ${installHint}`,
    `then: openclaw config set plugins.entries.${backendId}.enabled true`,
    "then: /acp doctor",
  ];
  return stopWithText(lines.join("\n"));
}

function formatAcpSessionLine(params: {
  key: string;
  entry: SessionEntry;
  currentSessionKey?: string;
  threadId?: string;
}): string {
  const acp = params.entry.acp;
  if (!acp) {
    return "";
  }
  const marker = params.currentSessionKey === params.key ? "*" : " ";
  const label = normalizeOptionalString(params.entry.label) || acp.agent;
  const threadText = params.threadId ? `, thread:${params.threadId}` : "";
  return `${marker} ${label} (${acp.mode}, ${acp.state}, backend:${acp.backend}${threadText}) -> ${params.key}`;
}

export function handleAcpSessionsAction(
  params: HandleCommandsParams,
  restTokens: string[],
): CommandHandlerResult {
  if (restTokens.length > 0) {
    return stopWithText(ACP_SESSIONS_USAGE);
  }

  const currentSessionKey = resolveBoundAcpThreadSessionKey(params) || params.sessionKey;
  if (!currentSessionKey) {
    return stopWithText("⚠️ Missing session key.");
  }

  const { storePath } = resolveSessionStorePathForAcp({
    cfg: params.cfg,
    sessionKey: currentSessionKey,
  });

  let store: Record<string, SessionEntry>;
  try {
    store = loadSessionStore(storePath);
  } catch {
    store = {};
  }

  const bindingContext = resolveAcpCommandBindingContext(params);
  const normalizedChannel = bindingContext.channel;
  const normalizedAccountId = bindingContext.accountId || undefined;
  const bindingService = getSessionBindingService();

  const rows = Object.entries(store)
    .filter(([, entry]) => Boolean(entry?.acp))
    .toSorted(([, a], [, b]) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0))
    .slice(0, 20)
    .map(([key, entry]) => {
      const bindingThreadId = bindingService
        .listBySession(key)
        .find(
          (binding) =>
            (!normalizedChannel || binding.conversation.channel === normalizedChannel) &&
            (!normalizedAccountId || binding.conversation.accountId === normalizedAccountId),
        )?.conversation.conversationId;
      return formatAcpSessionLine({
        key,
        entry,
        currentSessionKey,
        threadId: bindingThreadId,
      });
    })
    .filter(Boolean);

  if (rows.length === 0) {
    return stopWithText("ACP sessions:\n-----\n(none)");
  }

  return stopWithText(["ACP sessions:", "-----", ...rows].join("\n"));
}
