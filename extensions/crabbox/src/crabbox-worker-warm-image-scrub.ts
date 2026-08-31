// Enrollment roots its identity, device token, bundles, and node-host workspaces
// under OPENCLAW_STATE_DIR here; deleting it is the cross-session data boundary.
// Crabbox's separate checkpoint workdir never receives session files (--no-sync).
// SSH session workspaces must also be scrubbed; sibling bundle installs and git-seeds
// in .openclaw-worker are machine-level caches and intentionally survive.
export const SCRUB_WORKER_STATE = `set -eu
worker_root="$HOME/.openclaw/cloud-workers"
node <<'CRABBOX_SCRUB_NODE_SCRIPT'
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const root = path.join(os.homedir(), ".openclaw", "cloud-workers");
const runtimeRoot = path.join(os.homedir(), ".openclaw-worker", "node-runtimes") + path.sep;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const stateDir = path.join(root, entry.name);
    const pidFile = path.join(stateDir, "node.pid");
    if (!fs.existsSync(pidFile)) continue;
    const pidText = fs.readFileSync(pidFile, "utf8").trim();
    if (!/^[1-9][0-9]*$/.test(pidText)) throw new Error("Cannot scrub a worker with an invalid node PID");
    const pid = Number(pidText);
    const owned = () => {
      let stat;
      try { stat = fs.readFileSync(path.join("/proc", pidText, "stat"), "utf8"); }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z") return false;
      const runtime = fs.realpathSync(path.join(stateDir, "runtime"));
      const cwd = fs.realpathSync(path.join("/proc", pidText, "cwd"));
      const env = fs.readFileSync(path.join("/proc", pidText, "environ"), "utf8").split("\\0");
      if (!runtime.startsWith(runtimeRoot) || cwd !== runtime || Number(fields[2]) !== pid || !env.includes("OPENCLAW_STATE_DIR=" + stateDir)) throw new Error("Cannot scrub a worker whose live node ownership does not match");
      return true;
    };
    if (!owned()) continue;
    process.kill(-pid, "SIGTERM");
    await delay(1000);
    if (owned()) process.kill(-pid, "SIGKILL");
    for (let attempt = 0; attempt < 50 && owned(); attempt++) await delay(20);
    if (owned()) throw new Error("Cloud worker node did not exit before image capture");
  }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
CRABBOX_SCRUB_NODE_SCRIPT
rm -rf "$worker_root"
rm -rf "$HOME/.openclaw-worker/workspaces"
# Crabbox's forwarded-env cleanup only warns on failure; native images include its workdir.
# Replace the shell for this final command so deleting its uploaded script cannot interrupt cleanup.
exec rm -rf -- .crabbox/env .crabbox/scripts
`;
