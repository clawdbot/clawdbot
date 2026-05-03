import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [summaryPath, phase, separator, command, ...args] = process.argv.slice(2);
if (!summaryPath || !phase || separator !== "--" || !command) {
  console.error("usage: measure.mjs <summary.tsv> <phase> -- <command> [args...]");
  process.exit(2);
}

const pageSize = Number.parseInt(process.env.OPENCLAW_PROC_PAGE_SIZE || "4096", 10);
const clockTicks = Number.parseInt(process.env.OPENCLAW_PROC_CLK_TCK || "100", 10);
const pollMs = Number.parseInt(process.env.OPENCLAW_PLUGIN_LIFECYCLE_METRIC_POLL_MS || "100", 10);

if (!fs.existsSync("/proc")) {
  console.error("plugin lifecycle resource sampler requires Linux /proc");
  process.exit(2);
}

function readProcSnapshot() {
  const stats = new Map();
  for (const entry of fs.readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
      continue;
    }
    const pid = Number.parseInt(entry.name, 10);
    const statPath = path.join("/proc", entry.name, "stat");
    try {
      const raw = fs.readFileSync(statPath, "utf8");
      const closeParen = raw.lastIndexOf(")");
      if (closeParen === -1) {
        continue;
      }
      const fields = raw
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/u);
      const ppid = Number.parseInt(fields[1] ?? "", 10);
      const userTicks = Number.parseInt(fields[11] ?? "", 10);
      const systemTicks = Number.parseInt(fields[12] ?? "", 10);
      const rssPages = Number.parseInt(fields[21] ?? "", 10);
      if (
        !Number.isFinite(ppid) ||
        !Number.isFinite(userTicks) ||
        !Number.isFinite(systemTicks) ||
        !Number.isFinite(rssPages)
      ) {
        continue;
      }
      stats.set(pid, {
        ppid,
        cpuTicks: userTicks + systemTicks,
        rssBytes: Math.max(0, rssPages) * pageSize,
      });
    } catch {
      // Processes can exit while /proc is being scanned.
    }
  }
  return stats;
}

function descendantsOf(rootPid, stats) {
  const children = new Map();
  for (const [pid, stat] of stats.entries()) {
    const siblings = children.get(stat.ppid) ?? [];
    siblings.push(pid);
    children.set(stat.ppid, siblings);
  }
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of children.get(queue[index]) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return seen;
}

function sample(rootPid) {
  const stats = readProcSnapshot();
  const pids = descendantsOf(rootPid, stats);
  let rssBytes = 0;
  let cpuTicks = 0;
  for (const pid of pids) {
    const stat = stats.get(pid);
    if (!stat) {
      continue;
    }
    rssBytes += stat.rssBytes;
    cpuTicks += stat.cpuTicks;
  }
  return { rssBytes, cpuTicks };
}

const started = performance.now();
const child = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

let maxRssBytes = 0;
let maxCpuTicks = 0;
const updateMetrics = () => {
  if (!child.pid) {
    return;
  }
  const current = sample(child.pid);
  maxRssBytes = Math.max(maxRssBytes, current.rssBytes);
  maxCpuTicks = Math.max(maxCpuTicks, current.cpuTicks);
};

updateMetrics();
const interval = setInterval(updateMetrics, pollMs);

child.on("exit", (code, signal) => {
  updateMetrics();
  clearInterval(interval);
  const wallMs = performance.now() - started;
  const cpuSeconds = maxCpuTicks / clockTicks;
  const maxRssKb = Math.round(maxRssBytes / 1024);
  const cpuCoreRatio = wallMs > 0 ? cpuSeconds / (wallMs / 1000) : 0;
  fs.appendFileSync(
    summaryPath,
    `${phase}\t${maxRssKb}\t${cpuSeconds.toFixed(3)}\t${wallMs.toFixed(0)}\t${cpuCoreRatio.toFixed(3)}\t${signal ?? ""}\n`,
  );
  console.log(
    `plugin lifecycle resource: phase=${phase} max_rss_kb=${maxRssKb} cpu_s=${cpuSeconds.toFixed(3)} wall_ms=${wallMs.toFixed(0)} cpu_core_ratio=${cpuCoreRatio.toFixed(3)}`,
  );
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
