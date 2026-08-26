/** Doctor hints for WhatsApp responsiveness when local TUI clients block gateway work. */
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import {
  formatLocalTuiPidList,
  listLocalTuiProcesses,
  type LocalTuiProcess,
} from "../infra/local-tui-processes.js";
import type { StatusSummary } from "../status/types.js";

const WHATSAPP_RESPONSIVENESS_CHECK_ID = "core/doctor/whatsapp-responsiveness";

function hasWhatsappEnabled(cfg: OpenClawConfig): boolean {
  const whatsapp = cfg.channels?.whatsapp;
  if (!whatsapp || whatsapp.enabled === false) {
    return false;
  }
  const accounts = whatsapp.accounts;
  if (accounts && Object.keys(accounts).length > 0) {
    return Object.values(accounts).some((account) => account?.enabled !== false);
  }
  return true;
}

/** Collects read-only structured findings for WhatsApp responsiveness pressure. */
export function collectWhatsappResponsivenessHealthFindings(params: {
  cfg: OpenClawConfig;
  status?: Pick<StatusSummary, "eventLoop"> | null;
  listLocalTuiProcesses?: () => LocalTuiProcess[];
}): readonly HealthFinding[] {
  if (!hasWhatsappEnabled(params.cfg)) {
    return [];
  }

  const eventLoop = params.status?.eventLoop;
  if (eventLoop?.degraded !== true) {
    return [];
  }

  const tuiProcesses = (params.listLocalTuiProcesses ?? listLocalTuiProcesses)();
  if (tuiProcesses.length === 0) {
    return [];
  }

  const pids = formatLocalTuiPidList(tuiProcesses);
  return [
    {
      checkId: WHATSAPP_RESPONSIVENESS_CHECK_ID,
      severity: "warning",
      message:
        "Gateway event loop is degraded while local TUI clients are running; WhatsApp replies can queue behind TUI startup/session refresh work.",
      path: "channels.whatsapp",
      target: pids,
      requirement: "local-tui-event-loop-pressure",
      fixHint: `Close local TUI sessions (${pids}), then rerun ${formatCliCommand("openclaw doctor")}.`,
    },
  ];
}

/** Emits WhatsApp responsiveness warnings without signaling unbound processes. */
export async function noteWhatsappResponsivenessHealth(params: {
  cfg: OpenClawConfig;
  status?: Pick<StatusSummary, "eventLoop"> | null;
  shouldRepair: boolean;
  listLocalTuiProcesses?: () => LocalTuiProcess[];
}): Promise<void> {
  if (!hasWhatsappEnabled(params.cfg)) {
    return;
  }

  const warnings: string[] = [];
  const tuiProcesses = (params.listLocalTuiProcesses ?? listLocalTuiProcesses)();
  const eventLoop = params.status?.eventLoop;
  const gatewayDegraded = eventLoop?.degraded === true;

  if (gatewayDegraded && tuiProcesses.length > 0) {
    warnings.push(
      [
        "Gateway event loop is degraded while local TUI clients are running.",
        "WhatsApp replies can queue behind TUI startup/session refresh work.",
        `Local TUI pids: ${formatLocalTuiPidList(tuiProcesses)}`,
      ].join("\n"),
    );
    warnings.push(
      params.shouldRepair
        ? "Doctor cannot safely close a TUI whose installation is unknown; close those sessions and retry."
        : `Fix: close those TUI sessions, then rerun ${formatCliCommand("openclaw doctor")}.`,
    );
  }

  if (warnings.length > 0) {
    note(warnings.join("\n\n"), "WhatsApp responsiveness");
  }
}
