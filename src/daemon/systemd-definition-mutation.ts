/** Systemd service-definition authority and atomic, cross-process publication. */
import { randomUUID } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import { resolveStateDir } from "../config/paths.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { hasErrnoCode } from "../infra/errno.js";
import { withFileLock } from "../infra/file-lock.js";
import { canonicalPathFromExistingAncestor, findExistingAncestor } from "../infra/fs-safe.js";
import {
  assertServiceDefinitionWritable,
  type GatewayServiceEnv,
  type ServiceDefinitionMutationArtifact,
  type ServiceDefinitionMutationCapability,
} from "./service-types.js";
import {
  readSystemdServiceExecStart,
  resolveSystemdEnvironmentFilePath,
  resolveSystemdUnitPath,
} from "./systemd-service-files.js";
import { assertNoSystemSystemdOwnership, isSystemSystemdOwnershipError } from "./systemd-system.js";

type Snapshot = { contents: Buffer; mode: number } | null;
type SystemdDefinitionMutation = {
  snapshots: Map<string, Snapshot>;
  publish: (file: string, contents: string | Buffer, mode: number) => Promise<void>;
  restore: (file: string, snapshot: Snapshot) => Promise<void>;
};
const identity = (stat: Stats, contents?: Buffer) =>
  [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, contents && sha256Hex(contents)].join(":");

function resolveMutationTargets(env: GatewayServiceEnv, environment: GatewayServiceEnv) {
  const unit = resolveSystemdUnitPath(env);
  const generated = resolveSystemdEnvironmentFilePath({
    stateDir: resolveStateDir({ ...env, ...environment }),
    environment,
  });
  return { unit, generated };
}

async function readStableFile(
  file: string,
  stat: Stats,
  requireReplacement: boolean,
): Promise<{ contents: Buffer } | { sealed: true }> {
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || identity(opened) !== identity(stat)) {
      throw new Error("changed artifact");
    }
    if (requireReplacement && process.platform === "linux") {
      // fdinfo selects the opened file's actual mount, including stacked mounts.
      // W_OK alone misses read-only mounts when DAC denies an otherwise replaceable 0400 file.
      const fdinfo = await fs.readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8");
      const mountId = /^mnt_id:\s+(\d+)$/m.exec(fdinfo)?.[1];
      const mount = (await fs.readFile("/proc/self/mountinfo", "utf8"))
        .split("\n")
        .find((line) => mountId && line.startsWith(`${mountId} `))
        ?.split(" ");
      if (!mount?.[4] || !mount[5]) {
        throw new Error("Cannot inspect the service artifact mount.");
      }
      if (
        mount[5].split(",").includes("ro") ||
        decodeMountInfoPath(mount[4]) === (await fs.realpath(file))
      ) {
        return { sealed: true };
      }
    }
    return { contents: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

async function inspect(env: GatewayServiceEnv, environment: GatewayServiceEnv, timeoutMs?: number) {
  const { unit, generated } = resolveMutationTargets(env, environment);
  const snapshots = new Map<string, Snapshot>();
  const fingerprint = new Map<string, string>();
  let shared = new Set<string>();
  let sourcePath: string | undefined;
  const result = (capability: ServiceDefinitionMutationCapability) => ({
    capability,
    snapshots,
    fingerprint,
    shared,
    sourcePath,
  });
  let artifact: ServiceDefinitionMutationArtifact | undefined;
  try {
    const command = await readSystemdServiceExecStart(env, {
      requireEffective: true,
      timeoutMs,
    });
    sourcePath = command?.sourcePath;
    const targets = new Set([unit, generated, `${unit}.bak`]);
    const definitions = new Set(command?.definitionPaths ?? []);
    // Type-wide service.d defaults are shared read-only inputs. Selected fragments
    // and unit-specific overrides still require authority; never shadow a sealed unit.
    shared = new Set(
      [...definitions].filter(
        (file) =>
          file !== command?.sourcePath &&
          !targets.has(file) &&
          path.basename(path.dirname(file)) === "service.d",
      ),
    );
    const definitionParents = new Set(
      [...definitions].filter((file) => !shared.has(file)).map(path.dirname),
    );
    const parents = new Set([path.dirname(unit), path.dirname(generated), ...definitionParents]);
    const artifacts = new Set([...parents, ...targets, ...definitions]);
    for (const file of artifacts) {
      const directory = parents.has(file) && !definitions.has(file);
      const required = definitions.has(file) || definitionParents.has(file);
      artifact = !directory
        ? "service-file"
        : file === path.dirname(unit)
          ? "service-directory"
          : file === path.dirname(generated)
            ? "state-directory"
            : "definition-directory";
      const inspected =
        directory && !required ? ((await findExistingAncestor(file)) ?? file) : file;
      const stat = await fs.lstat(inspected).catch((error: unknown) => {
        if (required || !hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
      });
      if (!stat) {
        fingerprint.set(file, "missing");
        continue;
      }
      // systemd retains lexical directory aliases; fingerprint both alias and target.
      if (!directory && stat.isSymbolicLink()) {
        return result({ kind: "unknown", reason: "symlink", artifact });
      }
      const actual = directory && stat.isSymbolicLink() ? await fs.stat(inspected) : stat;
      if (!shared.has(file) && actual.uid !== process.geteuid?.()) {
        return result({ kind: "sealed", reason: "foreign-owner", artifact });
      }
      if (directory && !actual.isDirectory()) {
        return result({ kind: "unknown", reason: "invalid-artifact", artifact });
      }
      if (actual.mode & 0o022) {
        return result({ kind: "unknown", reason: "unsafe-permissions", artifact });
      }
      if (directory) {
        await fs.access(inspected, constants.W_OK | constants.X_OK);
        fingerprint.set(file, `${inspected}:${identity(stat)}:${identity(actual)}`);
        continue;
      }
      const snapshot = await readStableFile(file, stat, !shared.has(file));
      if ("sealed" in snapshot) {
        return result({ kind: "sealed", reason: "sealed-mount", artifact });
      }
      const { contents } = snapshot;
      fingerprint.set(file, identity(stat, contents));
      if (targets.has(file)) {
        snapshots.set(file, { contents, mode: stat.mode & 0o777 });
      }
    }
    return result({ kind: "writable" });
  } catch {
    return result({ kind: "unknown", reason: "inspection-failed", artifact });
  }
}

export async function readSystemdDefinitionMutationCapability(
  env: GatewayServiceEnv,
  options?: { environment?: GatewayServiceEnv; timeoutMs?: number },
): Promise<ServiceDefinitionMutationCapability> {
  const selected = path.basename(resolveSystemdUnitPath(env));
  const names =
    selected === "openclaw-gateway.service" ? [selected, "openclaw.service"] : [selected];
  const deadlineAt = options?.timeoutMs ? Date.now() + options.timeoutMs : undefined;
  for (const name of names) {
    try {
      await assertNoSystemSystemdOwnership(
        name,
        deadlineAt === undefined ? undefined : Math.max(1, deadlineAt - Date.now()),
      );
    } catch (error) {
      const owned =
        isSystemSystemdOwnershipError(error) && error.ownership.status !== "unverifiable";
      return owned
        ? { kind: "sealed", reason: "system-owned" }
        : { kind: "unknown", reason: "system-ownership-unverified" };
    }
  }
  return (await inspect(env, options?.environment ?? env, options?.timeoutMs)).capability;
}

export async function withSystemdDefinitionMutation<T>(
  env: GatewayServiceEnv,
  environment: GatewayServiceEnv,
  run: (mutation: SystemdDefinitionMutation) => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  const deadlineAt =
    options?.timeoutMs && options.timeoutMs > 0 ? Date.now() + options.timeoutMs : undefined;
  const remainingTimeoutMs = () =>
    deadlineAt === undefined ? undefined : Math.max(1, deadlineAt - Date.now());
  let initial = await inspect(env, environment, remainingTimeoutMs());
  assertServiceDefinitionWritable(initial.capability);
  const { unit, generated } = resolveMutationTargets(env, environment);
  // Group-writable umasks must not create directories that inspect() would reject.
  await fs.mkdir(path.dirname(unit), { recursive: true, mode: 0o755 });
  await fs.mkdir(path.dirname(generated), { recursive: true, mode: 0o700 });
  const canonicalTargets = () =>
    Promise.all([unit, generated].map(canonicalPathFromExistingAncestor));
  const lockedTargets = await canonicalTargets();
  const targets = lockedTargets
    .map((target) => path.join(path.dirname(target), `.openclaw-${sha256Hex(target)}`))
    .toSorted();
  const execute = async (): Promise<T> => {
    const refresh = async (unchanged = false, firstUnitPublication = false) => {
      const current = await inspect(env, environment, remainingTimeoutMs());
      assertServiceDefinitionWritable(current.capability);
      const expected = new Map(initial.fingerprint);
      // LoadUnit can reveal shared defaults only after the first base publication.
      // Admit only new shared inputs; every observed artifact must still match exactly.
      if (firstUnitPublication && !initial.sourcePath && current.sourcePath === unit) {
        for (const [file, fingerprint] of current.fingerprint) {
          if (current.shared.has(file) && !expected.has(file)) {
            expected.set(file, fingerprint);
          }
        }
      }
      if (unchanged && !isDeepStrictEqual(current.fingerprint, expected)) {
        throw new Error("Managed service artifacts changed during publication.");
      }
      initial = current;
    };
    await refresh();
    // Waiting may admit another writer's artifacts, never another directory's locks.
    if (!isDeepStrictEqual(await canonicalTargets(), lockedTargets)) {
      throw new Error("Managed service lock targets changed during acquisition.");
    }
    const allowed = new Set([unit, generated, `${unit}.bak`]);
    const publications = new Map<string, string>();
    const publish = async (
      file: string,
      contents: string | Buffer,
      mode: number,
      rollback = true,
    ) => {
      if (!allowed.has(file)) {
        throw new Error("Not a managed service publication target.");
      }
      await refresh(true);
      const previous = initial.snapshots.get(file) ?? null;
      const directory = await fs.realpath(path.dirname(file));
      const temporary = path.join(directory, `${path.basename(file)}.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, contents, { flag: "wx", mode });
        const written = await fs.lstat(temporary);
        await refresh(true);
        // Locks coordinate OpenClaw writers, not external editors: POSIX rename
        // has no expected-inode check. Quiesce administrative edits during installation.
        await fs.rename(temporary, file);
        // Re-read every artifact against this inode/payload. Canonical temp paths
        // keep cleanup in the original directory even if the publication alias moves.
        const published = identity(written, Buffer.from(contents));
        initial.fingerprint.set(file, published);
        publications.set(file, published);
        try {
          await refresh(true, file === unit && previous === null);
        } catch (error) {
          // Roll back only our unchanged publication; a failing rollback must not recurse.
          if (rollback) {
            await restore(file, previous);
          }
          throw error;
        }
      } finally {
        await fs.unlink(temporary).catch(() => undefined);
      }
    };
    const restore = async (file: string, snapshot: Snapshot) => {
      if (!allowed.has(file) && snapshot) {
        throw new Error("Not a managed service publication target.");
      }
      const published = publications.get(file);
      if (published === undefined) {
        return;
      }
      const current = await inspect(env, environment, remainingTimeoutMs());
      // A refreshed global snapshot never grants ownership of another artifact's edit.
      if (current.capability.kind !== "writable" || current.fingerprint.get(file) !== published) {
        return;
      }
      initial = current;
      if (snapshot) {
        await publish(file, snapshot.contents, snapshot.mode, false);
      } else {
        await refresh(true);
        await fs.unlink(file);
        initial.fingerprint.set(file, "missing");
        await refresh(true);
      }
      publications.delete(file);
    };
    return await run({ snapshots: initial.snapshots, publish, restore });
  };
  const lockOptions = () => {
    const timeoutMs = remainingTimeoutMs();
    return {
      stale: 60_000,
      retries: {
        retries: timeoutMs === undefined ? 100 : Math.max(0, Math.ceil(timeoutMs / 50) - 1),
        factor: 1,
        minTimeout: 50,
        maxTimeout: 100,
      },
    };
  };
  const acquire = async (index: number): Promise<T> =>
    index === targets.length
      ? execute()
      : withFileLock(targets[index]!, lockOptions(), () => acquire(index + 1));
  return await acquire(0);
}
