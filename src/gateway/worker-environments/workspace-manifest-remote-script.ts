export const REMOTE_WORKSPACE_MANIFEST_CANONICAL_JS = String.raw`function canonicalMode(type, mode) {
  if (type === "directory") return 0o700;
  if (type === "symlink") return 0o777;
  return (mode & 0o111) === 0 ? 0o644 : 0o755;
}
function canonicalEntry(entry) {
  if (entry.type === "directory") {
    return { path: entry.path, type: entry.type, mode: canonicalMode(entry.type, entry.mode) };
  }
  if (entry.type === "file") {
    return {
      path: entry.path,
      type: entry.type,
      mode: canonicalMode(entry.type, entry.mode),
      size: entry.size,
      sha256: entry.sha256,
    };
  }
  if (entry.type === "symlink") {
    return {
      path: entry.path,
      type: entry.type,
      mode: canonicalMode(entry.type, entry.mode),
      target: entry.target,
    };
  }
  fail("unsupported worker workspace manifest entry");
}
function compareManifestPaths(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}
function serializeManifest(baseCommit, entries, comparePaths = compareManifestPaths) {
  return JSON.stringify({
    version: 1,
    baseCommit,
    entries: entries
      .filter((entry) => !isDerivedWorkspacePath(entry.path))
      .map(canonicalEntry)
      .sort(comparePaths),
  });
}`;

export const REMOTE_WORKSPACE_MANIFEST_REGISTRY_JS = String.raw`function publishManifest(manifestRoot, manifest) {
  const digest = crypto.createHash("sha256").update(manifest).digest("hex");
  const manifestPath = path.join(manifestRoot, digest + ".json");
  const temporaryPath = manifestPath + "." + process.pid + "." + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(temporaryPath, manifest, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    try {
      fs.linkSync(temporaryPath, manifestPath);
    } catch (error) {
      const existing = error && error.code === "EEXIST" ? fs.lstatSync(manifestPath) : null;
      if (
        !existing ||
        existing.isSymbolicLink() ||
        !existing.isFile() ||
        fs.readFileSync(manifestPath, "utf8") !== manifest
      ) {
        throw error;
      }
    }
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return digest;
}
function readManifestFile(manifestPath) {
  const descriptor = fs.openSync(manifestPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.size > 64 * 1024 * 1024) {
      fail("unsafe worker workspace manifest file");
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}
function resolveManifest(manifestRoot, requestedDigest) {
  if (!/^[a-f0-9]{64}$/.test(requestedDigest || "")) fail("invalid workspace manifest digest");
  const requestedPath = path.join(manifestRoot, requestedDigest + ".json");
  try {
    fs.lstatSync(requestedPath);
    // The bounded inbound transfer remains authoritative for validating an
    // already-addressable manifest's type, size, and content digest.
    return requestedDigest;
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }

  const candidates = fs
    .readdirSync(manifestRoot)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => {
      try {
        return { name, mtimeMs: fs.lstatSync(path.join(manifestRoot, name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) =>
      right.mtimeMs - left.mtimeMs || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    )
    .slice(0, 256);
  let scannedBytes = 0;
  for (const { name } of candidates) {
    const candidatePath = path.join(manifestRoot, name);
    let raw;
    try {
      raw = readManifestFile(candidatePath);
    } catch {
      continue;
    }
    scannedBytes += Buffer.byteLength(raw);
    if (scannedBytes > 256 * 1024 * 1024) break;
    if (crypto.createHash("sha256").update(raw).digest("hex") !== name.slice(0, -5)) continue;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!value || value.version !== 1 || !Array.isArray(value.entries)) continue;
    let canonical;
    try {
      canonical = serializeManifest(value.baseCommit ?? null, value.entries);
    } catch {
      continue;
    }
    if (crypto.createHash("sha256").update(canonical).digest("hex") !== requestedDigest) continue;
    if (publishManifest(manifestRoot, canonical) !== requestedDigest) {
      fail("resolved workspace manifest digest mismatch");
    }
    return requestedDigest;
  }
  fail("worker workspace manifest is unavailable: " + requestedDigest);
}`;

export const REMOTE_WORKSPACE_ACCEPTED_LOCK_JS = String.raw`const lockRoot = path.join(
  transactionRoot,
  ".openclaw-accepted-lock-" + workspaceKey,
);
const lockToken = crypto.randomBytes(16).toString("hex");
const lockOwner = { action, nonce, pid: process.pid, token: lockToken };
const lockWait = new Int32Array(new SharedArrayBuffer(4));
const lockDeadlineMs = Date.now() + 9 * 60 * 1000;
let acquiredLock;
function encodeLockIdentity(identity) {
  return [identity.action, identity.nonce, identity.pid, identity.token].join(".");
}
function parseLockIdentity(parts) {
  if (parts.length !== 4) return null;
  const [entryAction, entryNonce, rawPid, token] = parts;
  const pid = Number(rawPid);
  if (
    !acceptedActions.includes(entryAction) ||
    !/^[a-f0-9]{32}$/.test(entryNonce || "") ||
    !/^[1-9][0-9]*$/.test(rawPid || "") ||
    !Number.isSafeInteger(pid) ||
    !/^[a-f0-9]{32}$/.test(token || "")
  ) {
    return null;
  }
  return { action: entryAction, nonce: entryNonce, pid, token };
}
function sameLockIdentity(left, right) {
  return (
    left.action === right.action &&
    left.nonce === right.nonce &&
    left.pid === right.pid &&
    left.token === right.token
  );
}
function ownerEntryName(owner) {
  return "owner." + encodeLockIdentity(owner);
}
function reclaimEntryName(owner, reclaimer) {
  return "reclaim." + encodeLockIdentity(owner) + "." + encodeLockIdentity(reclaimer);
}
function parseLockEntry(name) {
  const parts = name.split(".");
  if (parts[0] === "owner" && parts.length === 5) {
    const owner = parseLockIdentity(parts.slice(1));
    return owner ? { kind: "owner", owner } : null;
  }
  if (parts[0] === "reclaim" && parts.length === 9) {
    const owner = parseLockIdentity(parts.slice(1, 5));
    const reclaimer = parseLockIdentity(parts.slice(5));
    return owner && reclaimer ? { kind: "reclaim", owner, reclaimer } : null;
  }
  return null;
}
function readLock() {
  let directoryStats;
  let names;
  try {
    directoryStats = fs.lstatSync(lockRoot);
    names = fs.readdirSync(lockRoot);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error("unsafe accepted workspace transaction lock");
  }
  if (names.length !== 1) throw new Error("invalid accepted workspace transaction lock");
  const entry = parseLockEntry(names[0]);
  if (!entry) throw new Error("invalid accepted workspace transaction lock owner");
  const entryPath = path.join(lockRoot, names[0]);
  try {
    const entryStats = fs.lstatSync(entryPath);
    if (entryStats.isSymbolicLink() || !entryStats.isFile()) {
      throw new Error("unsafe accepted workspace transaction lock owner");
    }
    return { ...entry, name: names[0], entryPath, directoryStats, entryStats };
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}
function sameLock(left, right) {
  return (
    left.kind === right.kind &&
    left.name === right.name &&
    sameInode(left.directoryStats, right.directoryStats) &&
    sameInode(left.entryStats, right.entryStats)
  );
}
function observedLockIdentity(lock) {
  return [
    lock.directoryStats.dev,
    lock.directoryStats.ino,
    lock.entryStats.dev,
    lock.entryStats.ino,
    lock.name,
  ].join(":");
}
function restoreOwnerEntry(observed) {
  const current = readLock();
  if (!current || !sameLock(current, observed)) return false;
  try {
    fs.renameSync(current.entryPath, path.join(lockRoot, ownerEntryName(current.owner)));
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
  return true;
}
function restoreAbandonedTransition(observed) {
  if (observed.kind !== "reclaim" || processIsAlive(observed.reclaimer.pid)) return false;
  const current = readLock();
  if (!current || !sameLock(current, observed) || processIsAlive(current.reclaimer.pid)) {
    return false;
  }
  return restoreOwnerEntry(current);
}
function reclaimDeadOwner(observed) {
  const current = readLock();
  if (
    !current ||
    current.kind !== "owner" ||
    !sameLock(current, observed) ||
    processIsAlive(current.owner.pid)
  ) {
    return false;
  }
  const claimName = reclaimEntryName(current.owner, lockOwner);
  try {
    // This sole-entry rename is the reclaim CAS. Only one dead-owner contender
    // can install its complete owner+reclaimer identity.
    fs.renameSync(current.entryPath, path.join(lockRoot, claimName));
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
  let claimed = readLock();
  if (
    !claimed ||
    claimed.kind !== "reclaim" ||
    claimed.name !== claimName ||
    !sameInode(claimed.directoryStats, current.directoryStats) ||
    !sameInode(claimed.entryStats, current.entryStats) ||
    !sameLockIdentity(claimed.owner, current.owner) ||
    !sameLockIdentity(claimed.reclaimer, lockOwner)
  ) {
    throw new Error("accepted workspace transaction reclaim ownership changed");
  }
  let quarantined = false;
  const quarantine = lockRoot + ".stale." + process.pid + "." + lockToken;
  try {
    if (processIsAlive(claimed.owner.pid)) return false;
    const validated = readLock();
    if (!validated || !sameLock(validated, claimed) || processIsAlive(validated.owner.pid)) {
      return false;
    }
    claimed = validated;
    fs.renameSync(lockRoot, quarantine);
    quarantined = true;
    const quarantinedDirectory = fs.lstatSync(quarantine);
    const quarantinedEntry = fs.lstatSync(path.join(quarantine, claimed.name));
    if (
      !sameInode(quarantinedDirectory, claimed.directoryStats) ||
      !sameInode(quarantinedEntry, claimed.entryStats)
    ) {
      throw new Error("accepted workspace transaction lock changed during reclamation");
    }
    removeTree(quarantine);
    return true;
  } finally {
    if (!quarantined) restoreOwnerEntry(claimed);
  }
}
function acquireWorkspaceLock() {
  const candidate = lockRoot + "." + process.pid + "." + lockToken;
  const ownerName = ownerEntryName(lockOwner);
  fs.mkdirSync(candidate, { mode: 0o700 });
  fs.writeFileSync(path.join(candidate, ownerName), "", { flag: "wx", mode: 0o600 });
  let acquired = false;
  let previousIdentity = "";
  let waitMs = 10;
  try {
    while (Date.now() < lockDeadlineMs) {
      try {
        // The owner entry is complete before this atomic namespace operation,
        // so contenders never mistake an initializing live owner for stale.
        fs.renameSync(candidate, lockRoot);
        acquired = true;
        const observed = readLock();
        if (
          !observed ||
          observed.kind !== "owner" ||
          !sameLockIdentity(observed.owner, lockOwner)
        ) {
          throw new Error("accepted workspace transaction lock acquisition changed");
        }
        acquiredLock = observed;
        return;
      } catch (error) {
        if (!error || (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")) throw error;
      }
      const observed = readLock();
      if (!observed) {
        previousIdentity = "";
        waitMs = 10;
        continue;
      }
      const identity = observedLockIdentity(observed);
      if (identity !== previousIdentity) {
        previousIdentity = identity;
        waitMs = 10;
      }
      if (observed.kind !== "owner") {
        if (restoreAbandonedTransition(observed)) continue;
      } else if (!processIsAlive(observed.owner.pid) && reclaimDeadOwner(observed)) {
        continue;
      }
      Atomics.wait(lockWait, 0, 0, waitMs);
      waitMs = Math.min(waitMs * 2, 500);
    }
    throw new Error("timed out waiting for accepted workspace transaction lock");
  } finally {
    if (!acquired) removeTree(candidate);
  }
}
function releaseWorkspaceLock() {
  const current = readLock();
  if (
    !current ||
    !acquiredLock ||
    current.kind !== "owner" ||
    !sameLock(current, acquiredLock) ||
    !sameLockIdentity(current.owner, lockOwner)
  ) {
    throw new Error("accepted workspace transaction lock ownership changed");
  }
  const validated = readLock();
  if (!validated || !sameLock(validated, current)) {
    throw new Error("accepted workspace transaction lock changed during release");
  }
  const quarantine = lockRoot + ".released." + process.pid + "." + lockToken;
  fs.renameSync(lockRoot, quarantine);
  const quarantinedDirectory = fs.lstatSync(quarantine);
  const quarantinedEntry = fs.lstatSync(path.join(quarantine, validated.name));
  if (
    !sameInode(quarantinedDirectory, validated.directoryStats) ||
    !sameInode(quarantinedEntry, validated.entryStats)
  ) {
    throw new Error("accepted workspace transaction lock changed during release");
  }
  removeTree(quarantine);
}`;
