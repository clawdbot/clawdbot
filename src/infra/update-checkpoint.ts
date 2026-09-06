import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { z } from "zod";
import type { BackupResourceInventory } from "../commands/backup-resource-inventory.js";
import type { BackupAsset } from "../commands/backup-shared.js";
import { sha256Hex } from "./crypto-digest.js";
import {
  ensureDurableDirectory,
  requireDirectorySync,
  syncDirectory,
} from "./directory-durability.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { hasNodeErrorCode, isPathInside } from "./path-guards.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import type { UpdateStateSchemaVersion } from "./update-candidate-state.js";
import {
  checkpointContentMatches,
  copyCheckpointFile,
  inspectCheckpointFile,
  syncCheckpointTree,
  type CheckpointFileState,
} from "./update-checkpoint-files.js";
import {
  checkpointPluginIndexMutationsMatch,
  UpdateCheckpointPluginIndexMutationSchema,
  type UpdateCheckpointPluginIndexMutation,
} from "./update-checkpoint-plugin-index.js";
import { createUpdateCheckpointSqliteSnapshot } from "./update-checkpoint-sqlite.js";

const absolutePath = z
  .string()
  .refine((value) => path.isAbsolute(value) && path.normalize(value) === value);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const CheckpointFileStateSchema = z
  .object({
    kind: z.enum(["file", "directory"]),
    sha256: digest,
    descendantIdentitySha256: digest.optional(),
    mode: z.number().int(),
    identity: z
      .object({
        dev: z.number(),
        ino: z.number(),
        size: z.number(),
        mtimeMs: z.number(),
        ctimeMs: z.number(),
      })
      .strict(),
  })
  .strict();
const bindingSchema = z
  .object({
    runId: z.string().min(1),
    stateDir: absolutePath,
    configPath: absolutePath,
    fromRuntime: z
      .object({ root: absolutePath, version: z.string().min(1), nodePath: absolutePath })
      .strict(),
  })
  .strict();
const resourceSchema = z
  .object({
    sourcePath: absolutePath,
    kind: z.enum(["config", "state", "sqlite", "plugin", "service"]),
    restore: z.enum(["replace", "preserve"]),
  })
  .strict();
/** A locator, never serialized authority. Reopen against a fresh binding and artifact root. */
export const UpdateCheckpointRefSchema = z
  .object({
    checkpointId: z.string().uuid(),
    manifestPath: absolutePath,
    manifestSha256: digest,
  })
  .strict();
export type UpdateCheckpointRef = z.infer<typeof UpdateCheckpointRefSchema>;
const manifestSchema = z
  .object({
    checkpointId: z.string().uuid(),
    purpose: z.enum(["checkpoint", "preimage"]).optional(),
    preimageRef: UpdateCheckpointRefSchema.optional(),
    binding: bindingSchema,
    createdAtMs: z.number().int(),
    exclusions: z.array(z.string()),
    pluginIndexMutations: z.array(UpdateCheckpointPluginIndexMutationSchema).max(1024).optional(),
    resources: z.array(
      resourceSchema
        .extend({
          artifact: z
            .string()
            .regex(/^resource-[0-9]+$/u)
            .nullable(),
          captured: CheckpointFileStateSchema.nullable(),
          // Older artifacts remain inspectable, but cannot authorize file replacement.
          sourceState: CheckpointFileStateSchema.nullable().optional(),
          // Records validation of owner-supplied facts, never live mutation authority.
          sourceBindingValidated: z.boolean().optional(),
          userVersion: z.number().int().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type UpdateCheckpointBinding = z.infer<typeof bindingSchema>;
/** Facts retained by a mutation owner at its write boundary, not sampled during rollback. */
export type UpdateCheckpointSourceBinding = {
  sourcePath: string;
  state: CheckpointFileState | null;
};
export type UpdateCheckpointResource = z.infer<typeof resourceSchema>;
export type UpdateCheckpointManifest = z.infer<typeof manifestSchema>;
export type ReopenedUpdateCheckpoint = {
  ref: UpdateCheckpointRef;
  manifest: UpdateCheckpointManifest;
};
export type UpdateCheckpointReadAccess = {
  artifactRoot: string;
  binding: UpdateCheckpointBinding;
};
export type UpdateCheckpointAccess = UpdateCheckpointReadAccess & {
  /** Current owner-held exclusion/claim. Throws if any state writer can still run. */
  assertQuiescent: () => void;
};

/** Expand the existing frozen backup inventory; non-update files are retained during restoration. */
export async function collectUpdateCheckpointResources(params: {
  inventory: BackupResourceInventory;
  assets: readonly BackupAsset[];
  databases: readonly UpdateStateSchemaVersion[];
  configFiles: readonly string[];
  serviceFiles: readonly string[];
  pluginRoots: readonly string[];
}): Promise<UpdateCheckpointResource[]> {
  const resources = new Map<string, UpdateCheckpointResource>();
  const databasePaths = new Set(params.databases.map((entry) => entry.path));
  const configFiles = new Set(params.configFiles);
  const reserved = [...params.pluginRoots, ...params.serviceFiles];
  const visit = async (file: string): Promise<void> => {
    if (reserved.some((root) => file === root || isPathInside(root, file))) {
      return;
    }
    if (
      !params.inventory.isTraversable(file) ||
      params.inventory.isVolatile(file) ||
      params.inventory.isPackageContent(file)
    ) {
      return;
    }
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).toSorted()) {
        await visit(path.join(file, name));
      }
    } else if (stat.isFile() && params.inventory.isIncluded(file)) {
      if (databasePaths.has(file) || /\.(?:sqlite|db)(?:-wal|-shm|-journal)?$/u.test(file)) {
        return;
      }
      resources.set(file, {
        sourcePath: file,
        kind: configFiles.has(file) ? "config" : "state",
        restore: configFiles.has(file) ? "replace" : "preserve",
      });
    } else if (stat.isSymbolicLink()) {
      throw new Error(
        `Checkpoint inventory needs an explicit canonical owner for symlink: ${file}`,
      );
    }
  };
  for (const asset of params.assets) {
    if (asset.kind !== "workspace") {
      await visit(asset.sourcePath);
    }
  }
  for (const sourcePath of configFiles) {
    resources.set(sourcePath, { sourcePath, kind: "config", restore: "replace" });
  }
  for (const sourcePath of databasePaths) {
    resources.set(sourcePath, { sourcePath, kind: "sqlite", restore: "replace" });
  }
  for (const sourcePath of params.serviceFiles) {
    resources.set(sourcePath, { sourcePath, kind: "service", restore: "replace" });
  }
  for (const sourcePath of params.pluginRoots) {
    resources.set(sourcePath, { sourcePath, kind: "plugin", restore: "replace" });
  }
  return [...resources.values()].toSorted((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

function assertResourceBoundaries(
  resources: readonly UpdateCheckpointResource[],
  artifactRoot: string,
): void {
  for (const resource of resources) {
    resourceSchema.parse({
      sourcePath: resource.sourcePath,
      kind: resource.kind,
      restore: resource.restore,
    });
    if (
      resource.sourcePath === artifactRoot ||
      isPathInside(resource.sourcePath, artifactRoot) ||
      isPathInside(artifactRoot, resource.sourcePath)
    ) {
      throw new Error("Checkpoint artifacts must be outside captured resources");
    }
    if (
      resources.some(
        (other) =>
          other !== resource &&
          (other.sourcePath === resource.sourcePath ||
            isPathInside(resource.sourcePath, other.sourcePath)),
      )
    ) {
      throw new Error(`Overlapping checkpoint resource: ${resource.sourcePath}`);
    }
  }
}

/** Data retained by the lifecycle owner before independent writers can resume. */
export type UpdateCheckpointPreimageInput = {
  checkpointRef: UpdateCheckpointRef;
  postMutationSources: readonly UpdateCheckpointSourceBinding[];
};

type CaptureOptions = {
  resources: readonly UpdateCheckpointResource[];
  exclusions: readonly string[];
  /** Owner-retained outputs, including absence; required for replacement after-images. */
  expectedSources?: readonly UpdateCheckpointSourceBinding[];
  pluginIndexMutations?: readonly UpdateCheckpointPluginIndexMutation[];
  /** Earlier bytes plus lifecycle-owner outputs retained before other writers resume. */
  preimages?: UpdateCheckpointPreimageInput;
};

/** File-only preimages, not a whole-state checkpoint or authority to stop a service.
 * The owner must exclude mutations to these exact config/service sources while
 * capturing. Other runtime writers may run; no database is read here.
 */
export async function captureUpdateCheckpointPreimages(
  params: UpdateCheckpointReadAccess & {
    resources: readonly UpdateCheckpointResource[];
    assertSourcesQuiescent: () => undefined;
  },
): Promise<UpdateCheckpointRef> {
  assertPreimageResources(params.resources);
  return await captureCheckpoint(
    {
      ...params,
      exclusions: [],
      assertCurrent() {
        const result: unknown = params.assertSourcesQuiescent();
        if (result !== undefined) {
          if (isPromiseLike(result)) {
            void Promise.resolve(result).catch(() => undefined);
          }
          throw new TypeError("Preimage source fence must be synchronous and return undefined");
        }
      },
    },
    "preimage",
  );
}

/** Seal full state under current exclusion; imported preimages must match owner-bound post-stop facts. */
export async function captureUpdateCheckpoint(
  params: UpdateCheckpointAccess & CaptureOptions,
): Promise<UpdateCheckpointRef> {
  return await captureCheckpoint(
    { ...params, assertCurrent: params.assertQuiescent },
    "checkpoint",
  );
}

function assertPreimageResources(resources: readonly UpdateCheckpointResource[]): void {
  if (
    !resources.length ||
    resources.some(
      (resource) =>
        (resource.kind !== "config" && resource.kind !== "service") ||
        resource.restore !== "replace",
    )
  ) {
    throw new Error("Preimage capture requires explicit config/service files only");
  }
}

async function captureCheckpoint(
  params: UpdateCheckpointReadAccess & CaptureOptions & { assertCurrent: () => void },
  purpose: "checkpoint" | "preimage",
): Promise<UpdateCheckpointRef> {
  const binding = bindingSchema.parse(params.binding);
  absolutePath.parse(params.artifactRoot);
  assertResourceBoundaries(params.resources, params.artifactRoot);
  params.assertCurrent();
  if (params.preimages && (purpose === "preimage" || params.expectedSources)) {
    throw new Error("Preimages cannot be used as mutation after-images");
  }
  const preimage = params.preimages
    ? await reopenUpdateCheckpointPreimages(params.preimages.checkpointRef, params)
    : undefined;
  const postMutationSources = new Map<string, CheckpointFileState | null>();
  if (preimage && params.preimages) {
    for (const expected of params.preimages.postMutationSources) {
      if (
        postMutationSources.has(expected.sourcePath) ||
        !preimage.manifest.resources.some((resource) => resource.sourcePath === expected.sourcePath)
      ) {
        throw new Error("Invalid preimage source binding coverage");
      }
      postMutationSources.set(
        expected.sourcePath,
        CheckpointFileStateSchema.nullable().parse(expected.state),
      );
    }
    if (
      postMutationSources.size !== preimage.manifest.resources.length ||
      preimage.manifest.resources.some(
        (resource) =>
          !params.resources.some(
            (target) =>
              target.sourcePath === resource.sourcePath &&
              target.kind === resource.kind &&
              target.restore === resource.restore,
          ),
      )
    ) {
      throw new Error("Incomplete preimage source binding coverage");
    }
  }
  const pluginIndexMutations = z
    .array(UpdateCheckpointPluginIndexMutationSchema)
    .max(1024)
    .parse(params.pluginIndexMutations ?? []);
  const sharedPath = path.join(binding.stateDir, "state", "openclaw.sqlite");
  if (
    pluginIndexMutations.some(
      (mutation) =>
        mutation.databasePath !== sharedPath ||
        !params.resources.some(
          (resource) =>
            resource.sourcePath === sharedPath &&
            resource.kind === "sqlite" &&
            resource.restore === "replace",
        ),
    )
  ) {
    throw new Error("Checkpoint plugin-index mutation database mismatch");
  }
  const expectedSources = new Map<string, CheckpointFileState | null>();
  if (params.expectedSources) {
    const files = params.resources.filter(
      (resource) => resource.restore === "replace" && resource.kind !== "sqlite",
    );
    for (const expected of params.expectedSources) {
      if (
        expectedSources.has(expected.sourcePath) ||
        !files.some((resource) => resource.sourcePath === expected.sourcePath)
      ) {
        throw new Error("Invalid checkpoint source binding coverage");
      }
      expectedSources.set(
        expected.sourcePath,
        CheckpointFileStateSchema.nullable().parse(expected.state),
      );
    }
    if (expectedSources.size !== files.length) {
      throw new Error("Incomplete checkpoint source binding coverage");
    }
  }
  params.assertCurrent();
  const checkpointId = randomUUID();
  const root = await ensureDurableDirectory({ directoryPath: params.artifactRoot, mode: 0o700 });
  requireDirectorySync(root.parentSync, "Checkpoint artifact root creation");
  const directory = path.join(params.artifactRoot, checkpointId);
  await fs.mkdir(directory, { mode: 0o700 });
  const manifest: UpdateCheckpointManifest = {
    checkpointId,
    purpose,
    ...(preimage ? { preimageRef: preimage.ref } : {}),
    binding,
    createdAtMs: Date.now(),
    exclusions: [...params.exclusions],
    pluginIndexMutations,
    resources: [],
  };
  const sourceStates = new Map<string, CheckpointFileState | null>();
  for (const [index, resource] of params.resources.entries()) {
    params.assertCurrent();
    const before = await inspectCheckpointFile(resource.sourcePath);
    if (
      expectedSources.has(resource.sourcePath) &&
      !isDeepStrictEqual(before, expectedSources.get(resource.sourcePath))
    ) {
      throw new Error(`Checkpoint source binding changed: ${resource.sourcePath}`);
    }
    sourceStates.set(resource.sourcePath, before);
    if (purpose === "preimage" && before && before.kind !== "file") {
      throw new Error("Preimage capture requires regular files or explicit absence");
    }
    const imported = preimage?.manifest.resources.find(
      (entry) => entry.sourcePath === resource.sourcePath,
    );
    if (imported && preimage) {
      if (!isDeepStrictEqual(before, postMutationSources.get(resource.sourcePath))) {
        throw new Error(`Preimage source binding changed: ${resource.sourcePath}`);
      }
      const artifact = imported.captured ? `resource-${index}` : null;
      const captured =
        artifact && imported.artifact && imported.captured
          ? await copyCheckpointFile(
              path.join(path.dirname(preimage.ref.manifestPath), imported.artifact),
              path.join(directory, artifact),
              imported.captured,
            )
          : null;
      manifest.resources.push({
        ...resource,
        artifact,
        captured,
        sourceState: imported.sourceState,
        sourceBindingValidated: false,
        userVersion: null,
      });
      continue;
    }
    const artifact = before ? `resource-${index}` : null;
    let captured = before;
    let userVersion: number | null = null;
    if (artifact && before) {
      const targetPath = path.join(directory, artifact);
      if (resource.kind === "sqlite") {
        if (before.kind !== "file") {
          throw new Error("SQLite checkpoint resource is not a file");
        }
        userVersion = (
          await createUpdateCheckpointSqliteSnapshot({
            sourcePath: resource.sourcePath,
            targetPath,
            assertQuiescent: params.assertCurrent,
          })
        ).userVersion;
        captured = await inspectCheckpointFile(targetPath);
        const db = openNodeSqliteDatabase(targetPath, { readOnly: true });
        try {
          if (
            !checkpointPluginIndexMutationsMatch({
              mutations: pluginIndexMutations.filter(
                (mutation) => mutation.databasePath === resource.sourcePath,
              ),
              databasePath: resource.sourcePath,
              afterUpdate: db,
            })
          ) {
            throw new Error("Checkpoint plugin-index mutation after-image mismatch");
          }
        } finally {
          db.close();
        }
      } else {
        captured = await copyCheckpointFile(resource.sourcePath, targetPath, before);
      }
    }
    manifest.resources.push({
      ...resource,
      artifact,
      captured,
      sourceState: before,
      sourceBindingValidated: expectedSources.has(resource.sourcePath),
      userVersion,
    });
  }
  // An earlier preimage can become stale while later resources are copied.
  // Bind absence and physical identity as well as bytes before publishing any
  // manifest; matching artifact hashes alone only prove that the copy is intact.
  for (const [sourcePath, expected] of sourceStates) {
    params.assertCurrent();
    if (!isDeepStrictEqual(await inspectCheckpointFile(sourcePath), expected)) {
      throw new Error(`Resource changed before checkpoint seal: ${sourcePath}`);
    }
  }
  params.assertCurrent();
  const bytes = JSON.stringify(manifest);
  const manifestPath = path.join(directory, "manifest.json");
  await fs.writeFile(manifestPath, bytes, { flag: "wx", mode: 0o600 });
  await syncCheckpointTree(directory);
  requireDirectorySync(await syncDirectory(params.artifactRoot), "Checkpoint artifact root");
  const ref = { checkpointId, manifestPath, manifestSha256: sha256Hex(bytes) };
  await reopenCheckpoint(ref, params, purpose);
  params.assertCurrent();
  return ref;
}

/** Every artifact is rechecked, not only the manifest. This grants no publication authority. */
export async function reopenUpdateCheckpoint(
  ref: UpdateCheckpointRef,
  access: UpdateCheckpointReadAccess,
): Promise<ReopenedUpdateCheckpoint> {
  return await reopenCheckpoint(ref, access, "checkpoint");
}

/** Read-only validation of the early file artifact; never a restore/admission operation. */
export async function reopenUpdateCheckpointPreimages(
  ref: UpdateCheckpointRef,
  access: UpdateCheckpointReadAccess,
): Promise<ReopenedUpdateCheckpoint> {
  return await reopenCheckpoint(ref, access, "preimage");
}

async function reopenCheckpoint(
  ref: UpdateCheckpointRef,
  access: UpdateCheckpointReadAccess,
  purpose: "checkpoint" | "preimage",
): Promise<ReopenedUpdateCheckpoint> {
  UpdateCheckpointRefSchema.parse(ref);
  absolutePath.parse(access.artifactRoot);
  const expected = path.join(access.artifactRoot, ref.checkpointId, "manifest.json");
  if (ref.manifestPath !== expected || (await fs.realpath(ref.manifestPath)) !== expected) {
    throw new Error("Checkpoint manifest is outside its bound artifact root");
  }
  const stat = await fs.lstat(expected);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) {
    throw new Error("Invalid checkpoint manifest file");
  }
  const bytes = await fs.readFile(expected, "utf8");
  if (sha256Hex(bytes) !== ref.manifestSha256) {
    throw new Error("Checkpoint manifest digest mismatch");
  }
  const manifest = manifestSchema.parse(JSON.parse(bytes));
  if (
    manifest.checkpointId !== ref.checkpointId ||
    JSON.stringify(manifest.binding) !== JSON.stringify(bindingSchema.parse(access.binding))
  ) {
    throw new Error("Checkpoint binding mismatch");
  }
  if ((manifest.purpose ?? "checkpoint") !== purpose) {
    throw new Error("Checkpoint purpose mismatch");
  }
  if (purpose === "preimage") {
    assertPreimageResources(manifest.resources);
    if (
      manifest.preimageRef ||
      manifest.resources.some(
        (resource) => resource.captured?.kind === "directory" || resource.sourceState === undefined,
      )
    ) {
      throw new Error("Invalid preimage resources");
    }
  }
  assertResourceBoundaries(manifest.resources, access.artifactRoot);
  if (
    manifest.pluginIndexMutations?.some(
      (mutation) =>
        mutation.databasePath !== path.join(access.binding.stateDir, "state", "openclaw.sqlite") ||
        !manifest.resources.some(
          (resource) =>
            resource.sourcePath === mutation.databasePath &&
            resource.kind === "sqlite" &&
            resource.artifact &&
            resource.restore === "replace",
        ),
    )
  ) {
    throw new Error("Checkpoint plugin-index mutation database mismatch");
  }
  for (const resource of manifest.resources) {
    if ((resource.artifact === null) !== (resource.captured === null)) {
      throw new Error("Checkpoint artifact presence mismatch");
    }
    if (!resource.artifact) {
      continue;
    }
    const file = path.join(path.dirname(expected), resource.artifact);
    if (!checkpointContentMatches(await inspectCheckpointFile(file), resource.captured)) {
      throw new Error(`Checkpoint artifact changed: ${resource.artifact}`);
    }
    if (resource.kind === "sqlite") {
      const db = openNodeSqliteDatabase(file, { readOnly: true });
      try {
        if (
          !checkpointPluginIndexMutationsMatch({
            mutations: (manifest.pluginIndexMutations ?? []).filter(
              (mutation) => mutation.databasePath === resource.sourcePath,
            ),
            databasePath: resource.sourcePath,
            afterUpdate: db,
          })
        ) {
          throw new Error("Checkpoint plugin-index mutation after-image mismatch");
        }
        if (readSqliteUserVersion(db) !== resource.userVersion) {
          throw new Error("Checkpoint schema identity mismatch");
        }
      } finally {
        db.close();
      }
    }
  }
  return { ref, manifest };
}

/** Retention owner must supply current supersession authority; this never chooses what to retire. */
export async function retireUpdateCheckpoint(
  ref: UpdateCheckpointRef,
  access: UpdateCheckpointAccess & { assertSuperseded: () => void },
): Promise<void> {
  return await retireCheckpoint(ref, access, "checkpoint");
}

/** The retention owner may retire these copies only once they are superseded. */
export async function retireUpdateCheckpointPreimages(
  ref: UpdateCheckpointRef,
  access: UpdateCheckpointAccess & { assertSuperseded: () => void },
): Promise<void> {
  return await retireCheckpoint(ref, access, "preimage");
}

async function retireCheckpoint(
  ref: UpdateCheckpointRef,
  access: UpdateCheckpointAccess & { assertSuperseded: () => void },
  purpose: "checkpoint" | "preimage",
): Promise<void> {
  try {
    await fs.lstat(ref.manifestPath);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  await reopenCheckpoint(ref, access, purpose);
  access.assertSuperseded();
  access.assertQuiescent();
  await fs.rm(path.dirname(ref.manifestPath), { recursive: true });
  requireDirectorySync(await syncDirectory(access.artifactRoot), "Checkpoint retirement");
}
