import { note } from "../../packages/terminal-core/src/note.js";
import { resolveAgentConfig, resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolveExecTarget } from "../agents/bash-tools.exec-runtime.js";
import { SESSION_PERMISSION_BY_EXEC_MODE } from "../agents/session-permission-exec-mode.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeExecAsk,
  normalizeExecSecurity,
  normalizeExecTarget,
  resolveExecModeFromPolicy,
} from "../infra/exec-approvals-core.js";
import { applyExecPolicyLayer } from "../infra/exec-policy.js";
import { repairCanonicalSessionEntries } from "./doctor-session-delivery-state.js";

type LegacySessionEntry = SessionEntry & { execSecurity?: unknown; execAsk?: unknown };

/** Retires session exec overrides without granting the full-mode approval-floor bypass. */
export function repairLegacySessionExecPolicy(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): void {
  const messages: string[] = [];
  repairCanonicalSessionEntries({
    ...params,
    updateDeliveryProjection: false,
    transform(entry: LegacySessionEntry, sessionKey, phase) {
      const { execSecurity, execAsk, ...next } = entry;
      if (execSecurity === undefined && execAsk === undefined) {
        return entry;
      }
      let ask = normalizeExecAsk(execAsk);
      if (!next.permissionMode) {
        const agentId = resolveSessionAgentId({ sessionKey, config: params.cfg });
        const globalExec = params.cfg.tools?.exec;
        const agentExec = resolveAgentConfig(params.cfg, agentId)?.tools?.exec;
        const { effectiveHost } = resolveExecTarget({
          configuredTarget:
            normalizeExecTarget(entry.execHost) ?? agentExec?.host ?? globalExec?.host,
          elevatedRequested: false,
          sandboxRequired: entry.sandbox === "required",
          // Doctor cannot recover historical sandbox availability. Choose the
          // stricter sandbox base for auto targets so migration never broadens exec.
          sandboxAvailable: true,
        });
        const base = applyExecPolicyLayer(
          applyExecPolicyLayer(
            { security: effectiveHost === "sandbox" ? "deny" : "full", ask: "off" },
            globalExec,
          ),
          agentExec,
        );
        ask ??= base.ask;
        const mode = resolveExecModeFromPolicy({
          security: normalizeExecSecurity(execSecurity) ?? base.security,
          ask,
        });
        // No permission mode encodes approval on every command: `guarded` prompts
        // only on allowlist misses. Migrating ask=always to it would let analyzed
        // allowlisted commands run unprompted, so retire those rows to read-only
        // and let the operator widen the session deliberately.
        next.permissionMode =
          ask === "always"
            ? "read-only"
            : mode === "full"
              ? undefined
              : SESSION_PERMISSION_BY_EXEC_MODE[mode];
      }
      if (phase === (params.apply ? "repair" : "scan")) {
        const outcome = next.permissionMode
          ? `${entry.permissionMode ? "kept" : "set"} permissionMode=${next.permissionMode}${
              ask === "always" && !entry.permissionMode
                ? " (ask=always has no mode equivalent; choose guarded or workspace to allow commands again)"
                : ""
            }`
          : "config default applies; full permission mode was not granted";
        messages.push(
          `- ${sessionKey}: ${params.apply ? "removed" : "would remove"} legacy exec policy; ${outcome}.`,
        );
      }
      return next;
    },
  });
  // Repair messages come from authoritative row rewrites and are published only
  // after their transactions commit; failed scans never claim applied changes.
  if (messages.length > 0) {
    if (!params.apply) {
      messages.push('- Run "openclaw doctor --fix" to migrate legacy session exec policy.');
    }
    note(messages.join("\n"), "Session exec policy");
  }
}
