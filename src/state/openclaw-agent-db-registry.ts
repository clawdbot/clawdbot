import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readlinkSync, realpathSync, rmdirSync, statSync } from "node:fs";
import path from "node:path";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  assertAgentDeletionPathFence,
  prepareAgentDeletionPathFence,
} from "./agent-deletion-journal.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { invalidateRegisteredAgentDatabasesMemo } from "./openclaw-agent-db-registry-listing.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";

export { listOpenClawRegisteredAgentDatabases } from "./openclaw-agent-db-registry-listing.js";

type OpenClawAgentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "agent_databases">;

type AgentDatabasePathIdentity = {
  lexicalPath: string;
  realPath?: string;
  device?: bigint | number;
  inode?: bigint | number;
  parentDevice?: bigint | number;
  parentInode?: bigint | number;
  parentRealPath?: string;
  unresolvedSuffix?: string;
};

const missingSuffixAliasCache = new Map<string, boolean>();
const MAX_DANGLING_SYMLINK_HOPS = 64;
const PROBE_NAME_LENGTH = 6;
const PROBE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const PROBE_FIRST_ALPHABET = "bdefghijkmoqrstuvwxyz";

type CreatedProbePath = {
  path: string;
  device: bigint | number;
  inode: bigint | number;
};

function createSymlinkLoopError(lexicalPath: string): NodeJS.ErrnoException {
  const error = new Error(`Symlink loop while resolving ${lexicalPath}.`) as NodeJS.ErrnoException;
  error.code = "ELOOP";
  return error;
}

function areAsciiCaseVariants(left: string | undefined, right: string | undefined): boolean {
  const foldAsciiCase = (value: string) =>
    value.replace(/[A-Z]/gu, (letter) => String.fromCharCode(letter.charCodeAt(0) + 0x20));
  return left !== undefined && right !== undefined && foldAsciiCase(left) === foldAsciiCase(right);
}

function shouldProbeUnicodeCaseVariants(left: string, right: string): boolean {
  const hasNonAscii = (value: string) =>
    value.split("").some((character) => character.charCodeAt(0) > 0x7f);
  if (!hasNonAscii(left) && !hasNonAscii(right)) {
    return false;
  }
  const lowercaseEquivalent = left.toLowerCase() === right.toLowerCase();
  const uppercaseEquivalent = left.toUpperCase() === right.toUpperCase();
  if (!lowercaseEquivalent && !uppercaseEquivalent) {
    return false;
  }
  // Keep dotted-I expansions distinct even on filesystems that collapse them.
  // That existing isolation contract avoids locale-sensitive owner aliasing.
  return !(
    Array.from(left).length !== Array.from(right).length &&
    lowercaseEquivalent &&
    !uppercaseEquivalent
  );
}

function isWindowsReservedPathComponent(value: string): boolean {
  const stem = value
    .split(".", 1)[0]!
    .replace(/[ .]+$/u, "")
    .toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem);
}

function createNormalizationProbePairs(
  left: string,
  right: string,
): readonly (readonly [string, string])[] {
  const pairs: Array<readonly [string, string]> = [];
  const seen = new Set<string>();
  const addPair = (candidateLeft: string, candidateRight: string) => {
    if (!areAsciiCaseVariants(candidateLeft.normalize("NFC"), candidateRight.normalize("NFC"))) {
      return;
    }
    if (
      isWindowsReservedPathComponent(candidateLeft) ||
      isWindowsReservedPathComponent(candidateRight)
    ) {
      return;
    }
    if (
      candidateLeft === left ||
      candidateLeft === right ||
      candidateRight === left ||
      candidateRight === right
    ) {
      return;
    }
    const key = `${candidateLeft}\0${candidateRight}`;
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push([candidateLeft, candidateRight]);
    }
  };

  const replaceAscii = (value: string, replacements: ReadonlyMap<string, string>) =>
    value.replace(/[A-Za-z]/gu, (character) => {
      const lower = character.toLowerCase();
      const replacement = replacements.get(lower);
      if (!replacement) {
        return character;
      }
      return character === lower ? replacement : replacement.toUpperCase();
    });
  const presentAscii = [...new Set(`${left}${right}`.toLowerCase().match(/[a-z]/gu) ?? [])];
  const mutableAscii = presentAscii.filter((source) => {
    const replacement = source === "z" ? "y" : "z";
    const replacements = new Map([[source, replacement]]);
    return areAsciiCaseVariants(
      replaceAscii(left, replacements).normalize("NFC"),
      replaceAscii(right, replacements).normalize("NFC"),
    );
  });
  for (let attempt = 0; attempt < 24 && mutableAscii.length > 0; attempt += 1) {
    const entropy = randomBytes(mutableAscii.length);
    const replacements = new Map(
      mutableAscii.map((source, index) => [
        source,
        String.fromCharCode("a".charCodeAt(0) + (entropy[index]! % 26)),
      ]),
    );
    addPair(replaceAscii(left, replacements), replaceAscii(right, replacements));
  }
  return pairs;
}

function createAsciiCaseProbePairs(
  nameLength: number,
  forbiddenNames: ReadonlySet<string>,
): readonly (readonly [string, string])[] {
  const pairs: Array<readonly [string, string]> = [];
  for (let attempt = 0; attempt < 96 && pairs.length < 24; attempt += 1) {
    const base = createPrivateProbeName(nameLength);
    const alias = `${base[0]!.toUpperCase()}${base.slice(1)}`;
    if (!forbiddenNames.has(base) && !forbiddenNames.has(alias)) {
      pairs.push([base, alias]);
    }
  }
  return pairs;
}

function createPrivateProbeName(nameLength: number): string {
  const entropy = randomBytes(nameLength);
  return [...entropy]
    .map((value, index) => {
      const alphabet = index === 0 ? PROBE_FIRST_ALPHABET : PROBE_ALPHABET;
      return alphabet[value % alphabet.length];
    })
    .join("");
}

function createPrivateProbeNames(
  nameLength: number,
  forbiddenNames: ReadonlySet<string>,
): readonly string[] {
  const names: string[] = [];
  for (let attempt = 0; attempt < 96 && names.length < 24; attempt += 1) {
    const name = createPrivateProbeName(nameLength);
    if (!forbiddenNames.has(name)) {
      names.push(name);
    }
  }
  return names;
}

function removeOwnedProbePath(created: CreatedProbePath): boolean {
  try {
    const current = lstatSync(created.path, { bigint: true });
    if (current.dev !== created.device || current.ino !== created.inode || !current.isDirectory()) {
      return false;
    }
    // Never recursively remove a probe: another process may have started using the
    // directory after our exclusive mkdir. ENOTEMPTY deliberately leaves it intact.
    rmdirSync(created.path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function removeTrackedProbePath(createdPaths: CreatedProbePath[], probePath: string): void {
  const index = createdPaths.findLastIndex((created) => created.path === probePath);
  if (index >= 0) {
    createdPaths.splice(index, 1);
  }
}

function createDirectoryAliasProbe(params: {
  parentPath: string;
  pairs: readonly (readonly [string, string])[];
  createdPaths: CreatedProbePath[];
}): { aliases: boolean; path: string } | undefined {
  for (const [firstName, aliasName] of params.pairs) {
    const probePath = path.join(params.parentPath, firstName);
    const aliasPath = path.join(params.parentPath, aliasName);
    try {
      mkdirSync(probePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw error;
    }
    const probeStat = lstatSync(probePath, { bigint: true });
    params.createdPaths.push({
      path: probePath,
      device: probeStat.dev,
      inode: probeStat.ino,
    });
    try {
      const aliasStat = lstatSync(aliasPath, { bigint: true });
      if (aliasStat.dev === probeStat.dev && aliasStat.ino === probeStat.ino) {
        return { aliases: true, path: probePath };
      }
      // The alternate spelling raced with the probe on a case-sensitive directory.
      // Remove our entry and try another pair rather than inferring its semantics.
      const created = params.createdPaths.at(-1);
      if (created?.path === probePath && removeOwnedProbePath(created)) {
        removeTrackedProbePath(params.createdPaths, probePath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { aliases: false, path: probePath };
      }
      throw error;
    }
  }
  return undefined;
}

function createNeutralProbeDirectory(params: {
  parentPath: string;
  createdPaths: CreatedProbePath[];
  forbiddenNames: ReadonlySet<string>;
  nameLength: number;
}): string | undefined {
  for (const name of createPrivateProbeNames(params.nameLength, params.forbiddenNames)) {
    const probePath = path.join(params.parentPath, name);
    try {
      mkdirSync(probePath);
      const stat = lstatSync(probePath, { bigint: true });
      params.createdPaths.push({ path: probePath, device: stat.dev, inode: stat.ino });
      return probePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
  return undefined;
}

function areMissingSuffixAliases(params: {
  left: string | undefined;
  right: string | undefined;
  parentDevice: bigint | number;
  parentInode: bigint | number;
  parentRealPath: string;
}): boolean {
  if (params.left === undefined || params.right === undefined) {
    return false;
  }
  if (params.left === params.right) {
    return true;
  }
  const leftSegments = params.left.split(path.sep);
  const rightSegments = params.right.split(path.sep);
  if (
    leftSegments.length !== rightSegments.length ||
    [...leftSegments, ...rightSegments].some(
      (segment) => !segment || segment === "." || segment === "..",
    )
  ) {
    return false;
  }
  const suffixPair = [params.left, params.right].toSorted();
  const cacheKey = JSON.stringify([
    params.parentDevice.toString(),
    params.parentInode.toString(),
    params.parentRealPath,
    ...suffixPair,
  ]);
  const cached = missingSuffixAliasCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const createdPaths: CreatedProbePath[] = [];
  const maxProbePathLength = Math.max(
    path.join(params.parentRealPath, params.left).length,
    path.join(params.parentRealPath, params.right).length,
  );
  try {
    let probeParent = params.parentRealPath;
    for (let index = 0; index < leftSegments.length; index += 1) {
      const leftSegment = leftSegments[index]!;
      const rightSegment = rightSegments[index]!;
      const normalizedLeft = leftSegment.normalize("NFC");
      const normalizedRight = rightSegment.normalize("NFC");
      const availableProbeNameLength =
        maxProbePathLength - probeParent.length - (probeParent.endsWith(path.sep) ? 0 : 1);
      const componentProbeNameLength = Math.max(
        1,
        Math.min(PROBE_NAME_LENGTH, leftSegment.length, rightSegment.length),
      );
      const forbiddenNames = new Set([leftSegment, rightSegment]);

      let nextProbeParent: string | undefined;
      if (normalizedLeft !== normalizedRight) {
        // Case and normalization are independent gates. A synthetic ASCII case
        // probe here never bypasses the raw-spelling normalization probe below.
        let caseProbeParent = probeParent;
        let caseProbePairs = createAsciiCaseProbePairs(componentProbeNameLength, forbiddenNames);
        if (!areAsciiCaseVariants(normalizedLeft, normalizedRight)) {
          if (!shouldProbeUnicodeCaseVariants(normalizedLeft, normalizedRight)) {
            missingSuffixAliasCache.set(cacheKey, false);
            return false;
          }
          const privateParent = createNeutralProbeDirectory({
            parentPath: probeParent,
            createdPaths,
            forbiddenNames,
            nameLength: componentProbeNameLength,
          });
          if (!privateParent) {
            return true;
          }
          caseProbeParent = privateParent;
          caseProbePairs = [[leftSegment, rightSegment]];
        }
        const caseProbe = createDirectoryAliasProbe({
          parentPath: caseProbeParent,
          pairs: caseProbePairs,
          createdPaths,
        });
        if (!caseProbe) {
          return true;
        }
        if (!caseProbe.aliases) {
          missingSuffixAliasCache.set(cacheKey, false);
          return false;
        }
        nextProbeParent = caseProbe.path;
      }
      if (leftSegment !== normalizedLeft || rightSegment !== normalizedRight) {
        let normalizationPairs = createNormalizationProbePairs(leftSegment, rightSegment).filter(
          ([probeLeft, probeRight]) =>
            probeLeft.length <= availableProbeNameLength &&
            probeRight.length <= availableProbeNameLength,
        );
        let normalizationProbeParent = probeParent;
        if (normalizationPairs.length === 0) {
          const privateParent = createNeutralProbeDirectory({
            parentPath: probeParent,
            createdPaths,
            forbiddenNames,
            nameLength: componentProbeNameLength,
          });
          if (!privateParent) {
            return true;
          }
          normalizationProbeParent = privateParent;
          normalizationPairs = [[leftSegment, rightSegment]];
        }
        const normalizationProbe = createDirectoryAliasProbe({
          parentPath: normalizationProbeParent,
          pairs: normalizationPairs,
          createdPaths,
        });
        if (!normalizationProbe) {
          return true;
        }
        if (!normalizationProbe.aliases) {
          missingSuffixAliasCache.set(cacheKey, false);
          return false;
        }
        nextProbeParent ??= normalizationProbe.path;
      }
      if (index < leftSegments.length - 1) {
        nextProbeParent ??= createNeutralProbeDirectory({
          parentPath: probeParent,
          createdPaths,
          forbiddenNames,
          nameLength: componentProbeNameLength,
        });
        if (!nextProbeParent) {
          return true;
        }
        probeParent = nextProbeParent;
      }
    }
    missingSuffixAliasCache.set(cacheKey, true);
    return true;
  } catch {
    // Unprobeable case/normalization candidates are ambiguous. Treat them as
    // colliding so registry uniqueness fails closed instead of admitting two owners.
    return true;
  } finally {
    for (const created of createdPaths.toReversed()) {
      removeOwnedProbePath(created);
    }
  }
}

function resolveDanglingSymlinkTargetPath(lexicalPath: string): {
  existingPath: string;
  unresolvedSegments: string[];
} {
  let resolved = path.parse(lexicalPath).root;
  const remaining = lexicalPath.slice(resolved.length).split(path.sep).filter(Boolean);
  const visitedSymlinks = new Set<string>();
  const visitedResolutionStates = new Set<string>();
  let symlinkHops = 0;
  while (remaining.length > 0) {
    const segment = remaining.shift();
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      resolved = path.dirname(resolved);
      continue;
    }
    const candidate = path.join(resolved, segment);
    try {
      const stat = lstatSync(candidate, { bigint: true });
      if (!stat.isSymbolicLink()) {
        resolved = candidate;
        continue;
      }
      const symlinkIdentity = `${stat.dev}:${stat.ino}:${candidate}`;
      const resolutionState = `${symlinkIdentity}\0${remaining.join(path.sep)}`;
      if (
        symlinkHops >= MAX_DANGLING_SYMLINK_HOPS ||
        (visitedSymlinks.has(symlinkIdentity) && visitedResolutionStates.has(resolutionState))
      ) {
        throw createSymlinkLoopError(lexicalPath);
      }
      visitedSymlinks.add(symlinkIdentity);
      visitedResolutionStates.add(resolutionState);
      symlinkHops += 1;
      const target = readlinkSync(candidate);
      if (path.isAbsolute(target)) {
        resolved = path.parse(target).root;
        remaining.unshift(...target.slice(resolved.length).split(path.sep));
      } else {
        // Process raw target components in order: normalizing `..` here would skip
        // filesystem resolution of a preceding symlink and could change ownership.
        remaining.unshift(...target.split(path.sep));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Once a component is missing, later `..` components cannot traverse it
        // on the filesystem. Preserve the raw suffix so lexical normalization
        // cannot alias this dangling path to a live database.
        return { existingPath: resolved, unresolvedSegments: [segment, ...remaining] };
      }
      throw error;
    }
  }
  return { existingPath: resolved, unresolvedSegments: [] };
}

function anchorDatabasePathWithoutNormalizing(pathname: string): string {
  const platformPath = path.sep === "\\" ? pathname.replaceAll("/", "\\") : pathname;
  if (path.isAbsolute(platformPath)) {
    return platformPath;
  }
  if (path.sep === "\\") {
    const driveRelative = /^([A-Za-z]:)(.*)$/u.exec(platformPath);
    if (driveRelative) {
      // Resolve only the drive's current-directory anchor. Appending the raw
      // suffix preserves `..` for the component-wise filesystem walk below.
      const driveBase = path.resolve(`${driveRelative[1]}.`);
      return driveRelative[2]
        ? `${driveBase}${driveBase.endsWith(path.sep) ? "" : path.sep}${driveRelative[2]}`
        : driveBase;
    }
  }
  const cwd = process.cwd();
  return `${cwd}${cwd.endsWith(path.sep) ? "" : path.sep}${platformPath}`;
}

function resolveAgentDatabasePathIdentity(pathname: string): AgentDatabasePathIdentity {
  // `path.resolve` collapses `..` before symlinks are inspected, but the filesystem
  // resolves `link/..` from the link target. Anchor relative input without rewriting tokens.
  const lexicalPath = anchorDatabasePathWithoutNormalizing(pathname);
  try {
    const stat = statSync(lexicalPath, { bigint: true });
    return {
      lexicalPath,
      realPath: realpathSync.native(lexicalPath),
      device: stat.dev,
      inode: stat.ino,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // Preserve symlink/alias identity before the leaf exists without lexically
    // collapsing unresolved components such as `missing/../live.sqlite`.
    const dangling = resolveDanglingSymlinkTargetPath(lexicalPath);
    const parentStat = statSync(dangling.existingPath, { bigint: true });
    const parentRealPath = realpathSync.native(dangling.existingPath);
    return {
      lexicalPath,
      parentDevice: parentStat.dev,
      parentInode: parentStat.ino,
      parentRealPath,
      unresolvedSuffix: dangling.unresolvedSegments.join(path.sep),
    };
  }
}

/** Compare two database locators by canonical filesystem identity when available. */
export function isSameOpenClawAgentDatabasePath(left: string, right: string): boolean {
  const leftIdentity = resolveAgentDatabasePathIdentity(left);
  const rightIdentity = resolveAgentDatabasePathIdentity(right);
  if (leftIdentity.lexicalPath === rightIdentity.lexicalPath) {
    return true;
  }
  if (leftIdentity.realPath && leftIdentity.realPath === rightIdentity.realPath) {
    return true;
  }
  const parentDevice = leftIdentity.parentDevice;
  const parentInode = leftIdentity.parentInode;
  const sameMissingParent =
    parentDevice !== undefined &&
    parentInode !== undefined &&
    parentDevice === rightIdentity.parentDevice &&
    parentInode === rightIdentity.parentInode;
  const sameMissingSuffix =
    leftIdentity.unresolvedSuffix === rightIdentity.unresolvedSuffix ||
    (sameMissingParent &&
      parentDevice !== undefined &&
      parentInode !== undefined &&
      leftIdentity.parentRealPath !== undefined &&
      areMissingSuffixAliases({
        left: leftIdentity.unresolvedSuffix,
        right: rightIdentity.unresolvedSuffix,
        parentDevice,
        parentInode,
        parentRealPath: leftIdentity.parentRealPath,
      }));
  return (
    (leftIdentity.device !== undefined &&
      leftIdentity.inode !== undefined &&
      leftIdentity.device === rightIdentity.device &&
      leftIdentity.inode === rightIdentity.inode) ||
    (sameMissingParent && sameMissingSuffix)
  );
}

export function registerOpenClawAgentDatabase(params: {
  agentId: string;
  path: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const deletionFence = prepareAgentDeletionPathFence(
    { agentId: params.agentId, path: params.path },
    { env: params.env },
  );
  let sizeBytes: number | null = null;
  try {
    sizeBytes = statSync(params.path).size;
  } catch {
    sizeBytes = null;
  }
  const lastSeenAt = Date.now();
  runOpenClawStateWriteTransaction(
    (database) => {
      assertAgentDeletionPathFence(database.db, deletionFence);
      const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("agent_databases")
          .values({
            agent_id: params.agentId,
            path: params.path,
            schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
            last_seen_at: lastSeenAt,
            size_bytes: sizeBytes,
          })
          .onConflict((conflict) =>
            conflict.columns(["agent_id", "path"]).doUpdateSet({
              schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
              last_seen_at: lastSeenAt,
              size_bytes: sizeBytes,
            }),
          ),
      );
    },
    { env: params.env },
  );
  invalidateRegisteredAgentDatabasesMemo({ env: params.env });
}

export function unregisterOpenClawAgentDatabase(params: {
  agentId: string;
  path: string;
  env?: NodeJS.ProcessEnv;
}): void {
  runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("agent_databases")
          .where("agent_id", "=", params.agentId)
          .where("path", "=", params.path),
      );
    },
    { env: params.env },
  );
  invalidateRegisteredAgentDatabasesMemo({ env: params.env });
}
