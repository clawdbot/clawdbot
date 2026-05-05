import { spawnSync } from "node:child_process";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { note } from "../terminal/note.js";
import type { StatusSummary } from "./status.types.js";

export type LocalTuiProcess = {
  pid: number;
  command: string;
};

type ProcessSignal = "SIGTERM" | "SIGKILL";

type ProcessController = {
  kill: (pid: number, signal: ProcessSignal | 0) => boolean;
};

const LOCAL_TUI_CMD_RE =
  /(?:^|\s)(?:openclaw-tui|openclaw\s+tui|openclaw\s+chat|openclaw\s+terminal)(?:\s|$)/;

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
  if (!LOCAL_TUI_CMD_RE.test(command)) {
    return null;
  }
  return { pid, command };
}

export function listLocalTuiProcesses(): LocalTuiProcess[] {
  if (process.platform === "win32") {
    return [];
  }
  const ps = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    timeout: 1000,
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

function isProcessAlive(controller: ProcessController, pid: number): boolean {
  try {
    controller.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function terminateLocalTuiProcesses(params: {
  processes: LocalTuiProcess[];
  controller?: ProcessController;
  graceMs?: number;
}): Promise<{ stopped: number[]; failed: number[] }> {
  const controller = params.controller ?? process;
  const graceMs = Math.max(0, params.graceMs ?? 500);
  const stopped: number[] = [];
  const failed: number[] = [];

  for (const proc of params.processes) {
    try {
      controller.kill(proc.pid, "SIGTERM");
    } catch {
      // Already gone is success for this repair.
    }
  }
  if (graceMs > 0) {
    await sleep(graceMs);
  }
  for (const proc of params.processes) {
    if (!isProcessAlive(controller, proc.pid)) {
      stopped.push(proc.pid);
      continue;
    }
    try {
      controller.kill(proc.pid, "SIGKILL");
    } catch {
      // Already gone is still success.
    }
    if (isProcessAlive(controller, proc.pid)) {
      failed.push(proc.pid);
    } else {
      stopped.push(proc.pid);
    }
  }
  return { stopped, failed };
}

export async function noteWhatsappResponsivenessHealth(params: {
  cfg: OpenClawConfig;
  status?: Pick<StatusSummary, "eventLoop"> | null;
  shouldRepair: boolean;
  listLocalTuiProcesses?: () => LocalTuiProcess[];
  terminateLocalTuiProcesses?: typeof terminateLocalTuiProcesses;
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
        `Local TUI pids: ${formatPidList(tuiProcesses)}`,
      ].join("\n"),
    );
    if (params.shouldRepair) {
      const repair = await (params.terminateLocalTuiProcesses ?? terminateLocalTuiProcesses)({
        processes: tuiProcesses,
      });
      const repairLines: string[] = [];
      if (repair.stopped.length > 0) {
        repairLines.push(`Stopped local TUI clients: ${repair.stopped.join(", ")}`);
      }
      if (repair.failed.length > 0) {
        repairLines.push(`Could not stop local TUI clients: ${repair.failed.join(", ")}`);
      }
      if (repairLines.length > 0) {
        warnings.push(repairLines.join("\n"));
      }
    } else {
      warnings.push(
        `Fix: close those TUI sessions, or run ${formatCliCommand("openclaw doctor --fix")}.`,
      );
    }
  }

  if (warnings.length > 0) {
    note(warnings.join("\n\n"), "WhatsApp responsiveness");
  }
}
