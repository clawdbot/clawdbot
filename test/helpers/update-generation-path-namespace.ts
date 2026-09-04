/** Stable directory capabilities for an update-generation namespace. */
import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../../src/infra/errors.js";
import { syncUpdateGenerationPath } from "./update-generation-path-manifest.js";

const GENERATIONS_DIRECTORY_NAME = "generations";

type UpdateGenerationDirectoryIdentity = {
  device: bigint;
  inode: bigint;
  parentPath: string;
  parentDevice: bigint;
  parentInode: bigint;
  parentMtimeNs: bigint;
  parentCtimeNs: bigint;
};

export type UpdateGenerationNamespace = {
  root: string;
  rootIdentity: UpdateGenerationDirectoryIdentity;
  generationsRoot: string | null;
  generationsIdentity: UpdateGenerationDirectoryIdentity | null;
};

function directoryIdentitiesEqual(
  left: UpdateGenerationDirectoryIdentity,
  right: UpdateGenerationDirectoryIdentity,
  includeParentRevision = true,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.parentDevice === right.parentDevice &&
    left.parentInode === right.parentInode &&
    (!includeParentRevision ||
      (left.parentMtimeNs === right.parentMtimeNs && left.parentCtimeNs === right.parentCtimeNs))
  );
}

function ownedDirectoryDescription(label: string): string {
  return label === "generations directory"
    ? "update generations directory"
    : `update generation ${label}`;
}

async function readOwnedDirectoryIdentity(
  directoryPath: string,
  label: string,
): Promise<UpdateGenerationDirectoryIdentity | null> {
  const stat = await fs.lstat(directoryPath, { bigint: true }).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  if (!stat) {
    return null;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Invalid ${ownedDirectoryDescription(label)}: ${directoryPath}`);
  }
  const parentPath = path.dirname(directoryPath);
  const parent = await fs.stat(parentPath, { bigint: true });
  if (!parent.isDirectory()) {
    throw new Error(`Invalid ${ownedDirectoryDescription(label)} parent: ${parentPath}`);
  }
  return {
    device: stat.dev,
    inode: stat.ino,
    parentPath,
    parentDevice: parent.dev,
    parentInode: parent.ino,
    parentMtimeNs: parent.mtimeNs,
    parentCtimeNs: parent.ctimeNs,
  };
}

async function resolveOwnedDirectory(
  requestedPath: string,
  label: string,
): Promise<{ path: string; identity: UpdateGenerationDirectoryIdentity } | null> {
  const before = await readOwnedDirectoryIdentity(requestedPath, label);
  if (!before) {
    return null;
  }
  const resolvedPath = await fs.realpath(requestedPath);
  const [after, resolved] = await Promise.all([
    readOwnedDirectoryIdentity(requestedPath, label),
    readOwnedDirectoryIdentity(resolvedPath, label),
  ]);
  const final = await readOwnedDirectoryIdentity(requestedPath, label);
  if (
    !after ||
    !resolved ||
    !final ||
    !directoryIdentitiesEqual(before, after) ||
    !directoryIdentitiesEqual(before, resolved) ||
    !directoryIdentitiesEqual(before, final)
  ) {
    throw new Error(
      `${ownedDirectoryDescription(label)} changed during path resolution: ${requestedPath}`,
    );
  }
  return { path: resolvedPath, identity: before };
}

async function assertOwnedDirectoryIdentity(params: {
  directoryPath: string;
  identity: UpdateGenerationDirectoryIdentity;
  label: string;
  includeParentRevision?: boolean;
}): Promise<void> {
  const actual = await readOwnedDirectoryIdentity(params.directoryPath, params.label);
  if (
    !actual ||
    actual.parentPath !== params.identity.parentPath ||
    !directoryIdentitiesEqual(actual, params.identity, params.includeParentRevision)
  ) {
    throw new Error(`${ownedDirectoryDescription(params.label)} changed: ${params.directoryPath}`);
  }
}

export async function assertUpdateGenerationNamespaceIdentity(
  namespace: UpdateGenerationNamespace,
  options: { includeGenerationsParentRevision?: boolean } = {},
): Promise<void> {
  await assertOwnedDirectoryIdentity({
    directoryPath: namespace.root,
    identity: namespace.rootIdentity,
    label: "namespace",
  });
  if (namespace.generationsRoot && namespace.generationsIdentity) {
    await assertOwnedDirectoryIdentity({
      directoryPath: namespace.generationsRoot,
      identity: namespace.generationsIdentity,
      label: "generations directory",
      includeParentRevision: options.includeGenerationsParentRevision,
    });
  }
}

export async function updateGenerationNamespaceIdentityIsCurrent(
  namespace: UpdateGenerationNamespace,
  options: { includeGenerationsParentRevision?: boolean } = {},
): Promise<boolean> {
  return await assertUpdateGenerationNamespaceIdentity(namespace, options).then(
    () => true,
    () => false,
  );
}

export async function resolveUpdateGenerationNamespace(params: {
  namespaceRoot: string;
  create: boolean;
  requireGenerations: boolean;
}): Promise<UpdateGenerationNamespace | null> {
  const requestedRoot = path.resolve(params.namespaceRoot);
  if (params.create) {
    let createdRoot = false;
    await fs.mkdir(requestedRoot, { mode: 0o700 }).then(
      () => {
        createdRoot = true;
      },
      (error: unknown) => {
        if (!hasErrnoCode(error, "EEXIST")) {
          throw error;
        }
      },
    );
    if (createdRoot) {
      await syncUpdateGenerationPath(path.dirname(requestedRoot));
    }
  }
  const resolvedRoot = await resolveOwnedDirectory(requestedRoot, "namespace");
  if (!resolvedRoot) {
    return null;
  }
  const { path: root, identity: rootIdentity } = resolvedRoot;
  const requestedGenerationsRoot = path.join(root, GENERATIONS_DIRECTORY_NAME);
  if (params.create) {
    await assertOwnedDirectoryIdentity({
      directoryPath: root,
      identity: rootIdentity,
      label: "namespace",
    });
    let createdGenerationsRoot = false;
    await fs.mkdir(requestedGenerationsRoot, { mode: 0o700 }).then(
      () => {
        createdGenerationsRoot = true;
      },
      (error: unknown) => {
        if (!hasErrnoCode(error, "EEXIST")) {
          throw error;
        }
      },
    );
    if (createdGenerationsRoot) {
      await syncUpdateGenerationPath(root);
    }
  }
  const resolvedGenerations = await resolveOwnedDirectory(
    requestedGenerationsRoot,
    "generations directory",
  );
  if (!resolvedGenerations) {
    if (params.requireGenerations) {
      throw new Error(`Update generation namespace is incomplete: ${requestedGenerationsRoot}`);
    }
    return { root, rootIdentity, generationsRoot: null, generationsIdentity: null };
  }
  const { path: generationsRoot, identity: generationsIdentity } = resolvedGenerations;
  if (path.dirname(generationsRoot) !== root) {
    throw new Error(`Update generations directory escapes its namespace: ${generationsRoot}`);
  }
  await assertOwnedDirectoryIdentity({
    directoryPath: root,
    identity: rootIdentity,
    label: "namespace",
  });
  return { root, rootIdentity, generationsRoot, generationsIdentity };
}
