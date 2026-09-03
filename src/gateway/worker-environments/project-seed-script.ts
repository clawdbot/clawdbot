import {
  selectWorkspaceSeedsToPrune,
  WORKSPACE_SEED_RETENTION,
} from "../../worker/workspace-seed-retention.js";

type ProjectSeedScriptInput = {
  namespace: string;
  seedKey: string;
  baseCommit: string;
  pack?: { directory: string; sha256: string; bytes: number };
};

/** Only immutable Git content and non-secret preparation metadata enter the machine image. */
export function createProjectSeedScript(input: ProjectSeedScriptInput): string {
  return `set -eu
node <<'PROJECT_SEED_SCRIPT'
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const input = ${JSON.stringify(input)};
const retention = ${JSON.stringify(WORKSPACE_SEED_RETENTION)};
const selectSeedsToPrune = ${selectWorkspaceSeedsToPrune.toString()};
process.umask(0o077);
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
const git = (root, args, stdin) => {
  const result = spawnSync("git", ["-c", "core.hooksPath=" + os.devNull, "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "core.askPass=", "-c", "init.templateDir=", "-C", root, ...args], { env, encoding: "utf8", timeout: 600000, maxBuffer: 262144, stdio: [stdin ?? "ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error("Project Git preparation failed: " + (result.stderr?.trim() || result.error?.message || "exit " + result.status));
  return result.stdout.trim();
};
const ownedDirectory = (parent, target) => {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory() || path.dirname(fs.realpathSync(target)) !== parent) throw new Error("Project seed directory escaped its owner");
  return stat;
};
(async () => {
  const home = fs.realpathSync(os.homedir());
  const workerRoot = path.join(home, ".openclaw-worker");
  fs.mkdirSync(workerRoot, { recursive: true, mode: 0o700 });
  ownedDirectory(home, workerRoot);
  const root = path.join(workerRoot, "git-seeds");
  fs.mkdirSync(root, { mode: 0o700, recursive: true });
  ownedDirectory(workerRoot, root);
  const namespace = path.join(root, input.namespace);
  fs.mkdirSync(namespace, { recursive: true, mode: 0o700 });
  ownedDirectory(root, namespace);
  const prune = () => {
    const entries = fs.readdirSync(namespace, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, mtimeMs: ownedDirectory(namespace, path.join(namespace, entry.name)).mtimeMs }));
    for (const entry of selectSeedsToPrune(entries, retention, Date.now(), input.seedKey)) {
      const target = path.join(namespace, entry.name);
      if (ownedDirectory(namespace, target).mtimeMs === entry.mtimeMs) fs.rmSync(target, { recursive: true });
    }
  };
  const seed = path.join(namespace, input.seedKey);
  const stagingPrefix = ".tmp-" + input.seedKey + "-";
  if (!input.pack) {
    if (fs.existsSync(seed)) {
      ownedDirectory(namespace, seed);
      ownedDirectory(seed, path.join(seed, ".git"));
      if (git(seed, ["rev-parse", "--verify", "HEAD"]) !== input.baseCommit || git(seed, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Prepared project seed is not pristine");
      prune();
      process.stdout.write(JSON.stringify({ ready: true }));
      return;
    }
    // Provisioning serializes this lease. Discard only this project's abandoned staging.
    for (const entry of fs.readdirSync(namespace)) {
      if (!entry.startsWith(stagingPrefix)) continue;
      const stale = path.join(namespace, entry);
      ownedDirectory(namespace, stale);
      fs.rmSync(stale, { recursive: true });
    }
    const directory = fs.mkdtempSync(path.join(namespace, stagingPrefix));
    process.stdout.write(JSON.stringify({ ready: false, directory }));
    return;
  }
  const directory = input.pack.directory;
  if (path.dirname(directory) !== namespace || !path.basename(directory).startsWith(stagingPrefix)) throw new Error("Project staging path escaped its owner");
  ownedDirectory(namespace, directory);
  try {
    const pack = path.join(directory, "base.pack");
    const stat = fs.lstatSync(pack);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== input.pack.bytes) throw new Error("Project pack size does not match");
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(pack)) hash.update(chunk);
    if (hash.digest("hex") !== input.pack.sha256) throw new Error("Project pack digest does not match");
    const repository = path.join(directory, "repository");
    fs.mkdirSync(repository, { mode: 0o700 });
    git(repository, ["init", "--quiet", "--object-format=" + (input.baseCommit.length === 40 ? "sha1" : "sha256"), "."]);
    const fd = fs.openSync(pack, "r");
    try { git(repository, ["index-pack", "--stdin"], fd); } finally { fs.closeSync(fd); }
    fs.writeFileSync(path.join(repository, ".git", "shallow"), input.baseCommit + "\\n", { mode: 0o600 });
    if (git(repository, ["rev-parse", "--verify", input.baseCommit + "^{commit}"]) !== input.baseCommit) throw new Error("Project pack commit does not match");
    git(repository, ["checkout", "--detach", "--force", input.baseCommit]);
    git(repository, ["fsck", "--connectivity-only", "--no-reflogs"]);
    if (git(repository, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Prepared project checkout is not pristine");
    fs.renameSync(repository, seed);
    prune();
    process.stdout.write(JSON.stringify({ ready: true }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
PROJECT_SEED_SCRIPT`;
}
