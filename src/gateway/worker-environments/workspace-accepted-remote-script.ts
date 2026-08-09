import { REMOTE_WORKSPACE_ACCEPTED_LOCK_JS } from "./workspace-accepted-lock-remote-script.js";

export const REMOTE_WORKSPACE_ACCEPTED_TRANSACTION_JS = String.raw`const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const action = process.argv[1];
const acceptedActions = ["begin", "apply", "rollback", "recover", "commit", "settle"];
if (!acceptedActions.includes(action)) throw new Error("invalid accepted workspace transaction action");
const root = fs.realpathSync(process.argv[2]);
const nonce = process.argv[3];
if (!/^[a-f0-9]{32}$/.test(nonce || "")) throw new Error("invalid accepted workspace transaction");
// REMOTE_WORKSPACE_SETUP_SCRIPT creates and chmods every workspace parent for this worker.
// Keeping the transaction beside the workspace makes all live swaps same-filesystem renames.
const transactionRoot = path.dirname(root);
const transactionRootStats = fs.lstatSync(transactionRoot);
if (transactionRootStats.isSymbolicLink() || !transactionRootStats.isDirectory()) {
  throw new Error("unsafe accepted workspace transaction directory");
}
const workspaceKey = crypto.createHash("sha256").update(root).digest("hex");
const transactionPrefix = ".openclaw-accepted-" + workspaceKey + "-";
const cleanupPrefix = ".openclaw-accepted-cleanup-" + workspaceKey + "-";
const transaction = path.join(transactionRoot, transactionPrefix + nonce);
const cleanup = path.join(transactionRoot, cleanupPrefix + nonce);
const nextRoot = path.join(transaction, "next");
const backupRoot = path.join(transaction, "backup");
const pathsFile = path.join(transaction, "paths.json");
const stateFile = path.join(transaction, "state.json");
const ancestorModesFile = path.join(transaction, "ancestor-modes.json");
function isSafeRelativePath(relative) {
  return (
    typeof relative === "string" &&
    relative &&
    !relative.includes("\\") &&
    !path.posix.isAbsolute(relative) &&
    path.posix.normalize(relative) === relative &&
    relative !== "." &&
    relative !== ".." &&
    relative !== ".git" &&
    !relative.startsWith(".git/") &&
    !relative.startsWith("../")
  );
}
function parsePaths(raw) {
  const values = JSON.parse(raw);
  if (!Array.isArray(values) || values.length > 25_000) {
    throw new Error("invalid accepted workspace paths");
  }
  const paths = [...new Set(values)];
  for (const relative of paths) {
    if (!isSafeRelativePath(relative)) throw new Error("unsafe accepted workspace path");
  }
  const selected = new Set(paths);
  // Directory modes are canonical, so a changed directory is added, removed, or
  // replaced and all of its accepted descendants are changed and staged too.
  return paths
    .filter((relative) => {
      const segments = relative.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        if (selected.has(segments.slice(0, index).join("/"))) return false;
      }
      return true;
    })
    .sort();
}
function targetPath(base, relative) {
  return path.join(base, relative);
}
function livePath(relative) {
  const segments = relative.split("/");
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    const stats = fs.lstatSync(parent);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("unsafe accepted workspace parent");
    }
  }
  return path.join(root, relative);
}
function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}
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
}
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") return true;
    if (error && error.code === "ESRCH") return false;
    throw error;
  }
}
${REMOTE_WORKSPACE_ACCEPTED_LOCK_JS}
function readPaths() {
  return parsePaths(fs.readFileSync(pathsFile, "utf8"));
}
function readPhase(candidate, required = true) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(path.join(candidate, "phase.json"), "utf8"));
  } catch (error) {
    if (!required && error && error.code === "ENOENT") return null;
    throw error;
  }
  if (
    !value ||
    value.version !== 1 ||
    !/^[a-f0-9]{32}$/.test(value.nonce || "") ||
    !candidate.endsWith("-" + value.nonce) ||
    !["begun", "applying", "applied", "committed"].includes(value.phase)
  ) {
    throw new Error("invalid accepted workspace transaction phase");
  }
  return value.phase;
}
function transitionPhase(candidate, current, expected, next) {
  const allowed =
    (expected === null && next !== null) ||
    (expected === "begun" && next === "applying") ||
    (expected === "applying" && next === "applied") ||
    (expected === "applied" && next === "committed");
  if (current !== expected || !allowed) {
    throw new Error("invalid accepted workspace transaction phase transition");
  }
  const candidateNonce = path.basename(candidate).slice(-32);
  if (!/^[a-f0-9]{32}$/.test(candidateNonce)) {
    throw new Error("invalid accepted workspace transaction phase path");
  }
  const candidatePhase = path.join(candidate, "phase.json");
  const temporary = candidatePhase + "." + process.pid + "." + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, nonce: candidateNonce, phase: next }), {
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temporary, candidatePhase);
}
function normalizeRecoveredPhase(candidate, cleanupNamespace = false) {
  const phase = readPhase(candidate, false);
  if (phase !== null) return phase;
  const inferred = cleanupNamespace
    ? "committed"
    : exists(path.join(candidate, "applied"))
      ? "applied"
      : exists(path.join(candidate, "state.json")) ||
          exists(path.join(candidate, "ancestor-modes.json"))
        ? "applying"
        : "begun";
  // Transactions from pre-phase beta workers are normalized only while the
  // locked recovery owner is deciding their existing durable rollback state.
  transitionPhase(candidate, null, null, inferred);
  return inferred;
}
function readState(candidate) {
  const value = JSON.parse(fs.readFileSync(path.join(candidate, "state.json"), "utf8"));
  if (!Array.isArray(value) || value.length > 25_000) {
    throw new Error("invalid accepted workspace transaction state");
  }
  const relatives = parsePaths(JSON.stringify(value.map((entry) => entry && entry.relative)));
  if (
    relatives.length !== value.length ||
    value.some(
      (entry, index) =>
        !entry ||
        entry.relative !== relatives[index] ||
        typeof entry.hadLive !== "boolean" ||
        (entry.directoryMode !== undefined &&
          (!Number.isInteger(entry.directoryMode) ||
            entry.directoryMode < 0 ||
            entry.directoryMode > 0o7777)),
    )
  ) {
    throw new Error("invalid accepted workspace transaction state");
  }
  return value;
}
function readAncestorModes(candidate) {
  const candidateModes = path.join(candidate, "ancestor-modes.json");
  if (!exists(candidateModes)) return [];
  const value = JSON.parse(fs.readFileSync(candidateModes, "utf8"));
  if (!Array.isArray(value) || value.length > 250_000) {
    throw new Error("invalid accepted workspace ancestor modes");
  }
  const seen = new Set();
  for (const entry of value) {
    if (
      !entry ||
      (entry.relative !== "" && !isSafeRelativePath(entry.relative)) ||
      seen.has(entry.relative) ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o7777
    ) {
      throw new Error("invalid accepted workspace ancestor modes");
    }
    seen.add(entry.relative);
  }
  return value;
}
function writeAncestorModes(value) {
  const temporary = ancestorModesFile + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, ancestorModesFile);
}
function ancestorPaths(paths) {
  const ancestors = new Set();
  for (const relative of paths) {
    const segments = relative.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      ancestors.add(segments.slice(0, index).join("/"));
    }
  }
  if (ancestors.size + 1 > 250_000) {
    throw new Error("accepted workspace transaction has too many ancestors");
  }
  return [...ancestors].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || (left < right ? -1 : left > right ? 1 : 0);
  });
}
function prepareWritableAncestors(paths) {
  // parsePaths removes descendants of changed directories, so these are all
  // unchanged live ancestors. Read every mode before mutating any permission.
  const modes = ["", ...ancestorPaths(paths)].map((relative) => {
    const target = relative ? targetPath(root, relative) : root;
    const stats = fs.lstatSync(target);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("unsafe accepted workspace parent");
    }
    return { relative, mode: stats.mode & 0o7777 };
  });
  writeAncestorModes(modes);
  makeAncestorsWritable(modes);
  return modes;
}
function makeAncestorsWritable(modes) {
  const widened = [];
  try {
    for (const entry of modes) {
      const target = entry.relative ? targetPath(root, entry.relative) : root;
      const stats = fs.lstatSync(target);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("unsafe accepted workspace parent");
      }
      const currentMode = stats.mode & 0o7777;
      const writableMode = entry.mode | 0o700;
      if (currentMode !== writableMode) {
        fs.chmodSync(target, writableMode);
        widened.push(entry);
      }
    }
  } catch (error) {
    try {
      restoreAncestorModes(widened);
    } catch (restoreError) {
      const failure = new Error("accepted workspace ancestor mode rollback failed", {
        cause: error,
      });
      Object.defineProperty(failure, "restoreFailure", { value: restoreError });
      throw failure;
    }
    throw error;
  }
}
function restoreAncestorModes(modes) {
  for (const entry of [...modes].reverse()) {
    const target = entry.relative ? targetPath(root, entry.relative) : root;
    const stats = fs.lstatSync(target);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("unsafe accepted workspace parent");
    }
    if ((stats.mode & 0o7777) !== entry.mode) fs.chmodSync(target, entry.mode);
  }
}
function removeTransaction(candidate = transaction) {
  removeTree(candidate);
}
function restoreTransaction(candidate) {
  if (!exists(candidate)) return;
  const ancestorModes = readAncestorModes(candidate);
  makeAncestorsWritable(ancestorModes);
  const candidateState = path.join(candidate, "state.json");
  try {
    if (exists(candidateState)) {
      const candidateBackup = path.join(candidate, "backup");
      for (const entry of [...readState(candidate)].reverse()) {
        const live = livePath(entry.relative);
        const backup = targetPath(candidateBackup, entry.relative);
        if (exists(backup)) {
          removeTree(live);
          fs.renameSync(backup, live);
          if (entry.directoryMode !== undefined) fs.chmodSync(live, entry.directoryMode);
        } else if (!entry.hadLive) {
          removeTree(live);
        } else if (entry.directoryMode !== undefined && exists(live)) {
          fs.chmodSync(live, entry.directoryMode);
        }
      }
    }
  } finally {
    restoreAncestorModes(ancestorModes);
  }
  removeTransaction(candidate);
}
function recoverTransaction(candidate) {
  const phase = normalizeRecoveredPhase(candidate);
  if (phase === "committed") {
    throw new Error("committed accepted workspace transaction is outside cleanup");
  }
  restoreTransaction(candidate);
}
function recoverCleanup(candidate) {
  const phase = normalizeRecoveredPhase(candidate, true);
  if (phase === "applied") transitionPhase(candidate, phase, "applied", "committed");
  else if (phase !== "committed") throw new Error("invalid accepted workspace cleanup phase");
  removeTransaction(candidate);
}
function recoverTransactions() {
  for (const name of fs.readdirSync(transactionRoot)) {
    if (name.startsWith(cleanupPrefix) && /^[a-f0-9]{32}$/.test(name.slice(cleanupPrefix.length))) {
      recoverCleanup(path.join(transactionRoot, name));
    }
  }
  for (const name of fs.readdirSync(transactionRoot)) {
    if (
      name.startsWith(transactionPrefix) &&
      /^[a-f0-9]{32}$/.test(name.slice(transactionPrefix.length))
    ) {
      recoverTransaction(path.join(transactionRoot, name));
    }
  }
}
function writeSettlementOutcome(outcome) {
  process.stdout.write(JSON.stringify({ version: 1, outcome }) + "\n");
}
function runAction() {
  if (action === "begin") {
    const paths = parsePaths(fs.readFileSync(0, "utf8"));
    recoverTransactions();
    fs.mkdirSync(transaction, { mode: 0o700 });
    fs.mkdirSync(nextRoot, { mode: 0o700 });
    fs.mkdirSync(backupRoot, { mode: 0o700 });
    fs.writeFileSync(pathsFile, JSON.stringify(paths), { mode: 0o600 });
    transitionPhase(transaction, null, null, "begun");
    process.stdout.write(nextRoot + "\n");
    return;
  }
  if (action === "apply") {
    const phase = readPhase(transaction);
    if (phase === "applied") return;
    if (phase === "applying") {
      restoreTransaction(transaction);
      throw new Error("recovered interrupted accepted workspace apply");
    }
    if (phase !== "begun") throw new Error("accepted workspace transaction cannot be applied");
    transitionPhase(transaction, phase, "begun", "applying");
    const paths = readPaths();
    try {
      const ancestorModes = prepareWritableAncestors(paths);
      const state = paths.map((relative) => {
        const live = livePath(relative);
        if (!exists(live)) return { relative, hadLive: false };
        const stats = fs.lstatSync(live);
        return {
          relative,
          hadLive: true,
          ...(stats.isDirectory() && !stats.isSymbolicLink()
            ? { directoryMode: stats.mode & 0o7777 }
            : {}),
        };
      });
      const temporaryStateFile = stateFile + ".tmp";
      fs.writeFileSync(temporaryStateFile, JSON.stringify(state), { flag: "wx", mode: 0o600 });
      fs.renameSync(temporaryStateFile, stateFile);
      for (const entry of state) {
        if (!entry.hadLive) continue;
        const source = livePath(entry.relative);
        const sourceStats = fs.lstatSync(source);
        const destination = targetPath(backupRoot, entry.relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        try {
          if (sourceStats.isDirectory() && !sourceStats.isSymbolicLink()) {
            fs.chmodSync(source, 0o700);
          }
          fs.renameSync(source, destination);
        } catch (error) {
          if (entry.directoryMode !== undefined && exists(source)) {
            fs.chmodSync(source, entry.directoryMode);
          }
          throw error;
        }
      }
      for (const entry of state) {
        const source = targetPath(nextRoot, entry.relative);
        if (exists(source)) fs.renameSync(source, livePath(entry.relative));
      }
      restoreAncestorModes(ancestorModes);
      transitionPhase(transaction, "applying", "applying", "applied");
    } catch (error) {
      restoreTransaction(transaction);
      throw error;
    }
    return;
  }
  if (action === "rollback") {
    if (exists(cleanup)) {
      if (exists(transaction)) throw new Error("ambiguous accepted workspace transaction state");
      const cleanupPhase = normalizeRecoveredPhase(cleanup, true);
      if (cleanupPhase !== "applied" && cleanupPhase !== "committed") {
        throw new Error("accepted workspace cleanup cannot be rolled back");
      }
      fs.renameSync(cleanup, transaction);
      restoreTransaction(transaction);
    } else if (exists(transaction)) {
      recoverTransaction(transaction);
    }
    return;
  }
  if (action === "recover") {
    recoverTransactions();
    return;
  }
  if (action === "settle") {
    if (exists(transaction) && exists(cleanup)) {
      throw new Error("ambiguous accepted workspace transaction state");
    }
    if (exists(cleanup)) {
      const phase = normalizeRecoveredPhase(cleanup, true);
      if (phase === "applied") transitionPhase(cleanup, phase, "applied", "committed");
      else if (phase !== "committed") throw new Error("invalid accepted workspace cleanup phase");
      writeSettlementOutcome("committed");
      return;
    }
    if (!exists(transaction)) {
      writeSettlementOutcome("rolled-back");
      return;
    }
    const phase = normalizeRecoveredPhase(transaction);
    if (phase === "applied") {
      writeSettlementOutcome("applied");
      return;
    }
    if (phase === "applying") {
      restoreTransaction(transaction);
      writeSettlementOutcome("rolled-back");
      return;
    }
    if (phase === "begun") {
      writeSettlementOutcome("begun");
      return;
    }
    throw new Error("invalid accepted workspace settlement phase");
  }
  if (action === "commit") {
    if (exists(transaction) && exists(cleanup)) {
      throw new Error("ambiguous accepted workspace transaction state");
    }
    if (exists(cleanup)) {
      const phase = readPhase(cleanup);
      if (phase === "applied") transitionPhase(cleanup, phase, "applied", "committed");
      else if (phase !== "committed") throw new Error("accepted workspace cleanup is not committed");
    } else if (exists(transaction)) {
      const phase = readPhase(transaction);
      if (phase !== "applied") throw new Error("accepted workspace transaction is not applied");
      // The namespace rename is the commit point. Later recovery removes the backup
      // only after the gateway has had a chance to observe this command's success.
      fs.renameSync(transaction, cleanup);
      transitionPhase(cleanup, phase, "applied", "committed");
    }
    return;
  }
  throw new Error("invalid accepted workspace transaction action");
}
// Every mutating action and SSH-loss settlement shares this remote owner lock;
// a disconnected gateway can never overlap rollback with the live apply process.
acquireWorkspaceLock();
try {
  runAction();
} finally {
  releaseWorkspaceLock();
}`;
