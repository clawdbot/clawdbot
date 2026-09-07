import { isUtf8 } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const bundleFile = ".openclaw-crabbox-changed-gate.bundle";
const capsuleRef = "refs/openclaw/source-capsule";
const syncPlanSchema = z.object({
  candidate: z.object({ files: z.number().int().nonnegative() }),
  topFiles: z.array(z.object({ path: z.string().min(1) })),
});

export type CrabboxSourceCapsule = {
  sourceSha: string;
  baseSha: string;
  tree: string;
  carrier: string;
  digest: string;
  bundlePath: string;
  directory: string;
  cleanup: () => void;
  configPath?: string;
};

function sourceGitEnvironment() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
  };
  // Repository routing belongs to the selected checkout. Keep Git configuration
  // here: the invoking user's global excludes are part of source selection.
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_SHALLOW_FILE",
  ]) {
    delete env[key];
  }
  return env;
}

function capsulePath(path: string) {
  const parts = path.split("/");
  if (
    parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  ) {
    throw new Error("source capsule contains an invalid repository path");
  }
  if (path.includes("\0") || path.includes("\\") || path === bundleFile) {
    throw new Error("source capsule path conflicts with its transport metadata");
  }
  return path;
}

function capsuleObjectId(value: string) {
  const id = value.trim();
  if (!/^[a-f0-9]{40}$/u.test(id)) {
    throw new Error("source capsule requires a complete SHA-1 Git object identity");
  }
  return id;
}

function sourceStat(root: string, path: string) {
  const parts = path.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = lstatSync(current, { throwIfNoEntry: false });
    if (!info) {
      return { kind: "missing" } as const;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      // An indexed directory can be replaced by a file or symlink. Its old
      // descendants are deleted source, never paths into the new link's target.
      return { kind: "replaced" } as const;
    }
  }
  const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
  return stat ? { kind: "present" as const, stat } : { kind: "missing" as const };
}

export function prepareCrabboxSourceCapsule(options: {
  repoRoot: string;
  syncRoot: string;
  base: string;
  syncPlan: { command: string; args: string[]; windowsVerbatimArguments?: boolean };
}): CrabboxSourceCapsule {
  const repoRoot = realpathSync(options.repoRoot);
  const sourceEnv = sourceGitEnvironment();
  function git(cwd: string, args: string[], env = sourceEnv, input?: string) {
    let output: Buffer;
    try {
      output = execFileSync("git", ["-C", cwd, ...args], {
        env,
        input,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      throw new Error(`source capsule: git ${args[0]} failed; source was not uploaded`);
    }
    if (!isUtf8(output)) {
      throw new Error("source capsule requires UTF-8 Git paths and metadata");
    }
    return output.toString("utf8");
  }
  const sourceSha = capsuleObjectId(git(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]));
  const baseSha = capsuleObjectId(
    git(repoRoot, ["rev-parse", "--verify", `${options.base}^{commit}`]),
  );
  const trackedRecords = git(repoRoot, ["ls-files", "-v", "--stage", "-z"]);
  const tracked = new Map<string, { mode: string; hash: string; sparse: boolean }>();
  for (const record of trackedRecords.split("\0").filter(Boolean)) {
    const match = /^([A-Za-z]) (100644|100755|120000) ([a-f0-9]{40}) 0\t([\s\S]+)$/u.exec(record);
    if (!match || !match[1] || !match[2] || !match[3] || !match[4]) {
      throw new Error("source capsule requires resolved regular-file or symlink index entries");
    }
    tracked.set(capsulePath(match[4]), {
      mode: match[2],
      hash: match[3],
      sparse: match[1].toUpperCase() === "S",
    });
  }
  const owned = new Set(tracked.keys());
  for (const revision of new Set([baseSha, sourceSha])) {
    for (const path of git(repoRoot, ["ls-tree", "-r", "--name-only", "-z", revision])
      .split("\0")
      .filter(Boolean)) {
      owned.add(capsulePath(path));
    }
  }
  // Freeze invoking Git's eligibility before moving to a different Git/config
  // context. This includes staged ignored additions and excludes untracked secrets.
  const eligible = new Set(
    git(repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean)
      .map(capsulePath),
  );
  mkdirSync(options.syncRoot, { recursive: true });
  const temporary = mkdtempSync(resolve(options.syncRoot, "openclaw-crabbox-sync-"));
  const directory = join(temporary, "source");
  const cleanup = () => rmSync(temporary, { recursive: true, force: true });
  try {
    mkdirSync(directory);
    const privateEnv: NodeJS.ProcessEnv = {
      ...sourceEnv,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "0",
      GIT_AUTHOR_NAME: "OpenClaw",
      GIT_AUTHOR_EMAIL: "ci@openclaw.local",
      GIT_COMMITTER_NAME: "OpenClaw",
      GIT_COMMITTER_EMAIL: "ci@openclaw.local",
    };
    delete privateEnv.GIT_CONFIG_PARAMETERS;
    git(directory, ["init", "--quiet", "--template="], privateEnv);
    const objectDir = git(repoRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]).trim();
    writeFileSync(join(directory, ".git", "objects", "info", "alternates"), `${objectDir}\n`);
    git(directory, ["update-ref", "--no-deref", "HEAD", sourceSha], privateEnv);
    // Git expands ~/ paths; relative excludesFile paths are relative to the source
    // checkout. Keep this policy reference local, including an explicit empty override.
    const excludesFile = spawnSync(
      "git",
      ["-C", repoRoot, "config", "--path", "--null", "--get", "core.excludesFile"],
      {
        env: sourceEnv,
      },
    );
    if (excludesFile.status === 0 && isUtf8(excludesFile.stdout)) {
      const path = excludesFile.stdout.toString("utf8").slice(0, -1);
      git(
        directory,
        ["config", "core.excludesFile", path ? resolve(repoRoot, path) : ""],
        privateEnv,
      );
    } else if (excludesFile.status !== 1) {
      throw new Error("source capsule could not resolve Git exclusion policy");
    }
    git(
      directory,
      ["remote", "add", "origin", git(repoRoot, ["remote", "get-url", "origin"]).trim()],
      privateEnv,
    );
    // Original tracking, not the eventual raw candidate index, controls Crabbox's
    // tracked-source exceptions. Untracked candidates must remain untracked here.
    git(
      directory,
      ["update-index", "-z", "--index-info"],
      privateEnv,
      [...tracked].map(([path, entry]) => `${entry.mode} ${entry.hash}\t${path}\0`).join(""),
    );
    const exclude = git(repoRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "info/exclude",
    ]).trim();
    const excludeInfo = lstatSync(exclude, { throwIfNoEntry: false });
    if (excludeInfo) {
      const policy = realpathSync(exclude);
      if (!lstatSync(policy).isFile()) {
        throw new Error("source capsule requires a regular Git info/exclude policy file");
      }
      mkdirSync(join(directory, ".git", "info"), { recursive: true });
      const fd = openSync(policy, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        writeFileSync(join(directory, ".git", "info", "exclude"), readFileSync(fd));
      } finally {
        closeSync(fd);
      }
    }
    const frozen = new Map<string, { mode: string; blobPath: string }>();
    const linkBlobs = join(temporary, "links");
    mkdirSync(linkBlobs);
    function writeFrozen(path: string, bytes: Buffer, mode: string) {
      const destination = join(directory, path);
      mkdirSync(dirname(destination), { recursive: true });
      let blobPath = destination;
      if (mode === "120000") {
        symlinkSync(bytes, destination);
        blobPath = join(linkBlobs, String(frozen.size));
        writeFileSync(blobPath, bytes);
      } else {
        writeFileSync(destination, bytes);
        chmodSync(destination, mode === "100755" ? 0o755 : 0o644);
      }
      frozen.set(path, { mode, blobPath });
    }
    function copySource(path: string) {
      const entry = sourceStat(repoRoot, path);
      if (entry.kind !== "present" || entry.stat.isDirectory()) {
        return entry.kind;
      }
      const info = entry.stat;
      const source = join(repoRoot, path);
      if (info.isSymbolicLink()) {
        const bytes = readlinkSync(source, { encoding: "buffer" });
        const after = sourceStat(repoRoot, path);
        if (
          after.kind !== "present" ||
          !after.stat.isSymbolicLink() ||
          after.stat.ino !== info.ino ||
          !readlinkSync(source, { encoding: "buffer" }).equals(bytes)
        ) {
          throw new Error(
            `symlink changed while freezing ${JSON.stringify(path)}; retry after edits finish`,
          );
        }
        writeFrozen(path, bytes, "120000");
        return "present";
      }
      if (!info.isFile()) {
        throw new Error(`source capsule has an unsupported file kind at ${JSON.stringify(path)}`);
      }
      const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        const bytes = readFileSync(fd);
        const after = sourceStat(repoRoot, path);
        if (
          !opened.isFile() ||
          after.kind !== "present" ||
          opened.ino !== info.ino ||
          opened.ino !== after.stat.ino ||
          opened.mode !== info.mode ||
          opened.mode !== after.stat.mode ||
          opened.size !== after.stat.size ||
          opened.mtimeMs !== after.stat.mtimeMs
        ) {
          throw new Error(
            `source changed while freezing ${JSON.stringify(path)}; retry after edits finish`,
          );
        }
        writeFrozen(path, bytes, (opened.mode & 0o100) !== 0 ? "100755" : "100644");
      } finally {
        closeSync(fd);
      }
      return "present";
    }
    const sparse: Array<{ path: string; mode: string; hash: string }> = [];
    for (const path of [...eligible].toSorted()) {
      const kind = copySource(path);
      const entry = tracked.get(path);
      if (kind === "missing" && entry?.sparse) {
        sparse.push({ path, mode: entry.mode, hash: entry.hash });
      }
    }
    if (sparse.length) {
      // Batch directly to a private file: a sparse checkout can omit most of the
      // repository. Neither per-blob subprocesses nor one huge stdout buffer scales.
      const stream = join(temporary, "sparse-blobs");
      const output = openSync(stream, "wx", 0o600);
      try {
        execFileSync("git", ["-C", repoRoot, "cat-file", "--batch"], {
          env: sourceEnv,
          input: sparse.map((entry) => entry.hash).join("\n") + "\n",
          stdio: ["pipe", output, "pipe"],
        });
      } catch {
        throw new Error("source capsule could not materialize missing sparse index blobs");
      } finally {
        closeSync(output);
      }
      const input = openSync(stream, "r");
      let offset = 0;
      try {
        for (const entry of sparse) {
          const headerBytes = Buffer.alloc(128);
          const headerSize = readSync(input, headerBytes, 0, headerBytes.length, offset);
          const newline = headerBytes.indexOf(10, 0);
          const header = headerBytes.subarray(0, newline).toString("ascii");
          const match = /^([a-f0-9]{40}) blob (\d+)$/u.exec(header);
          if (
            newline < 0 ||
            newline >= headerSize ||
            !match ||
            match[1] !== entry.hash ||
            !match[2]
          ) {
            throw new Error("source capsule received invalid sparse blob framing");
          }
          const size = Number(match[2]);
          if (!Number.isSafeInteger(size)) {
            throw new Error("source capsule sparse blob size is invalid");
          }
          offset += newline + 1;
          const bytes = Buffer.alloc(size);
          for (let read = 0; read < size;) {
            const count = readSync(input, bytes, read, size - read, offset + read);
            if (!count) {
              throw new Error("source capsule sparse blob was truncated");
            }
            read += count;
          }
          offset += size;
          const separator = Buffer.alloc(1);
          if (readSync(input, separator, 0, 1, offset) !== 1 || separator[0] !== 10) {
            throw new Error("source capsule sparse blob separator is missing");
          }
          offset += 1;
          writeFrozen(entry.path, bytes, entry.mode);
        }
        if (offset !== fstatSync(input).size) {
          throw new Error("source capsule sparse blob stream has unexpected data");
        }
      } finally {
        closeSync(input);
      }
    }
    const selectionEnv = { ...sourceEnv };
    const runtimePolicies: string[] = [];
    let configPath: string | undefined;
    const explicitConfig = sourceEnv.CRABBOX_CONFIG;
    if (explicitConfig) {
      const original = resolve(repoRoot, explicitConfig);
      function repositoryPolicyPath(absolute: string) {
        const path = relative(repoRoot, absolute);
        return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
          ? capsulePath(path)
          : undefined;
      }
      let policyPath = repositoryPolicyPath(original);
      if (!policyPath) {
        // Crabbox also treats an external alias resolving into this repository
        // as repository configuration. Relocation must not elevate its trust.
        try {
          policyPath = repositoryPolicyPath(realpathSync(original));
        } catch {
          // Missing explicit configuration is permitted by Crabbox.
        }
      }
      if (policyPath) {
        runtimePolicies.push(policyPath);
        configPath = join(directory, policyPath);
      } else {
        configPath = original;
      }
      selectionEnv.CRABBOX_CONFIG = configPath;
    } else {
      runtimePolicies.push("crabbox.yaml", ".crabbox.yaml");
    }
    // Policy files may be Git-ignored. They affect selection but never become
    // transport candidates merely because selection needs to read them.
    for (const path of [...runtimePolicies, ".crabboxignore"]) {
      const kind = frozen.has(path) ? "present" : copySource(path);
      // A replaced policy must not become an absent file and lose its exclusions.
      if (kind !== "missing" && !["100644", "100755"].includes(frozen.get(path)?.mode ?? "")) {
        throw new Error(
          `source capsule cannot relocate non-regular repository policy ${JSON.stringify(path)}; use a regular policy file before uploading`,
        );
      }
    }
    const snapshotEligible = new Set(
      git(directory, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(Boolean),
    );
    for (const path of frozen.keys()) {
      if (eligible.has(path) && !snapshotEligible.has(path)) {
        throw new Error("source capsule Git exclusion context changed in the frozen checkout");
      }
    }
    function selectSource() {
      let planValue: unknown;
      try {
        const result = spawnSync(options.syncPlan.command, options.syncPlan.args, {
          cwd: directory,
          env: selectionEnv,
          windowsVerbatimArguments: options.syncPlan.windowsVerbatimArguments,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.error || result.status !== 0) {
          throw new Error("Crabbox sync-plan failed");
        }
        planValue = JSON.parse(result.stdout);
      } catch {
        throw new Error(
          "source capsule requires a successful Crabbox sync-plan; inspect source exclusions before retrying",
        );
      }
      const parsed = syncPlanSchema.safeParse(planValue);
      if (!parsed.success) {
        throw new Error("source capsule received an invalid Crabbox sync-plan");
      }
      const selected = new Set(parsed.data.topFiles.map((entry) => capsulePath(entry.path)));
      if (
        selected.size !== parsed.data.candidate.files ||
        selected.size !== parsed.data.topFiles.length
      ) {
        throw new Error("source capsule requires the complete, unique Crabbox sync-plan selection");
      }
      return selected;
    }
    const directories = new Set<string>();
    for (const path of frozen.keys()) {
      for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) {
        directories.add(parent);
      }
    }
    // Ask the same policy owner about absent source using empty tracked placeholders.
    // These never enter the source tree. Separate overlapping historical file paths
    // (a -> a/b) so no probe follows a source symlink or shadows another deletion.
    const groups: Set<string>[] = [new Set()];
    for (const path of [...owned].toSorted()) {
      if (frozen.has(path) || directories.has(path)) {
        continue;
      }
      const parents: string[] = [];
      for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) {
        parents.push(parent);
      }
      if (parents.some((parent) => frozen.has(parent))) {
        continue; // The selected ancestor replaces this namespace without following it.
      }
      let group = groups.find((entries) => parents.every((parent) => !entries.has(parent)));
      if (!group) {
        group = new Set();
        groups.push(group);
      }
      group.add(path);
    }
    const emptyBlob = git(directory, ["hash-object", "-w", "--stdin"], privateEnv, "").trim();
    const unstageDeletions = (paths: Iterable<string>) =>
      git(
        directory,
        ["update-index", "-z", "--index-info"],
        privateEnv,
        [...paths].map((path) => `0 ${"0".repeat(40)}\t${path}\0`).join(""),
      );
    unstageDeletions(groups.flatMap((group) => [...group]));
    const deleted: string[] = [];
    let selected: Set<string> | undefined;
    for (const group of groups) {
      for (const path of group) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), "", { flag: "wx" });
      }
      git(
        directory,
        ["update-index", "-z", "--index-info"],
        privateEnv,
        [...group].map((path) => `100644 ${emptyBlob}\t${path}\0`).join(""),
      );
      const current = selectSource();
      for (const path of group) {
        if (current.delete(path)) {
          deleted.push(path);
        }
        rmSync(join(directory, path));
      }
      unstageDeletions(group);
      if (
        selected &&
        (selected.size !== current.size || [...selected].some((path) => !current.has(path)))
      ) {
        throw new Error("source capsule policy changed while selecting deletions");
      }
      selected = current;
    }
    if (!selected) {
      throw new Error("source capsule selection is missing");
    }
    for (const path of tracked.keys()) {
      if (frozen.has(path) && !selected.has(path)) {
        throw new Error(
          `source capsule privacy selection excludes required tracked source ${JSON.stringify(path)}; resolve the conflict before uploading`,
        );
      }
    }
    for (const path of selected) {
      if (frozen.has(path)) {
        continue;
      }
      const parts = path.split("/");
      const replacedTrackedPath =
        tracked.has(path) &&
        parts.some((_, index) => index > 0 && frozen.has(parts.slice(0, index).join("/")));
      if (!replacedTrackedPath) {
        throw new Error("source capsule selection contains an absent source entry");
      }
    }
    const paths = [...selected].filter((path) => eligible.has(path) && frozen.has(path)).toSorted();
    const finalPaths = new Set(paths);
    for (const path of runtimePolicies) {
      if (frozen.has(path) && !finalPaths.has(path)) {
        throw new Error(
          `source capsule cannot retain excluded repository runtime configuration ${JSON.stringify(path)} for staged delegation`,
        );
      }
    }
    for (const path of frozen.keys()) {
      if (!finalPaths.has(path)) {
        rmSync(join(directory, path));
      }
    }
    // Hash frozen bytes without attributes or filters. Link blob inputs contain
    // readlink bytes, never the referent's contents; only selected blobs enter Git.
    const hashes = git(
      directory,
      ["hash-object", "-w", "--no-filters", "--stdin-paths"],
      privateEnv,
      paths.map((path) => JSON.stringify(frozen.get(path)!.blobPath)).join("\n") +
        (paths.length ? "\n" : ""),
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    if (hashes.length !== paths.length || hashes.some((hash) => !/^[a-f0-9]{40}$/u.test(hash))) {
      throw new Error("source capsule could not freeze every raw blob");
    }
    git(directory, ["read-tree", "--empty"], privateEnv);
    git(
      directory,
      ["update-index", "-z", "--index-info"],
      privateEnv,
      paths.map((path, index) => `${frozen.get(path)!.mode} ${hashes[index]}\t${path}\0`).join(""),
    );
    const tree = capsuleObjectId(git(directory, ["write-tree"], privateEnv));
    const carrier = capsuleObjectId(
      git(
        directory,
        ["commit-tree", tree, "-p", baseSha],
        privateEnv,
        JSON.stringify({ deleted }) + "\n",
      ),
    );
    git(directory, ["update-ref", capsuleRef, carrier], privateEnv);
    const shallow = join(temporary, "shallow");
    writeFileSync(shallow, `${baseSha}\n`);
    const bundlePath = join(directory, bundleFile);
    git(directory, ["bundle", "create", bundlePath, `${baseSha}..${capsuleRef}`], {
      ...privateEnv,
      GIT_SHALLOW_FILE: shallow,
    });
    const digest = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");
    const bundleHash = capsuleObjectId(
      git(directory, ["hash-object", "-w", "--no-filters", bundlePath], privateEnv),
    );
    git(
      directory,
      ["update-index", "--add", "--cacheinfo", `100644,${bundleHash},${bundleFile}`],
      privateEnv,
    );
    if (
      git(repoRoot, ["rev-parse", "HEAD"]).trim() !== sourceSha ||
      git(repoRoot, ["ls-files", "-v", "--stage", "-z"]) !== trackedRecords
    ) {
      throw new Error("source revision or index changed while freezing; retry after edits finish");
    }
    return {
      sourceSha,
      baseSha,
      tree,
      carrier,
      digest,
      bundlePath,
      directory,
      cleanup,
      configPath,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
