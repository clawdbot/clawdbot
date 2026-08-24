// Tracks and terminates the exact subprocess tree owned by a Chrome MCP session.
import fs from "node:fs/promises";
import { setTimeout as sleepTimeout } from "node:timers/promises";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { toErrorObject } from "../infra/errors.js";
import {
  CHROME_MCP_PROCESS_EXIT_GRACE_MS,
  ChromeMcpProcessSnapshotError,
  type ChromeMcpOwnedProcess,
  type ChromeMcpProcessCleanupDeps,
  type ChromeMcpProcessCleanupState,
  type ChromeMcpProcessCleanupTarget,
  type ChromeMcpProcessSnapshot,
  type ChromeMcpSession,
} from "./chrome-mcp-contracts.js";
import {
  chromeMcpCleanupPromises as cleanupPromises,
  getChromeMcpProcessCleanupDeps,
  retainedChromeMcpCleanupSessions as retainedCleanupSessions,
} from "./chrome-mcp-state.js";

function readChromeMcpTransportPid(transport: StdioClientTransport): number | undefined {
  const pid = transport.pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid !== process.pid
    ? pid
    : undefined;
}

function parseChromeMcpLinuxStat(pid: number, stat: string): ChromeMcpProcessSnapshot | null {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
  const ppid = Number.parseInt(fields[1] ?? "", 10);
  const startTime = normalizeOptionalString(fields[19]);
  return Number.isInteger(ppid) && startTime ? { pid, ppid, identity: `linux:${startTime}` } : null;
}

async function listChromeMcpLinuxProcesses(): Promise<ChromeMcpProcessSnapshot[]> {
  const pids = (await fs.readdir("/proc"))
    .filter((name) => /^\d+$/.test(name))
    .map((name) => Number.parseInt(name, 10));
  const rows: ChromeMcpProcessSnapshot[] = [];
  for (const pid of pids) {
    try {
      const row = parseChromeMcpLinuxStat(pid, await fs.readFile(`/proc/${pid}/stat`, "utf8"));
      if (row) {
        rows.push(row);
      }
    } catch {
      // Exited or inaccessible processes are absent from this snapshot.
    }
  }
  return rows;
}

function parseChromeMcpDelimitedProcessList(
  stdout: string,
  platform: NodeJS.Platform,
): ChromeMcpProcessSnapshot[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const [rawPid, rawPpid, rawStarted, ...rawCommand] = line.split("\t");
    const pid = Number.parseInt(rawPid ?? "", 10);
    const ppid = Number.parseInt(rawPpid ?? "", 10);
    const started = normalizeOptionalString(rawStarted);
    const command = normalizeOptionalString(rawCommand.join("\t"));
    return Number.isInteger(pid) && Number.isInteger(ppid) && started && command
      ? [{ pid, ppid, identity: `${platform}:${started}|${command}` }]
      : [];
  });
}

/** Parse one C-locale Unix process table for focused process-identity tests. */
export function parseChromeMcpUnixProcessListForTest(
  stdout: string,
  platform: NodeJS.Platform,
): ChromeMcpProcessSnapshot[] {
  const delimited = stdout.replace(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/gm, "$1\t$2\t$3\t$4");
  return parseChromeMcpDelimitedProcessList(delimited, platform);
}

async function listChromeMcpPlatformProcesses(
  deps: ChromeMcpProcessCleanupDeps | null,
): Promise<ChromeMcpProcessSnapshot[]> {
  try {
    if (deps?.listProcesses) {
      return await deps.listProcesses();
    }
    const platform = deps?.platform ?? process.platform;
    if (platform === "linux") {
      return await listChromeMcpLinuxProcesses();
    }
    const windows = platform === "win32";
    const { stdout } = await runExec(
      windows ? "powershell.exe" : "ps",
      windows
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            'Get-CimInstance Win32_Process | ForEach-Object { "{0}`t{1}`t{2:o}`t{3}" -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate,$_.ExecutablePath }',
          ]
        : ["-axww", "-o", "pid=,ppid=,lstart=,command="],
      {
        env: windows ? undefined : { ...process.env, LC_ALL: "C", TZ: "UTC" },
        logOutput: false,
        maxBuffer: 4 * 1024 * 1024,
        timeoutMs: 2_000,
      },
    );
    if (windows) {
      return parseChromeMcpDelimitedProcessList(stdout, platform);
    }
    // lstart is a fixed 24-byte C-locale field. Command shares the same row so
    // PID reuse within its one-second resolution cannot match another executable.
    return parseChromeMcpUnixProcessListForTest(stdout, platform);
  } catch (err) {
    throw new ChromeMcpProcessSnapshotError(
      err instanceof Error ? err.message : "Unable to inspect the Chrome MCP process tree.",
      { cause: err },
    );
  }
}

function captureChromeMcpProcessTarget(
  rootPid: number,
  snapshots: ChromeMcpProcessSnapshot[],
): ChromeMcpProcessCleanupTarget {
  const byPid = new Map(snapshots.map((snapshot) => [snapshot.pid, snapshot]));
  const root = byPid.get(rootPid);
  if (!root) {
    throw new ChromeMcpProcessSnapshotError(
      `Chrome MCP process identity unavailable for pid ${rootPid}.`,
    );
  }
  const childrenByParent = new Map<number, ChromeMcpProcessSnapshot[]>();
  for (const snapshot of snapshots) {
    const children = childrenByParent.get(snapshot.ppid) ?? [];
    children.push(snapshot);
    childrenByParent.set(snapshot.ppid, children);
  }
  const descendants: ChromeMcpOwnedProcess[] = [];
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || next.pid === process.pid || next.pid === rootPid) {
      continue;
    }
    descendants.push({ pid: next.pid, identity: next.identity });
    queue.push(...(childrenByParent.get(next.pid) ?? []));
  }
  return { root: { pid: root.pid, identity: root.identity }, descendants };
}

function sameChromeMcpProcesses(
  targets: ChromeMcpOwnedProcess[],
  snapshots: ChromeMcpProcessSnapshot[],
): ChromeMcpOwnedProcess[] {
  const currentByPid = new Map(snapshots.map((snapshot) => [snapshot.pid, snapshot.identity]));
  return targets.filter((target) => currentByPid.get(target.pid) === target.identity);
}

export function cleanupTarget(
  state: ChromeMcpProcessCleanupState,
): ChromeMcpProcessCleanupTarget | undefined {
  return state.status === "tracked" || state.status === "uncertain" ? state.target : undefined;
}

export async function refreshChromeMcpCleanupProcess(session: ChromeMcpSession): Promise<void> {
  const state = session.processCleanup;
  if (!state || state.status === "closed") {
    return;
  }
  if (session.processCleanupRefresh) {
    return await session.processCleanupRefresh;
  }
  const refresh = (async () => {
    const existing = cleanupTarget(state);
    const rootPid = existing?.root.pid ?? readChromeMcpTransportPid(session.transport);
    if (!rootPid) {
      if (state.status === "uncertain") {
        throw new Error("Chrome MCP subprocess tree cleanup could not be verified.");
      }
      return;
    }
    const snapshots = await listChromeMcpPlatformProcesses(getChromeMcpProcessCleanupDeps());
    const currentRoot = snapshots.find((snapshot) => snapshot.pid === rootPid);
    if (existing && currentRoot?.identity !== existing.root.identity) {
      if (state.status === "uncertain") {
        throw new Error("Chrome MCP subprocess tree cleanup could not be verified.");
      }
      return;
    }
    const captured = captureChromeMcpProcessTarget(rootPid, snapshots);
    session.processCleanup = {
      status: "tracked",
      target: {
        root: existing?.root ?? captured.root,
        descendants: [
          ...new Map(
            [...(existing?.descendants ?? []), ...captured.descendants].map((owned) => [
              owned.pid,
              owned,
            ]),
          ).values(),
        ],
      },
    };
  })();
  session.processCleanupRefresh = refresh;
  try {
    await refresh;
  } finally {
    if (session.processCleanupRefresh === refresh) {
      session.processCleanupRefresh = undefined;
    }
  }
}

async function taskkillChromeMcpProcessTree(
  rootPid: number,
  deps: ChromeMcpProcessCleanupDeps | null,
): Promise<void> {
  if (deps?.taskkillProcessTree) {
    await deps.taskkillProcessTree(rootPid);
    return;
  }
  await runExec("taskkill", ["/pid", String(rootPid), "/t", "/f"], {
    logOutput: false,
    maxBuffer: 64 * 1024,
    timeoutMs: 2_000,
  });
}

async function currentChromeMcpProcesses(
  targets: ChromeMcpOwnedProcess[],
  deps: ChromeMcpProcessCleanupDeps | null,
): Promise<ChromeMcpOwnedProcess[]> {
  return sameChromeMcpProcesses(targets, await listChromeMcpPlatformProcesses(deps));
}

async function terminateChromeMcpProcessTree(
  target: ChromeMcpProcessCleanupTarget | undefined,
): Promise<void> {
  if (!target) {
    return;
  }

  const deps = getChromeMcpProcessCleanupDeps();
  if ((deps?.platform ?? process.platform) === "win32") {
    let firstError: Error | undefined;
    if ((await currentChromeMcpProcesses([target.root], deps)).length > 0) {
      try {
        await taskkillChromeMcpProcessTree(target.root.pid, deps);
      } catch (err) {
        firstError ??= toErrorObject(err, "Chrome MCP process-tree cleanup failed.");
      }
    }
    await (deps?.sleep ?? sleepTimeout)(CHROME_MCP_PROCESS_EXIT_GRACE_MS);
    for (const descendant of await currentChromeMcpProcesses(target.descendants, deps)) {
      try {
        await taskkillChromeMcpProcessTree(descendant.pid, deps);
      } catch (err) {
        firstError ??= toErrorObject(err, "Chrome MCP process-tree cleanup failed.");
      }
    }
    await (deps?.sleep ?? sleepTimeout)(CHROME_MCP_PROCESS_EXIT_GRACE_MS);
    const surviving = await currentChromeMcpProcesses([target.root, ...target.descendants], deps);
    if (surviving.length > 0) {
      throw (
        firstError ??
        new Error(
          `Chrome MCP process cleanup failed for pid ${surviving.map(({ pid }) => pid).join(", ")}.`,
        )
      );
    }
    return;
  }

  const killProcess = deps?.killProcess ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = deps?.sleep ?? sleepTimeout;
  const targets = [...target.descendants.toReversed(), target.root];
  for (const owned of await currentChromeMcpProcesses(targets, deps)) {
    try {
      killProcess(owned.pid, "SIGTERM");
    } catch {
      // The process may already have exited as part of client.close().
    }
  }
  await sleep(CHROME_MCP_PROCESS_EXIT_GRACE_MS);
  for (const owned of await currentChromeMcpProcesses(targets, deps)) {
    try {
      killProcess(owned.pid, "SIGKILL");
    } catch {
      // Best-effort cleanup only.
    }
  }
  await sleep(CHROME_MCP_PROCESS_EXIT_GRACE_MS);
  const surviving = await currentChromeMcpProcesses(targets, deps);
  if (surviving.length > 0) {
    throw new Error(
      `Chrome MCP process cleanup failed for pid ${surviving.map(({ pid }) => pid).join(", ")}.`,
    );
  }
}

async function closeChromeMcpSessionHandle(session: ChromeMcpSession): Promise<void> {
  let firstError: Error | undefined;
  let cleanupUncertain = session.processCleanup?.status === "uncertain";
  const attempt = async (operation: () => Promise<void>) => {
    try {
      await operation();
    } catch (err) {
      cleanupUncertain ||= err instanceof ChromeMcpProcessSnapshotError;
      firstError ??= toErrorObject(err, "Chrome MCP session cleanup failed.");
    }
  };
  await attempt(async () => await refreshChromeMcpCleanupProcess(session));
  const target = session.processCleanup ? cleanupTarget(session.processCleanup) : undefined;
  const terminateFirst =
    Boolean(target) && (getChromeMcpProcessCleanupDeps()?.platform ?? process.platform) === "win32";
  if (terminateFirst) {
    await attempt(async () => await terminateChromeMcpProcessTree(target));
  }
  // MCP SDK owns the exact spawned ChildProcess; always close it even when
  // descendant discovery or platform tree cleanup fails.
  await attempt(async () => await session.client.close());
  if (!terminateFirst) {
    await attempt(async () => await terminateChromeMcpProcessTree(target));
  }
  if (firstError) {
    if (cleanupUncertain) {
      session.processCleanup = { status: "uncertain", ...(target ? { target } : {}) };
    }
    throw firstError;
  }
  session.processCleanup = { status: "closed" };
}

export async function closeTrackedChromeMcpSession(
  cacheKey: string,
  session: ChromeMcpSession,
): Promise<void> {
  if (session.processCleanup?.status === "closed") {
    return;
  }
  const existing = cleanupPromises.get(session);
  if (existing) {
    return await existing;
  }

  // Publish cleanup ownership before awaiting so a replacement session cannot
  // overtake the exact process/client handle being closed.
  const retained = retainedCleanupSessions.get(cacheKey) ?? new Set<ChromeMcpSession>();
  retained.add(session);
  retainedCleanupSessions.set(cacheKey, retained);
  const cleanup = (async () => {
    try {
      await closeChromeMcpSessionHandle(session);
      retained.delete(session);
      if (retained.size === 0) {
        retainedCleanupSessions.delete(cacheKey);
      }
    } finally {
      cleanupPromises.delete(session);
    }
  })();
  cleanupPromises.set(session, cleanup);
  return await cleanup;
}

export async function drainRetainedChromeMcpCleanup(cacheKey: string): Promise<void> {
  const results = await Promise.allSettled(
    [...(retainedCleanupSessions.get(cacheKey) ?? [])].map(
      async (session) => await closeTrackedChromeMcpSession(cacheKey, session),
    ),
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) {
    throw failed.reason;
  }
}
