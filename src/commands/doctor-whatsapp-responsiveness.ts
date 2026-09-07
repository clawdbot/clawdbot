/** Doctor observations for Gateway pressure and local TUI clients. */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import type { StatusSummary } from "../status/types.js";

type LocalTuiProcess = {
  pid: number;
  command: string;
};

const LOCAL_TUI_SUBCOMMANDS = new Set(["chat", "terminal", "tui"]);
const WHATSAPP_RESPONSIVENESS_CHECK_ID = "core/doctor/whatsapp-responsiveness";
const LOCAL_TUI_PROCESS_PROBE_TIMEOUT_MS = 1_000;

function tokenizeCommandLine(command: string): string[] {
  return command.trim().split(/\s+/u).filter(Boolean);
}

function normalizeExecutableName(value: string | undefined): string {
  return path.basename(value ?? "").replace(/\.exe$/iu, "");
}

function isLocalTuiCommand(command: string): boolean {
  const argv = tokenizeCommandLine(command);
  const executable = normalizeExecutableName(argv[0]);
  if (executable === "openclaw-tui") {
    return true;
  }
  return executable === "openclaw" && LOCAL_TUI_SUBCOMMANDS.has(argv[1] ?? "");
}

function parsePsPidLine(line: string): LocalTuiProcess | null {
  const match = line.match(/^\s*(\d+)\s+(.+)$/);
  if (!match) {
    return null;
  }
  const pid = Number(match[1]);
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) {
    return null;
  }
  const command = match[2]?.trim() ?? "";
  if (!isLocalTuiCommand(command)) {
    return null;
  }
  return { pid, command };
}

/** Lists local OpenClaw TUI processes without inferring their Gateway or activity. */
function listLocalTuiProcesses(): LocalTuiProcess[] {
  if (process.platform === "win32") {
    return [];
  }
  const ps = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: LOCAL_TUI_PROCESS_PROBE_TIMEOUT_MS,
  });
  if (ps.error || ps.status !== 0 || typeof ps.stdout !== "string") {
    return [];
  }
  const seen = new Set<number>();
  const processes: LocalTuiProcess[] = [];
  for (const line of ps.stdout.split(/\r?\n/)) {
    const proc = parsePsPidLine(line);
    if (!proc || seen.has(proc.pid)) {
      continue;
    }
    seen.add(proc.pid);
    processes.push(proc);
  }
  return processes;
}

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

function formatPidList(processes: LocalTuiProcess[]): string {
  return processes.map((proc) => String(proc.pid)).join(", ");
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

  const pids = formatPidList(tuiProcesses);
  return [
    {
      checkId: WHATSAPP_RESPONSIVENESS_CHECK_ID,
      severity: "warning",
      message:
        "Gateway reports pressure, and local TUI clients were detected. This snapshot does not identify the source of the pressure.",
      path: "channels.whatsapp",
      target: pids,
      requirement: "local-tui-event-loop-pressure",
      fixHint: `Inspect Gateway diagnostics with ${formatCliCommand(
        "openclaw gateway diagnostics export",
      )} before deciding whether to close clients.`,
    },
  ];
}

/** Renders the same advisory observations as the opt-in health check. */
export function noteWhatsappResponsivenessHealth(
  params: Parameters<typeof collectWhatsappResponsivenessHealthFindings>[0],
): void {
  const findings = collectWhatsappResponsivenessHealthFindings(params);
  if (findings.length > 0) {
    note(
      findings
        .map((finding) =>
          [finding.message, `Local TUI pids: ${finding.target}`, finding.fixHint].join("\n"),
        )
        .join("\n\n"),
      "WhatsApp responsiveness",
    );
  }
}
