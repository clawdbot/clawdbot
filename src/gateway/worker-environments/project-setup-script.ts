import { MAX_WORKSPACE_MANIFEST_BYTES } from "./workspace-inventory-limits.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

export const PREPARE_PROJECT_WORKSPACE_JS = `async (input, inspectOnly = false) => {
const startedAt = performance.now();
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const manifestScript = ${JSON.stringify(REMOTE_WORKSPACE_MANIFEST_JS)};
process.umask(0o077);
const machineHome = fs.realpathSync(os.homedir());
const env = { PATH: process.env.PATH, HOME: machineHome, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: os.devNull, GIT_CONFIG_KEY_1: "core.fsmonitor", GIT_CONFIG_VALUE_1: "false", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
const ownedDirectory = (parent, name, create = false) => {
  const target = path.join(parent, name);
  if (create && !fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(target) !== target) throw new Error("Prepared project directory escaped its owner");
  return target;
};
const git = (root, args) => {
  const result = spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8", timeout: 30000, maxBuffer: 262144 });
  if (result.status !== 0) throw new Error("Prepared project Git verification failed");
  return result.stdout.trim();
};
const manifest = (root, baseCommit = input.baseCommit) => {
  const result = spawnSync(process.execPath, ["-e", manifestScript, root, baseCommit, "eligible"], { env, encoding: "utf8", timeout: 600000, maxBuffer: 262144 });
  if (result.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(result.stdout.trim())) throw new Error("Prepared project manifest verification failed: " + (result.stderr?.trim() || result.error?.message || result.status));
  return result.stdout.trim();
};
const readManifest = (file, ref) => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > ${MAX_WORKSPACE_MANIFEST_BYTES}) throw new Error("Prepared project manifest is unsafe");
    const bytes = fs.readFileSync(fd);
    if ("sha256:" + crypto.createHash("sha256").update(bytes).digest("hex") !== ref) throw new Error("Prepared project source manifest changed");
    return bytes;
  } finally { fs.closeSync(fd); }
};
const runSetup = (script, workspaceDir, homeDir) => {
  // Verification and copying consume this command's budget before repository code starts.
  const timeoutMs = input.timeoutMs - (performance.now() - startedAt);
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs > 2147483647 || timeoutMs <= 0) throw new Error("Prepared project command budget exhausted");
  let child;
  let timeout;
  let stderr = "";
  let failure;
  // A deadline/signal may retire the group before exit; never signal that group twice.
  let killed = false;
  const killGroup = () => {
    if (child?.pid && !killed) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      killed = true;
    }
  };
  const stop = (reason) => { failure ??= reason; killGroup(); };
  const signals = ["SIGTERM", "SIGINT"].map((signal) => [signal, () => stop("interrupted by " + signal)]);
  // A recipe can signal its parent before spawn returns. Own those signals
  // before it starts, and release them even when spawn throws synchronously.
  for (const [signal, handler] of signals) process.once(signal, handler);
  return new Promise((resolve, reject) => {
    child = spawn(script, [], {
      cwd: workspaceDir,
      env: { PATH: process.env.PATH, HOME: homeDir, LANG: "C.UTF-8", OPENCLAW_SOURCE_TREE_PATH: workspaceDir, OPENCLAW_WORKTREE_PATH: workspaceDir },
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    timeout = setTimeout(() => stop("timed out within the provider command budget (" + input.timeoutMs + " ms)"), timeoutMs);
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-16384); });
    child.once("error", (error) => { failure ??= error.message; });
    // Descendants can retain stderr after the script exits. Kill them at exit,
    // then await close to prove all inherited pipes are drained before capture.
    child.once("exit", killGroup);
    child.once("close", (code) => {
      if (code !== 0 || failure) reject(new Error("Prepared project setup failed: " + (failure || stderr.trim() || "exit " + code)));
      else resolve();
    });
  }).finally(() => {
    clearTimeout(timeout);
    for (const [signal, handler] of signals) process.removeListener(signal, handler);
  });
};
  const workerRoot = ownedDirectory(machineHome, ".openclaw-worker");
  // Inspection cannot create a workspace or execute repository code before the Gateway rechecks its owner.
  if (inspectOnly && !fs.existsSync(path.join(workerRoot, "prepared", input.namespace, input.cacheKey))) return;
  const existing = path.join(workerRoot, "prepared", input.namespace, input.cacheKey);
  let previous;
  if (fs.existsSync(existing)) {
    const parent = ownedDirectory(ownedDirectory(workerRoot, "prepared"), input.namespace);
    const directory = ownedDirectory(parent, input.cacheKey);
    const workspaceDir = ownedDirectory(directory, "workspace");
    const homeDir = ownedDirectory(directory, "home");
    const admin = ownedDirectory(workspaceDir, ".git");
    if (fs.existsSync(path.join(admin, "objects", "info", "alternates")) || fs.existsSync(path.join(admin, "info", "grafts"))) throw new Error("Prepared project Git base is not standalone");
    const baseCommit = git(workspaceDir, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(baseCommit)) throw new Error("Prepared project Git base is invalid");
    git(workspaceDir, ["fsck", "--full", "--strict", "--no-reflogs", baseCommit]);
    const sourceManifestRef = manifest(workspaceDir, baseCommit);
    const manifestRoot = ownedDirectory(ownedDirectory(homeDir, ".openclaw-worker"), "manifests");
    const completedManifest = path.join(manifestRoot, sourceManifestRef.slice(7) + ".json");
    readManifest(completedManifest, sourceManifestRef);
    previous = { workspaceDir, homeDir, sourceManifestRef, baseCommit, completedManifest };
    if (inspectOnly) return previous;
  }
  const seeds = ownedDirectory(ownedDirectory(workerRoot, "git-seeds"), input.namespace);
  const seed = ownedDirectory(seeds, input.seedKey);
  ownedDirectory(seed, ".git");
  if (git(seed, ["rev-parse", "HEAD"]) !== input.baseCommit || git(seed, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Prepared project seed is not pristine");
  const recipe = git(seed, ["ls-tree", input.baseCommit, "--", ".openclaw/worktree-setup.sh"]);
  const expectedRecipe = input.setupRecipe ? "100755 blob " + input.setupRecipe + "\\t.openclaw/worktree-setup.sh" : null;
  if (expectedRecipe ? recipe !== expectedRecipe : recipe.startsWith("100755 ")) throw new Error("Prepared project setup recipe differs from its admission");
  const sourceManifestRef = manifest(seed);
  const sourceFile = path.join(workerRoot, "manifests", sourceManifestRef.slice(7) + ".json");
  const sourceBytes = readManifest(sourceFile, sourceManifestRef);
  const preparedRoot = ownedDirectory(ownedDirectory(workerRoot, "prepared", !inspectOnly), input.namespace, !inspectOnly);
  const directory = path.join(preparedRoot, input.cacheKey);
  const fresh = !fs.existsSync(directory);
  if (fresh && inspectOnly) return;
  ownedDirectory(preparedRoot, input.cacheKey, fresh);
  if (fresh) {
    fs.mkdirSync(path.join(directory, "home"), { mode: 0o700 });
    fs.cpSync(seed, path.join(directory, "workspace"), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  }
  const workspaceDir = ownedDirectory(directory, "workspace");
  const homeDir = ownedDirectory(directory, "home");
  const manifestRoot = ownedDirectory(ownedDirectory(homeDir, ".openclaw-worker", fresh), "manifests", fresh);
  const completedManifest = path.join(manifestRoot, sourceManifestRef.slice(7) + ".json");
  const changed = previous && previous.baseCommit !== input.baseCommit;
  if (changed) {
    // Invalidate the only completion witness before touching Git or running code.
    // An interrupted update cannot replay setup, even when returning to an older commit.
    fs.unlinkSync(previous.completedManifest);
    git(workspaceDir, ["fetch", "--depth=1", "--no-tags", "--no-write-fetch-head", "--update-shallow", seed, input.baseCommit]);
    git(workspaceDir, ["checkout", "--detach", "--force", input.baseCommit]);
  } else if (!fresh) {
    readManifest(completedManifest, sourceManifestRef);
  }
  if ((fresh || changed) && input.setupRecipe) {
    const script = path.join(ownedDirectory(workspaceDir, ".openclaw"), "worktree-setup.sh");
    const stat = fs.lstatSync(script);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) throw new Error("Prepared project setup is not an executable regular file");
    await runSetup(script, workspaceDir, homeDir);
  }
  ownedDirectory(directory, "workspace");
  ownedDirectory(directory, "home");
  ownedDirectory(ownedDirectory(homeDir, ".openclaw-worker"), "manifests");
  ownedDirectory(workspaceDir, ".git");
  if (git(workspaceDir, ["rev-parse", "HEAD"]) !== input.baseCommit || manifest(workspaceDir) !== sourceManifestRef) throw new Error("Prepared project setup modified its source manifest");
  if (fresh || changed) fs.writeFileSync(completedManifest, sourceBytes, { flag: "wx", mode: 0o600 });
  return { workspaceDir, homeDir, sourceManifestRef };
}`;

/** Setup runs at the final absolute paths, before enrollment or session overlays. */
export function createProjectSetupScript(input: {
  namespace: string;
  seedKey: string;
  preparationKey: string;
  cacheKey: string;
  baseCommit: string;
  setupRecipe?: string;
  timeoutMs?: number;
}): string {
  return `set -eu
node <<'PROJECT_SETUP_SCRIPT'
(${PREPARE_PROJECT_WORKSPACE_JS})(${JSON.stringify(input)})
  .then((result) => process.stdout.write(JSON.stringify(result)))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
PROJECT_SETUP_SCRIPT`;
}
