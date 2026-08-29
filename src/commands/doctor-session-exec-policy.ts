import { note } from "../../packages/terminal-core/src/note.js";
import { SESSION_PERMISSION_BY_EXEC_MODE } from "../agents/session-permission-exec-mode.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeExecAsk,
  normalizeExecSecurity,
  resolveExecModeFromPolicy,
} from "../infra/exec-approvals-core.js";
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
      if (!next.permissionMode) {
        // Partial legacy pairs inherit conservative policy so removing an ask-only
        // restriction cannot silently grant full access under permissive defaults.
        const mode = resolveExecModeFromPolicy({
          security: normalizeExecSecurity(execSecurity) ?? "allowlist",
          ask: normalizeExecAsk(execAsk) ?? "on-miss",
        });
        if (mode !== "full") {
          next.permissionMode = SESSION_PERMISSION_BY_EXEC_MODE[mode];
        }
      }
      if (phase === (params.apply ? "repair" : "scan")) {
        const outcome = next.permissionMode
          ? `${entry.permissionMode ? "kept" : "set"} permissionMode=${next.permissionMode}`
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
