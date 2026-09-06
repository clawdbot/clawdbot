import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";

export type PosixProcess = {
  pid: number;
  ppid: number;
  pgid: number;
  state: string;
  startedAt: string;
};

const PROCESS_COLUMNS = "pid=,ppid=,pgid=,stat=,lstart=";
const MAX_PROCESS_CONTAINMENT_MS = 2_000;
const PROCESS_INSPECTION_MAX_BYTES = 8 * 1024 * 1024;

export class ProcessInspectionError extends Error {
  constructor(readonly reason: "deadline" | "permission" | "unavailable") {
    const detail = {
      deadline: "Process inspection exceeded its deadline. Retry when the host is responsive.",
      permission: "Check process inspection permissions (/proc on Linux, ps on macOS), then retry.",
      unavailable:
        "Process identity is unavailable or invalid. Check /proc on Linux or ps on macOS, then retry.",
    }[reason];
    super(`Cannot inspect Codex processes. ${detail}`);
    this.name = "ProcessInspectionError";
  }
}

function inspectionFailure(error: unknown): ProcessInspectionError {
  if (error instanceof ProcessInspectionError) {
    return error;
  }
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  // Every abort signal in this reader is owned by its inspection deadline.
  return new ProcessInspectionError(
    code === "ABORT_ERR"
      ? "deadline"
      : code === "EACCES" || code === "EPERM" || code === "ERR_ACCESS_DENIED"
        ? "permission"
        : "unavailable",
  );
}

export async function readCodexAppServerProcessSnapshot(
  deadline = Date.now() + MAX_PROCESS_CONTAINMENT_MS,
  pids?: readonly number[],
): Promise<PosixProcess[]> {
  // Registration proves only known owners. Containment still needs the full tree.
  // Include the observer so an empty selected ps result cannot prove disappearance.
  const selected = pids === undefined ? undefined : [...new Set([process.pid, ...pids])];
  const rows =
    process.platform === "linux"
      ? await readLinuxProcesses(selected, deadline)
      : await readProcesses(
          selected ? ["-o", PROCESS_COLUMNS, "-p", selected.join(",")] : ["-axo", PROCESS_COLUMNS],
          deadline,
          selected !== undefined,
        );
  if (selected && !rows.some((row) => row.pid === process.pid)) {
    throw new ProcessInspectionError("unavailable");
  }
  return rows;
}

export async function readCodexAppServerProcess(
  pid: number,
  deadline: number,
): Promise<PosixProcess | undefined> {
  const rows =
    process.platform === "linux"
      ? await readLinuxProcesses([pid], deadline)
      : await readProcesses(["-o", PROCESS_COLUMNS, "-p", String(pid)], deadline);
  return rows.find((row) => row.pid === pid);
}

export async function readCodexAppServerProcessCommand(
  observed: PosixProcess,
  deadline: number,
): Promise<string> {
  let output: string;
  if (process.platform === "linux") {
    let pending = false;
    do {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new ProcessInspectionError("deadline");
      }
      let command: string;
      try {
        command = await readFile(`/proc/${observed.pid}/cmdline`, {
          encoding: "utf8",
          signal: AbortSignal.timeout(remainingMs),
        });
      } catch (error) {
        throw inspectionFailure(error);
      }
      // Linux can expose zero command bytes during exec startup. Wait only for
      // that state, with the original identity and deadline, including the final read.
      if (!command || pending) {
        const current = await readCodexAppServerProcess(observed.pid, deadline);
        if (
          !current ||
          current.startedAt !== observed.startedAt ||
          current.ppid !== observed.ppid ||
          current.pgid !== observed.pgid ||
          current.state.startsWith("Z")
        ) {
          throw new ProcessInspectionError("unavailable");
        }
      }
      output = command.split("\0").join(" ").trim();
      pending = command.length === 0;
      if (pending) {
        await setImmediate();
      }
    } while (pending);
  } else {
    output =
      (await readProcessOutput(["-o", "command=", "-p", String(observed.pid)], deadline))
        .split("\n")[0]
        ?.trim() ?? "";
  }
  if (Date.now() >= deadline) {
    throw new ProcessInspectionError("deadline");
  }
  if (!output) {
    throw new ProcessInspectionError("unavailable");
  }
  return output;
}

async function readProcesses(
  args: string[],
  deadline: number,
  selected = false,
): Promise<PosixProcess[]> {
  const output = await readProcessOutput(args, deadline);
  return parseProcesses(output, selected);
}

async function readProcessOutput(args: string[], deadline: number): Promise<string> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new ProcessInspectionError("deadline");
  }
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (output: string | ProcessInspectionError) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (output instanceof ProcessInspectionError) {
        reject(output);
      } else {
        resolve(output);
      }
    };
    const inspector = execFile(
      "ps",
      args,
      {
        encoding: "utf8",
        maxBuffer: PROCESS_INSPECTION_MAX_BYTES,
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      },
      (error, stdout) => {
        settle(
          Date.now() >= deadline
            ? new ProcessInspectionError("deadline")
            : error
              ? inspectionFailure(error)
              : stdout,
        );
      },
    );
    const timer = setTimeout(
      () => {
        settle(new ProcessInspectionError("deadline"));
        inspector.stdout?.destroy();
        inspector.stderr?.destroy();
        inspector.kill("SIGKILL");
        inspector.unref();
      },
      Math.max(1, remainingMs),
    );
    timer.unref?.();
  }).catch((error: unknown) => {
    // Spawn denial can throw before the inspector or its callback exists.
    throw inspectionFailure(error);
  });
}

function parseProcesses(output: string, selected: boolean): PosixProcess[] {
  const rows: PosixProcess[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) {
      if (selected && line.trim()) {
        throw new ProcessInspectionError("unavailable");
      }
      continue;
    }
    const pid = Number(match[1] ?? "");
    const ppid = Number(match[2] ?? "");
    const pgid = Number(match[3] ?? "");
    const startedAt = (match[5] ?? "").trim().replace(/\s+/g, " ");
    if (
      ![pid, ppid, pgid].every(Number.isSafeInteger) ||
      pid <= 0 ||
      ppid < 0 ||
      pgid <= 0 ||
      !startedAt
    ) {
      if (selected) {
        throw new ProcessInspectionError("unavailable");
      }
      continue;
    }
    rows.push({ pid, ppid, pgid, state: match[4] ?? "", startedAt });
  }
  return rows;
}

// Linux exposes stronger start identities in procfs; BusyBox ps on supported
// Alpine installs has no lstart. Boot identity prevents reuse across reboots.
async function readLinuxProcesses(
  selected: readonly number[] | undefined,
  deadline: number,
): Promise<PosixProcess[]> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new ProcessInspectionError("deadline");
  }
  const options = { encoding: "utf8" as const, signal: AbortSignal.timeout(remainingMs) };
  try {
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", options)).trim();
    if (!/^[a-f0-9-]{36}$/.test(bootId)) {
      throw new ProcessInspectionError("unavailable");
    }
    const pids = selected === undefined ? await readdir("/proc") : selected.map(String);
    const rows: PosixProcess[] = [];
    let bytes = 0;
    for (const entry of pids) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ProcessInspectionError("deadline");
      }
      const stat = await readFile(`/proc/${entry}/stat`, options).catch((error: unknown) => {
        // A process may exit between enumeration and read. Other failures must
        // not turn an unreadable process into proof that an orphan is gone.
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "ESRCH")
        ) {
          return undefined;
        }
        throw error;
      });
      if (stat === undefined) {
        continue;
      }
      bytes += stat.length;
      if (bytes > PROCESS_INSPECTION_MAX_BYTES) {
        throw new ProcessInspectionError("unavailable");
      }
      // comm can contain spaces, newlines and ')'; fields 3..N follow its last ')'.
      const commEnd = stat.lastIndexOf(")");
      const fields = stat
        .slice(commEnd + 1)
        .trim()
        .split(/\s+/);
      const ppid = Number(fields[1]);
      const pgid = Number(fields[2]);
      const startTicks = fields[19];
      if (
        commEnd < 0 ||
        ![ppid, pgid].every(Number.isSafeInteger) ||
        (selected !== undefined && (pgid <= 0 || ppid < 0)) ||
        !/^\d+$/.test(startTicks ?? "")
      ) {
        throw new ProcessInspectionError("unavailable");
      }
      if (pgid > 0) {
        rows.push({
          pid: Number(entry),
          ppid,
          pgid,
          state: fields[0]!,
          startedAt: `${bootId}:${startTicks}`,
        });
      }
    }
    if (Date.now() >= deadline) {
      throw new ProcessInspectionError("deadline");
    }
    return rows;
  } catch (error) {
    throw inspectionFailure(error);
  }
}
