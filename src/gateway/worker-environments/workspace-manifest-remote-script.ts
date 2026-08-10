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
  if (Buffer.byteLength(manifest) > MAX_WORKSPACE_MANIFEST_BYTES) {
    fail("worker workspace manifest exceeds its serialized byte limit");
  }
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
    if (!stats.isFile() || stats.size > MAX_WORKSPACE_MANIFEST_BYTES) {
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
