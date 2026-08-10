/**
 * Reclaims bundled MCP temp config dirs (`openclaw-cli-mcp-*`) orphaned by
 * gateway death. The per-run cleanup callback (bundle-mcp.ts) lives in gateway
 * memory: when the gateway process exits with runs in flight (restart, crash,
 * SIGKILL), the callback dies with it and the temp dir — including the rendered
 * `mcp.json` with the loopback URL and resolved tokens — leaks.
 *
 * Orphan detection is liveness-based, not age-based: live CLI subprocesses
 * carry the config path in their argv (`--mcp-config <dir>/mcp.json`, see
 * `injectClaudeMcpConfigArgs`), and live-session dirs can legitimately persist
 * across turns for days — removing a dir still referenced by a persistent CLI
 * child would regress the failure fixed in #73244.
 *
 * Argv liveness alone is not enough: the config is rendered at prepare time,
 * before the run enters the serialization queue, so a run waiting in the queue
 * owns a config that no process argv references yet. To tell such a live-owned
 * queued dir from a true orphan without deleting the former, the creating
 * gateway's identity (pid + boot-id prefix + PID-namespace tag + process start
 * time) is encoded in the dir NAME by `mkdtemp`; an argv-unreferenced dir is
 * removed only once its owning gateway is provably gone (pid dead, host
 * rebooted, or pid reused) AND provably in this PID namespace. `process.kill`
 * and `/proc` see only the sweeper's own PID namespace, so a dir owned by a
 * different or unverifiable namespace — e.g. another container sharing the same
 * `/tmp` mount — is kept rather than judged by a pid that here is absent or
 * reused; that container's own sweep, where the encoded namespace matches,
 * reclaims it. This keeps the sweep from deleting a live foreign config.
 *
 * Old-format (legacy) dirs without an encoded owner are NEVER auto-removed.
 * Their owner cannot be proven, so during a rolling upgrade a concurrently
 * running older gateway could hold an unspawned queued run whose legacy config
 * is aged and argv-unreferenced — deleting it would break that run. Legacy
 * dirs are therefore always kept and surfaced (a startup warn with a count) for
 * explicit operator cleanup: pre-upgrade leaked configs are reclaimed by
 * stopping the gateway and removing them by hand, not by this sweep. Once a
 * host runs an ownership-aware build every new dir is owner-encoded, so the
 * legacy set only ever shrinks.
 *
 * False positives in the liveness check (an unrelated process merely mentioning
 * the path in its argv) only KEEP a dir — the safe direction. Under Linux
 * `hidepid`, processes of the same uid as the gateway (which is what spawns the
 * CLI children) remain visible, so their configs stay protected; a scan that
 * yields nothing at all is treated as unknown and the sweep fails closed.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getWindowsPowerShellExePath } from "../../infra/windows-install-roots.js";

const execFileAsync = promisify(execFile);

const BUNDLE_MCP_TEMP_PREFIX = "openclaw-cli-mcp-";

const PROCESS_SCAN_TIMEOUT_MS = 10_000;

/**
 * Pause between proving an owner dead (phase 1) and the final argv re-scan
 * (phase 2). It closes the residual time-of-check/time-of-use window: a child
 * forked by the dying gateway but not yet `exec`ed carries the parent's argv,
 * so no argv references its config until `exec` lands. That child was forked
 * strictly before its owner died, which is strictly before the death verdict
 * here — so waiting any interval longer than a fork→exec transition (µs, via
 * libuv's immediate `execvp`) guarantees it is argv-visible by the re-scan and
 * the dir is kept. Five seconds is ~6 orders of magnitude of headroom, paid
 * once at startup inside a post-ready sidecar that blocks no run.
 */
const POST_VERDICT_SETTLE_MS = 5_000;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    // Deliberately NOT unref'd. An unref'd timer does not hold the event loop,
    // so a runtime with nothing else pending exits before it fires and the
    // sweep's promise never settles (Node exits 13, "Unfinished Top-Level
    // Await" — observed on a real host). Holding the loop is safe here because
    // the sidecar's abort signal cuts the wait short on close: a shutdown
    // landing inside the settle resolves immediately (and the caller then
    // returns without deleting) instead of waiting the interval out.
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Owner identity is encoded in the temp dir NAME, not a sibling file:
 * `<prefix><pid>-<boot8>-<startTicks>-<mkdtemp suffix>`. The name is produced
 * atomically by `mkdtemp`, so a prepared run carries durable ownership with no
 * extra write that could fail — the run's success path is unchanged (no
 * availability/compatibility regression), and a concurrent gateway's sweep tells
 * a live-owned queued dir from a true orphan using only the dir name plus the OS
 * process table. `startTicks` (the owner's Linux process start time) guards pid
 * reuse; `boot8` (a Linux boot-id prefix) detects a reboot.
 */
const NO_BOOT_ID = "nobootid";
// Encoded when the creating gateway could not read its own start time. A real
// Linux process start time (ticks since boot) is never 0, so this is an unused
// sentinel meaning "unverifiable" — it must never be compared as a real value
// (that would fail OPEN: a live owner with an unknown creation start could be
// mistaken for a reused pid and deleted).
const UNKNOWN_START = "0";
// Encoded when the PID namespace cannot be read (off-Linux or restricted). Like
// the other unverifiable sentinels it fails CLOSED: a dir whose namespace is
// unknown — on either the creating or the sweeping side — can never be proven to
// live in the sweeper's namespace, so its pid-based liveness is untrustworthy
// and the dir is kept rather than reclaimed.
const NO_NS = "nons";

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process (dead). EPERM: exists but not signalable (alive).
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** First 8 hex of the Linux boot id (changes on reboot); NO_BOOT_ID off-Linux. */
async function readBootTag(): Promise<string> {
  if (process.platform !== "linux") {
    return NO_BOOT_ID;
  }
  try {
    const raw = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).replace(
      /[^0-9a-f]/gi,
      "",
    );
    return raw.length >= 8 ? raw.slice(0, 8).toLowerCase() : NO_BOOT_ID;
  } catch {
    return NO_BOOT_ID;
  }
}

/**
 * The current process's PID-namespace identity: the inode from
 * `readlink(/proc/self/ns/pid)` (e.g. "pid:[4026531836]"). Two gateways in
 * different PID namespaces — such as separate containers sharing one `/tmp`
 * mount — have different inodes here, so a namespace match proves the owner is
 * visible to THIS process's `process.kill`/`/proc` liveness probes. Returns
 * NO_NS off-Linux or when the link is unreadable.
 */
async function readPidNamespaceTag(): Promise<string> {
  if (process.platform !== "linux") {
    return NO_NS;
  }
  try {
    const link = await fs.readlink("/proc/self/ns/pid");
    const match = /^pid:\[(\d+)\]$/.exec(link);
    return match?.[1] ?? NO_NS;
  } catch {
    return NO_NS;
  }
}

/**
 * The owner process's start time in clock ticks since boot, from
 * `/proc/<pid>/stat` field 22. Two processes that reuse a pid within one boot
 * still differ here, so a start-time match proves same-process identity.
 * Returns undefined off-Linux or when the process is gone/unreadable.
 */
async function defaultReadStartTicks(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    // Field 2 (comm) is parenthesised and may itself contain spaces or ')'.
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2);
    const start = afterComm.split(" ")[19]; // field 22 = index 19 counting from field 3
    return start !== undefined && /^\d+$/.test(start) ? start : undefined;
  } catch {
    return undefined;
  }
}

let ownedMkdtempPrefixName: Promise<string> | undefined;

/**
 * The `mkdtemp` prefix *name* that encodes the creating gateway's identity into
 * the temp dir name (pid + boot tag + PID-namespace tag + process start ticks).
 * The random `mkdtemp` suffix is appended atomically — so ownership exists from
 * the instant the dir does. Callers join it onto the temp root themselves; the
 * shared `writeTemporaryBundleMcpJson` does exactly that before calling
 * `fs.mkdtemp`.
 */
export async function bundleMcpOwnedMkdtempPrefixName(): Promise<string> {
  // Every component here is fixed for this process's lifetime: the pid, the
  // boot id, the PID namespace and this process's own start ticks. Resolve them
  // once — otherwise each Claude bundle-MCP preparation pays three `/proc` reads
  // before queue admission, on the hot path of every run.
  //
  // Memoizing the promise (not the value) also collapses concurrent first-time
  // callers onto a single read. It cannot poison the cache: all three readers
  // swallow their own errors and resolve to a fallback, so this never settles
  // rejected.
  ownedMkdtempPrefixName ??= (async () => {
    const boot = await readBootTag();
    const ns = await readPidNamespaceTag();
    const start = (await defaultReadStartTicks(process.pid)) ?? UNKNOWN_START;
    return `${BUNDLE_MCP_TEMP_PREFIX}${process.pid}-${boot}-${ns}-${start}-`;
  })();
  return ownedMkdtempPrefixName;
}

type BundleMcpOwner = { pid: number; boot: string; ns: string; start: string };

// <prefix><pid>-<boot8|nobootid>-<nsInode|nons>-<startTicks>-<mkdtemp suffix>
const OWNER_NAME_RE = new RegExp(
  `^${BUNDLE_MCP_TEMP_PREFIX}(\\d+)-([0-9a-f]{8}|${NO_BOOT_ID})-(\\d+|${NO_NS})-(\\d+)-`,
);

function parseBundleMcpOwner(entryName: string): BundleMcpOwner | undefined {
  const match = OWNER_NAME_RE.exec(entryName);
  const [, pidText, boot, ns, start] = match ?? [];
  if (pidText === undefined || boot === undefined || ns === undefined || start === undefined) {
    return undefined; // Old-format (pre-ownership) dir — treated as legacy.
  }
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  return { pid, boot, ns, start };
}

/** Verdict on the gateway that created a dir, driving the sweep's keep/remove. */
type BundleMcpOwnerVerdict = "legacy" | "alive" | "dead";

/**
 * Classify a dir by the owner encoded in its name. `alive` may be a run still
 * waiting in the serialization queue whose CLI child has not spawned yet — no
 * argv references it, but deleting it would make that run spawn with a missing
 * `--mcp-config`. It also covers an owner the sweep cannot probe: one in a
 * different (or unverifiable) PID namespace, whose liveness this process cannot
 * see, so the dir is kept (over-protect). `dead` (pid gone, boot id changed by a
 * reboot, or the pid reused by a different process) means the queued run died
 * with its gateway, so the dir is reclaimable regardless of age. `legacy`
 * (unparseable old-format name) has no provable owner and is never auto-removed
 * (rolling-upgrade safe).
 */
async function resolveBundleMcpOwner(
  entryName: string,
  currentBoot: string,
  currentNs: string,
  isPidAlive: (pid: number) => boolean,
  readStartTicks: (pid: number) => Promise<string | undefined>,
): Promise<BundleMcpOwnerVerdict> {
  const owner = parseBundleMcpOwner(entryName);
  if (!owner) {
    return "legacy";
  }
  if (owner.boot !== NO_BOOT_ID && currentBoot !== NO_BOOT_ID && owner.boot !== currentBoot) {
    return "dead"; // Host rebooted since creation — the owning gateway is gone.
  }
  // `process.kill`/`/proc` liveness only means anything for a process in THIS
  // PID namespace. When the owner was created in a different namespace — e.g. a
  // separate container sharing the same `/tmp` mount — its pid here is either
  // absent (looks dead) or reused by an unrelated local process (start
  // mismatch), so a liveness verdict would delete a live foreign config. Trust
  // the pid probes only when the namespace provably matches; a different or
  // unverifiable namespace (NO_NS on either side) keeps the dir (over-protect),
  // mirroring the off-Linux and unknown-start fail-closed paths. The owner's own
  // namespace sweep — where the encoded ns matches — reclaims it once dead.
  if (owner.ns === NO_NS || currentNs === NO_NS || owner.ns !== currentNs) {
    return "alive";
  }
  if (!isPidAlive(owner.pid)) {
    return "dead";
  }
  if (owner.start === UNKNOWN_START) {
    // Creation could not record a start time, so pid reuse cannot be proven —
    // trust the live pid (fail closed) rather than risk deleting a live config.
    return "alive";
  }
  const actualStart = await readStartTicks(owner.pid);
  if (actualStart === undefined) {
    return "alive"; // Cannot verify start (off-Linux/hidden) — trust the pid (over-protect).
  }
  return actualStart === owner.start ? "alive" : "dead"; // start mismatch → pid reused → gone.
}

async function listPosixCommandLinesViaPs(): Promise<string[]> {
  try {
    const res = await execFileAsync("ps", ["-axww", "-o", "command="], {
      encoding: "utf8",
      timeout: PROCESS_SCAN_TIMEOUT_MS,
    });
    return res.stdout.split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

async function listLinuxCommandLinesViaProc(): Promise<string[]> {
  let pids: string[];
  try {
    pids = (await fs.readdir("/proc")).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return [];
  }
  const lines: string[] = [];
  for (const pid of pids) {
    try {
      lines.push((await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " "));
    } catch {
      // Process exited mid-scan or entry is unreadable — skip.
    }
  }
  return lines;
}

async function listWindowsCommandLines(): Promise<string[]> {
  try {
    const res = await execFileAsync(
      getWindowsPowerShellExePath(),
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine",
      ],
      { encoding: "utf8", timeout: PROCESS_SCAN_TIMEOUT_MS, windowsHide: true },
    );
    return res.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * List the command lines of all visible processes. Returns an empty array when
 * nothing could be listed, which callers must treat as "unknown" rather than
 * "no processes" (see fail-closed handling in the sweep).
 */
async function listProcessCommandLines(): Promise<string[]> {
  if (process.platform === "win32") {
    return await listWindowsCommandLines();
  }
  // `ps` is a single call and covers all POSIX platforms; minimal container
  // images without procps fall back to a direct /proc walk on Linux.
  const viaPs = await listPosixCommandLinesViaPs();
  if (viaPs.length > 0) {
    return viaPs;
  }
  if (process.platform === "linux") {
    return await listLinuxCommandLinesViaProc();
  }
  return [];
}

/**
 * Directories that some live process holds a descriptor into, from
 * `/proc/<pid>/fd`. Linux-only; returns undefined when `/proc` is unreadable
 * (callers must treat that as unknown, never as "nothing is held").
 *
 * This is the durable half of ownership. A CLI child receives a descriptor on
 * its MCP config at `fork` — strictly before `exec` — so it appears here during
 * the entire window in which its argv still belongs to the parent and names no
 * config. Argv answers "which config is this process using"; this answers "is
 * anyone holding this directory at all", which is the question that survives
 * the fork→exec transition.
 */
async function listDirsHeldByOpenDescriptors(tmpRoot: string): Promise<Set<string> | undefined> {
  if (process.platform !== "linux") {
    return undefined;
  }
  let pids: string[];
  try {
    pids = (await fs.readdir("/proc")).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return undefined;
  }
  const held = new Set<string>();
  const rootPrefix = `${tmpRoot}${path.sep}`;
  for (const pid of pids) {
    let fds: string[];
    try {
      fds = await fs.readdir(`/proc/${pid}/fd`);
    } catch {
      continue; // Exited mid-scan, or owned by another uid — skip.
    }
    for (const fd of fds) {
      try {
        const target = await fs.readlink(`/proc/${pid}/fd/${fd}`);
        if (!target.startsWith(rootPrefix)) {
          continue;
        }
        // Record the temp dir itself, not the file inside it.
        const rest = target.slice(rootPrefix.length);
        const first = rest.split(path.sep)[0];
        if (first) {
          held.add(path.join(tmpRoot, first));
        }
      } catch {
        // Descriptor closed mid-scan.
      }
    }
  }
  return held;
}

function lineReferencesDir(line: string, dir: string): boolean {
  // Live CLI children carry `--mcp-config <dir>/mcp.json` in their argv; the
  // bare-dir check keeps anything else that mentions the dir (safe direction).
  const configPath = path.join(dir, "mcp.json");
  if (process.platform === "win32") {
    const lowered = line.toLowerCase();
    return lowered.includes(configPath.toLowerCase()) || lowered.includes(dir.toLowerCase());
  }
  return line.includes(configPath) || line.includes(dir);
}

/**
 * Remove `openclaw-cli-mcp-*` temp dirs that no live process references.
 * Intended to run once at gateway startup (post-ready sidecar), mirroring
 * `cleanupStaleSessionLocks`.
 */
export async function sweepOrphanedBundleMcpTempDirs(params?: {
  /** Override the scanned root (tests). Defaults to `os.tmpdir()`. */
  tmpRoot?: string;
  /** Override the process scan (tests). */
  listCommandLines?: () => string[] | Promise<string[]>;
  /** Override the owner liveness probe (tests). Defaults to `process.kill(pid, 0)`. */
  isPidAlive?: (pid: number) => boolean;
  /** Override the process start-time probe (tests). Defaults to `/proc/<pid>/stat`. */
  readStartTicks?: (pid: number) => Promise<string | undefined>;
  /** Override the current boot tag (tests). Defaults to the host boot-id prefix on Linux. */
  currentBoot?: string;
  /** Override the current PID-namespace tag (tests). Defaults to the host ns inode on Linux. */
  currentNs?: string;
  /** Override the post-verdict settle delay in ms (tests pass 0). */
  settleMs?: number;
  /** Override the delay implementation (tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Override the open-descriptor probe (tests). Undefined result = unknown. */
  listHeldDirs?: (tmpRoot: string) => Promise<Set<string> | undefined>;
  /**
   * The sidecar's abort signal. Cuts the settle short on gateway close and
   * stops the sweep before any removal — a cleanup must never outlive the
   * cancellation that asked it to stop.
   */
  signal?: AbortSignal;
  log?: { warn: (msg: string) => void };
}): Promise<{ removed: string[]; kept: string[] }> {
  const tmpRoot = params?.tmpRoot ?? os.tmpdir();
  const isPidAlive = params?.isPidAlive ?? defaultIsPidAlive;
  const readStartTicks = params?.readStartTicks ?? defaultReadStartTicks;
  const removed: string[] = [];
  const kept: string[] = [];

  let entries: string[];
  try {
    entries = (await fs.readdir(tmpRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(BUNDLE_MCP_TEMP_PREFIX))
      .map((entry) => entry.name);
  } catch {
    return { removed, kept };
  }
  if (entries.length === 0) {
    return { removed, kept };
  }

  // One process scan covers the whole sweep. Fail closed when it yields
  // nothing: an empty result is indistinguishable from a restricted
  // environment, and keeping a leaked dir beats breaking a live run.
  const commandLines = await (params?.listCommandLines ?? listProcessCommandLines)();
  if (commandLines.length === 0) {
    return { removed, kept: entries.map((entry) => path.join(tmpRoot, entry)) };
  }

  const currentBoot = params?.currentBoot ?? (await readBootTag());
  const currentNs = params?.currentNs ?? (await readPidNamespaceTag());

  // Phase 1 — classify. A dir becomes a removal candidate only when nothing live
  // references it AND its encoded owner is provably gone. Age plays no part: an
  // owner-encoded dir is judged by owner liveness (a dead owner's config is
  // reclaimable at any age, so a prompt restart reclaims its own fresh crash
  // debris), and a legacy dir is never a candidate at all.
  const candidates: string[] = [];
  let legacyRetained = 0;
  for (const entry of entries) {
    const dir = path.join(tmpRoot, entry);
    if (commandLines.some((line) => lineReferencesDir(line, dir))) {
      // A live CLI child (of this gateway, a concurrent gateway, or a
      // persistent live session) still references the config — keep (#73244).
      kept.push(dir);
      continue;
    }
    const owner = await resolveBundleMcpOwner(
      entry,
      currentBoot,
      currentNs,
      isPidAlive,
      readStartTicks,
    );
    if (owner === "alive") {
      // A queued run of a live gateway whose child has not spawned yet (the
      // config is created at prepare time, before `enqueueCliRun`).
      kept.push(dir);
      continue;
    }
    if (owner === "legacy") {
      // Old-format dir with no encoded owner. Its owner cannot be proven, so it
      // is never auto-removed: during a rolling upgrade a concurrently running
      // older gateway could still hold an unspawned queued run for it. Keep it
      // and surface the count below for explicit operator cleanup.
      legacyRetained += 1;
      kept.push(dir);
      continue;
    }
    candidates.push(dir); // owner === "dead": owning gateway provably gone.
  }

  if (legacyRetained > 0) {
    params?.log?.warn(
      `bundle MCP temp sweep: retained ${legacyRetained} legacy (pre-ownership) temp dir(s); ` +
        "these are never auto-removed to stay rolling-upgrade safe. To reclaim pre-upgrade " +
        `leaks, stop the gateway and remove stale ${BUNDLE_MCP_TEMP_PREFIX}* dirs by hand.`,
    );
  }

  if (candidates.length === 0) {
    return { removed, kept };
  }

  // Phase 1.5 — settle. Every candidate's owner is now provably dead, so any
  // child of it was forked strictly before that death. Waiting here lets a
  // child caught mid-fork complete its `exec` and become argv-visible, which
  // turns the re-scan below from a narrowing heuristic into a decisive check
  // (see POST_VERDICT_SETTLE_MS).
  const settleMs = params?.settleMs ?? POST_VERDICT_SETTLE_MS;
  if (settleMs > 0 && !params?.signal?.aborted) {
    await (params?.sleep ?? defaultSleep)(settleMs, params?.signal);
  }

  // A close that arrived before or during the settle cancels the sweep: keep
  // every candidate and remove nothing. Deleting after cancellation began would
  // let this cleanup outlive the gateway generation that scheduled it.
  if (params?.signal?.aborted) {
    return { removed, kept: [...kept, ...candidates] };
  }

  // Phase 2 — the durable check, then the argv re-scan, immediately before
  // removing.
  //
  // The descriptor probe is what makes this decisive rather than timing-bound:
  // a CLI child inherits a descriptor on its config at `fork`, so it is visible
  // here even while still pre-`exec` and argv-invisible. On Linux this covers
  // the fork→exec window by construction. Off-Linux the probe returns undefined
  // (unknown) and the argv re-scan after the settle remains the only signal, so
  // the settle is retained as the second line rather than the only one.
  const heldDirs = await (params?.listHeldDirs ?? listDirsHeldByOpenDescriptors)(tmpRoot);
  const recheck = await (params?.listCommandLines ?? listProcessCommandLines)();
  const recheckUsable = recheck.length > 0;
  for (const dir of candidates) {
    if (heldDirs?.has(dir)) {
      // Someone holds a descriptor into it — claimed, whether or not it has
      // execed yet. This is the pre-exec case argv cannot answer.
      kept.push(dir);
      continue;
    }
    if (!recheckUsable || recheck.some((line) => lineReferencesDir(line, dir))) {
      kept.push(dir);
      continue;
    }
    try {
      await fs.rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (err) {
      params?.log?.warn(`bundle MCP temp sweep: failed to remove ${dir}: ${String(err)}`);
      kept.push(dir);
    }
  }
  return { removed, kept };
}
