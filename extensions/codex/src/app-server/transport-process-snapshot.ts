import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

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

export async function readCodexAppServerProcessSnapshot(
  deadline = Date.now() + MAX_PROCESS_CONTAINMENT_MS,
): Promise<PosixProcess[] | undefined> {
  return process.platform === "linux"
    ? await readLinuxProcesses(undefined, deadline)
    : await readProcesses(["-axo", PROCESS_COLUMNS], deadline);
}

export async function readCodexAppServerProcess(
  pid: number,
  deadline: number,
): Promise<PosixProcess | undefined> {
  const rows =
    process.platform === "linux"
      ? await readLinuxProcesses(pid, deadline)
      : await readProcesses(["-o", PROCESS_COLUMNS, "-p", String(pid)], deadline);
  return rows?.find((row) => row.pid === pid);
}

// Absent processes and failed inspection both return undefined. Neither grants
// callers authority to signal a process.
export async function readCodexAppServerProcessCommand(
  pid: number,
  deadline: number,
): Promise<string | undefined> {
  if (process.platform === "linux") {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return undefined;
    }
    try {
      const command = await readFile(`/proc/${pid}/cmdline`, {
        encoding: "utf8",
        signal: AbortSignal.timeout(remainingMs),
      });
      return command.split("\0").join(" ").trim() || undefined;
    } catch {
      return undefined;
    }
  }
  const output = await readProcessOutput(["-o", "command=", "-p", String(pid)], deadline);
  return output?.split("\n")[0]?.trim() || undefined;
}

async function readProcesses(
  args: string[],
  deadline: number,
): Promise<PosixProcess[] | undefined> {
  const output = await readProcessOutput(args, deadline);
  return output === undefined ? undefined : parseProcesses(output);
}

async function readProcessOutput(args: string[], deadline: number): Promise<string | undefined> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return undefined;
  }
  return await new Promise<string | undefined>((resolve) => {
    let settled = false;
    const settle = (output: string | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(output);
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
        settle(error ? undefined : stdout);
      },
    );
    const timer = setTimeout(
      () => {
        settle(undefined);
        inspector.stdout?.destroy();
        inspector.stderr?.destroy();
        inspector.kill("SIGKILL");
        inspector.unref();
      },
      Math.max(1, remainingMs),
    );
    timer.unref?.();
  });
}

function parseProcesses(output: string): PosixProcess[] {
  const rows: PosixProcess[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) {
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
      continue;
    }
    rows.push({ pid, ppid, pgid, state: match[4] ?? "", startedAt });
  }
  return rows;
}

// Linux exposes stronger start identities in procfs; BusyBox ps on supported
// Alpine installs has no lstart. Boot identity prevents reuse across reboots.
async function readLinuxProcesses(
  pid: number | undefined,
  deadline: number,
): Promise<PosixProcess[] | undefined> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    return undefined;
  }
  const options = { encoding: "utf8" as const, signal: AbortSignal.timeout(remainingMs) };
  try {
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", options)).trim();
    if (!/^[a-f0-9-]{36}$/.test(bootId)) {
      return undefined;
    }
    const pids = pid === undefined ? await readdir("/proc") : [String(pid)];
    const rows: PosixProcess[] = [];
    let bytes = 0;
    for (const entry of pids) {
      if (!/^\d+$/.test(entry)) {
        continue;
      }
      if (Date.now() >= deadline) {
        return undefined;
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
        return undefined;
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
        !/^\d+$/.test(startTicks ?? "")
      ) {
        return undefined;
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
    return rows;
  } catch {
    return undefined;
  }
}
