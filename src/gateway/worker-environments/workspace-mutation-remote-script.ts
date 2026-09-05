import { REMOTE_WORKSPACE_MUTATION_LOCK_JS } from "./workspace-mutation-lock-remote-script.js";
import {
  WORKSPACE_PATH_EXCLUSIONS_JS,
  WORKSPACE_STAGED_INPUT_OWNERSHIP_JS,
} from "./workspace-path-exclusions.js";

export const REMOTE_WORKSPACE_MUTATION_CONTEXT_JS = String.raw`const mutationActions = [
  "begin", "apply", "rollback", "recover", "commit", "settle", "receiver", "reset",
];
const workspace = process.argv[1];
const canonicalHome = process.argv[2];
const remoteRelative = process.argv[3];
const nonce = process.argv[4];
const currentHome = process.env.HOME;
if (
  !currentHome ||
  typeof workspace !== "string" ||
  typeof canonicalHome !== "string" ||
  typeof remoteRelative !== "string" ||
  !path.posix.isAbsolute(canonicalHome) ||
  path.posix.normalize(canonicalHome) !== canonicalHome ||
  path.posix.isAbsolute(remoteRelative) ||
  path.posix.normalize(remoteRelative) !== remoteRelative ||
  path.posix.join(canonicalHome, remoteRelative) !== workspace ||
  !/^[a-f0-9]{32}$/.test(nonce || "") ||
  fs.realpathSync(currentHome) !== canonicalHome
) {
  throw new Error("worker workspace mutation no longer matches its attested owner");
}
const workspaceStats = fs.lstatSync(workspace);
if (
  !workspaceStats.isDirectory() ||
  workspaceStats.isSymbolicLink() ||
  fs.realpathSync(workspace) !== workspace
) {
  throw new Error("worker workspace mutation no longer matches its attested owner");
}
const root = workspace;
const transactionRoot = path.dirname(root);
const transactionRootStats = fs.lstatSync(transactionRoot);
if (transactionRootStats.isSymbolicLink() || !transactionRootStats.isDirectory()) {
  throw new Error("unsafe workspace mutation directory");
}
const workspaceKey = crypto.createHash("sha256").update(root).digest("hex");
function removeTree(target) {
  let stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  if (stats.isDirectory() && !stats.isSymbolicLink()) {
    fs.chmodSync(target, 0o700);
    for (const name of fs.readdirSync(target)) removeTree(path.join(target, name));
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
}
function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}`;

export const REMOTE_WORKSPACE_RSYNC_RECEIVER_RUNTIME_JS = String.raw`const receiverArgs = process.argv.slice(receiverArgvIndex);
const receiverDestination = receiverArgs.at(-1);
if (
  receiverArgs[0] !== "--server" ||
  receiverArgs.includes("--sender") ||
  typeof receiverDestination !== "string" ||
  !path.posix.isAbsolute(receiverDestination) ||
  path.posix.normalize(receiverDestination).replace(/\/+$/, "") !== receiverTarget
) {
  throw new Error("invalid worker workspace rsync receiver command");
}
const receiver = childProcess.spawn(
  "sh",
  ["-c", 'IFS= read -r gate <&3 && [ "$gate" = open ] && exec rsync "$@"', "openclaw-rsync", ...receiverArgs],
  { detached: true, stdio: ["inherit", "inherit", "inherit", "pipe"] },
);
if (!Number.isSafeInteger(receiver.pid) || receiver.pid < 1) {
  throw new Error("worker workspace rsync receiver did not start");
}
const lockOwnerPid = receiver.pid;
${REMOTE_WORKSPACE_MUTATION_LOCK_JS}
const receiverExit = new Promise((resolve, reject) => {
  receiver.once("error", reject);
  receiver.once("close", (code, signal) => resolve({ code, signal }));
});
const gate = receiver.stdio[3];
let lockAcquired = false;
let gateOpened = false;
(async () => {
  try {
    acquireWorkspaceLock();
    lockAcquired = true;
    validateReceiverTarget();
    gateOpened = true;
    gate.end("open\n");
    const result = await receiverExit;
    const groupWait = new Int32Array(new SharedArrayBuffer(4));
    while (processGroupIsAlive(lockOwnerPid)) Atomics.wait(groupWait, 0, 0, 10);
    releaseWorkspaceLock();
    lockAcquired = false;
    if (result.signal) process.kill(process.pid, result.signal);
    process.exitCode = result.code === null ? 1 : result.code;
  } finally {
    if (!gateOpened) gate.end();
    await receiverExit.catch(() => undefined);
    if (lockAcquired) releaseWorkspaceLock();
  }
})().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + "\n");
  process.exitCode = 1;
});`;

export const REMOTE_WORKSPACE_RSYNC_RECEIVER_JS = String.raw`const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const action = "receiver";
${REMOTE_WORKSPACE_MUTATION_CONTEXT_JS}
const receiverTarget = process.argv[5];
function validateReceiverTarget() {
  if (
    typeof receiverTarget !== "string" ||
    !path.posix.isAbsolute(receiverTarget) ||
    path.posix.normalize(receiverTarget) !== receiverTarget ||
    (receiverTarget !== root && path.posix.dirname(receiverTarget) !== root)
  ) {
    throw new Error("invalid worker workspace rsync receiver target");
  }
  if (receiverTarget === root) return;
  try {
    if (fs.lstatSync(receiverTarget).isSymbolicLink()) {
      throw new Error("unsafe worker workspace rsync receiver target");
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}
validateReceiverTarget();
const receiverArgvIndex = 6;
${REMOTE_WORKSPACE_RSYNC_RECEIVER_RUNTIME_JS}`;

export const REMOTE_GIT_WORKSPACE_RETRY_RESET_JS = String.raw`const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const action = "reset";
${REMOTE_WORKSPACE_MUTATION_CONTEXT_JS}
const lockOwnerPid = process.pid;
${REMOTE_WORKSPACE_MUTATION_LOCK_JS}
${WORKSPACE_PATH_EXCLUSIONS_JS}
${WORKSPACE_STAGED_INPUT_OWNERSHIP_JS}
function clean(directory, relativeDirectory) {
  const originalMode = fs.lstatSync(directory).mode & 0o7777;
  fs.chmodSync(directory, originalMode | 0o700);
  for (const name of fs.readdirSync(directory)) {
    const relative = relativeDirectory ? relativeDirectory + "/" + name : name;
    // Match the initial rsync receiver protections exactly: retry cleanup owns
    // transferable workspace bytes, never Git metadata or derived scratch state.
    if (name === ".git" || isDerivedWorkspacePath(relative, isStagedInput(relative))) continue;
    const target = path.join(directory, name);
    const stats = fs.lstatSync(target);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      clean(target, relative);
      if (fs.readdirSync(target).length === 0) fs.rmdirSync(target);
    } else {
      fs.unlinkSync(target);
    }
  }
  fs.chmodSync(directory, originalMode);
}
acquireWorkspaceLock();
try {
  clean(root, "");
  process.stdout.write("reset " + nonce + "\n");
} finally {
  releaseWorkspaceLock();
}`;
