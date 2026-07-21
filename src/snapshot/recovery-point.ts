import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { stableStringify } from "../agents/stable-stringify.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { root } from "../infra/fs-safe.js";
import { isValidAgentId, normalizeAgentId } from "../routing/session-key.js";
import {
  SNAPSHOT_MANIFEST_FILENAME,
  type SnapshotManifest,
  type SnapshotRef,
  type SqliteSnapshotProvider,
} from "./snapshot-provider.js";

export const RECOVERY_POINT_VERSION = "openclaw-recovery-point/v1";

const MAX_OWNER_MANIFEST_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,254}$/u;

const obligationSchema = z
  .object({
    id: z.string().regex(SAFE_ID_PATTERN),
    owner: z.string().regex(SAFE_ID_PATTERN),
    readinessRequired: z.boolean(),
  })
  .strict();

const componentBaseSchema = {
  id: z.string().regex(SAFE_ID_PATTERN),
  artifactSha256: z.string().regex(SHA256_PATTERN),
  artifactSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ownerManifestSha256: z.string().regex(SHA256_PATTERN),
  compatibility: z.string().regex(SAFE_ID_PATTERN),
  dependsOn: z.array(z.string().regex(SAFE_ID_PATTERN)),
  capturedAt: z.string(),
  required: z.boolean(),
};

const recoveryPointComponentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...componentBaseSchema,
      id: z.literal("sqlite/global"),
      kind: z.literal("sqlite-global"),
      owner: z.literal("openclaw-state"),
    })
    .strict(),
  z
    .object({
      ...componentBaseSchema,
      kind: z.literal("sqlite-agent"),
      owner: z.literal("openclaw-agent-state"),
      agentId: z.string().min(1).max(64),
    })
    .strict(),
]);

const recoveryPointManifestSchema = z
  .object({
    version: z.literal(RECOVERY_POINT_VERSION),
    recoveryPointId: z.string().regex(SHA256_PATTERN),
    createdAt: z.string(),
    components: z.array(recoveryPointComponentSchema).min(1),
    obligations: z
      .object({
        external: z.array(obligationSchema),
        reconstructed: z.array(obligationSchema),
        ephemeral: z.array(obligationSchema),
      })
      .strict(),
  })
  .strict();

export type RecoveryPointObligation = z.infer<typeof obligationSchema>;
export type RecoveryPointComponent = z.infer<typeof recoveryPointComponentSchema>;
export type RecoveryPointManifest = z.infer<typeof recoveryPointManifestSchema>;

export type RecoveryPointSqliteSnapshot = {
  readonly provider: SqliteSnapshotProvider;
  readonly ref: SnapshotRef;
};

export type RecoveryPointObligations = {
  readonly external?: readonly RecoveryPointObligation[];
  readonly reconstructed?: readonly RecoveryPointObligation[];
  readonly ephemeral?: readonly RecoveryPointObligation[];
};

export async function createRecoveryPointManifest(params: {
  snapshots: readonly RecoveryPointSqliteSnapshot[];
  obligations?: RecoveryPointObligations;
  now?: () => Date;
}): Promise<RecoveryPointManifest> {
  const now = (params.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Recovery point timestamp is invalid.");
  }

  const components = await Promise.all(params.snapshots.map(buildVerifiedComponent));
  components.sort(compareComponents);
  assertRequiredSqliteInventory(components);

  const manifestWithoutId = {
    version: RECOVERY_POINT_VERSION,
    createdAt: now.toISOString(),
    components,
    obligations: normalizeObligations(params.obligations),
  };
  return verifyRecoveryPointManifest({
    ...manifestWithoutId,
    recoveryPointId: digestRecoveryPoint(manifestWithoutId),
  });
}

export function verifyRecoveryPointManifest(value: unknown): RecoveryPointManifest {
  const parsed = recoveryPointManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Recovery point manifest is invalid: ${parsed.error.message}`);
  }
  const manifest = parsed.data;
  assertCanonicalTimestamp(manifest.createdAt, "createdAt");
  for (const component of manifest.components) {
    assertCanonicalTimestamp(component.capturedAt, `${component.id}.capturedAt`);
    if (component.kind === "sqlite-agent") {
      if (
        !isValidAgentId(component.agentId) ||
        normalizeAgentId(component.agentId) !== component.agentId
      ) {
        throw new Error(`Recovery point component agent id is invalid: ${component.agentId}.`);
      }
      if (component.id !== `sqlite/agent/${component.agentId}`) {
        throw new Error(`Recovery point component id does not match agent ${component.agentId}.`);
      }
    }
  }
  assertCanonicalComponentOrder(manifest.components);
  assertRequiredSqliteInventory(manifest.components);
  assertDependencies(manifest.components);
  assertCanonicalObligationOrder(manifest.obligations);
  assertObligationIds(manifest.obligations);

  const { recoveryPointId: _recoveryPointId, ...manifestWithoutId } = manifest;
  const expectedId = digestRecoveryPoint(manifestWithoutId);
  if (manifest.recoveryPointId !== expectedId) {
    throw new Error(
      `Recovery point identity mismatch: expected ${expectedId}, got ${manifest.recoveryPointId}.`,
    );
  }
  return manifest;
}

export async function verifyRecoveryPoint(params: {
  manifest: unknown;
  snapshots: readonly RecoveryPointSqliteSnapshot[];
}): Promise<RecoveryPointManifest> {
  const manifest = verifyRecoveryPointManifest(params.manifest);
  const actualComponents = await Promise.all(params.snapshots.map(buildVerifiedComponent));
  actualComponents.sort(compareComponents);
  if (!isDeepStrictEqual(actualComponents, manifest.components)) {
    throw new Error("Recovery point SQLite components do not match the verified owner snapshots.");
  }
  return manifest;
}

async function buildVerifiedComponent(
  snapshot: RecoveryPointSqliteSnapshot,
): Promise<RecoveryPointComponent> {
  const firstVerification = await snapshot.provider.verify(snapshot.ref);
  const firstManifestRead = await readOwnerManifest(snapshot.ref);
  const secondVerification = await snapshot.provider.verify(snapshot.ref);
  const secondManifestRead = await readOwnerManifest(snapshot.ref);
  if (
    !isDeepStrictEqual(firstVerification.manifest, secondVerification.manifest) ||
    !isDeepStrictEqual(firstManifestRead.parsed, secondVerification.manifest) ||
    firstManifestRead.sha256 !== secondManifestRead.sha256
  ) {
    throw new Error(
      `SQLite owner manifest changed during recovery-point composition: ${snapshot.ref.path}`,
    );
  }
  return componentFromSnapshotManifest(secondVerification.manifest, secondManifestRead.sha256);
}

async function readOwnerManifest(ref: SnapshotRef): Promise<{ parsed: unknown; sha256: string }> {
  const snapshotRoot = await root(ref.path);
  const manifestRead = await snapshotRoot.read(SNAPSHOT_MANIFEST_FILENAME, {
    hardlinks: "reject",
    maxBytes: MAX_OWNER_MANIFEST_BYTES,
    symlinks: "reject",
  });
  try {
    return {
      parsed: JSON.parse(manifestRead.buffer.toString("utf8")) as unknown,
      sha256: sha256Hex(manifestRead.buffer),
    };
  } catch (error) {
    throw new Error(`Verified SQLite owner manifest is not valid JSON: ${ref.path}`, {
      cause: error,
    });
  }
}

function componentFromSnapshotManifest(
  manifest: SnapshotManifest,
  ownerManifestSha256: string,
): RecoveryPointComponent {
  const common = {
    artifactSha256: manifest.artifact.sha256,
    artifactSizeBytes: manifest.artifact.sizeBytes,
    ownerManifestSha256,
    dependsOn: [],
    capturedAt: manifest.createdAt,
    required: true,
  };
  if (manifest.database.role === "global") {
    return recoveryPointComponentSchema.parse({
      ...common,
      id: "sqlite/global",
      kind: "sqlite-global",
      owner: "openclaw-state",
      compatibility: `openclaw-state-schema/${manifest.database.userVersion}`,
    });
  }
  if (manifest.database.role === "agent") {
    return recoveryPointComponentSchema.parse({
      ...common,
      id: `sqlite/agent/${manifest.database.agentId}`,
      kind: "sqlite-agent",
      owner: "openclaw-agent-state",
      agentId: manifest.database.agentId,
      compatibility: `openclaw-agent-schema/${manifest.database.userVersion}`,
    });
  }
  throw new Error("Generic SQLite snapshots are not eligible recovery-point components.");
}

function normalizeObligations(obligations: RecoveryPointObligations | undefined) {
  const normalized = {
    external: (obligations?.external ?? []).toSorted(compareObligations),
    reconstructed: (obligations?.reconstructed ?? []).toSorted(compareObligations),
    ephemeral: (obligations?.ephemeral ?? []).toSorted(compareObligations),
  };
  assertObligationIds(normalized);
  return normalized;
}

function assertRequiredSqliteInventory(components: readonly RecoveryPointComponent[]): void {
  const globalCount = components.filter((component) => component.kind === "sqlite-global").length;
  const agentCount = components.filter((component) => component.kind === "sqlite-agent").length;
  if (globalCount !== 1 || agentCount < 1) {
    throw new Error(
      "Recovery point V1 requires exactly one global and at least one agent SQLite component.",
    );
  }
  const ids = new Set<string>();
  for (const component of components) {
    if (ids.has(component.id)) {
      throw new Error(`Recovery point contains duplicate component id: ${component.id}.`);
    }
    ids.add(component.id);
  }
}

function assertCanonicalComponentOrder(components: readonly RecoveryPointComponent[]): void {
  const sorted = components.toSorted(compareComponents);
  if (!components.every((component, index) => component.id === sorted[index]?.id)) {
    throw new Error("Recovery point components are not in canonical order.");
  }
}

function assertDependencies(components: readonly RecoveryPointComponent[]): void {
  const byId = new Map(components.map((component) => [component.id, component]));
  for (const component of components) {
    const dependencies = new Set<string>();
    for (const dependency of component.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(
          `Recovery point component ${component.id} has missing dependency ${dependency}.`,
        );
      }
      if (dependency === component.id || dependencies.has(dependency)) {
        throw new Error(
          `Recovery point component ${component.id} has invalid dependency ${dependency}.`,
        );
      }
      dependencies.add(dependency);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new Error(`Recovery point component dependency cycle includes ${id}.`);
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const component of components) {
    visit(component.id);
  }
}

function assertCanonicalObligationOrder(obligations: {
  external: readonly RecoveryPointObligation[];
  reconstructed: readonly RecoveryPointObligation[];
  ephemeral: readonly RecoveryPointObligation[];
}): void {
  for (const entries of [obligations.external, obligations.reconstructed, obligations.ephemeral]) {
    const sorted = entries.toSorted(compareObligations);
    if (
      !entries.every(
        (entry, index) => entry.id === sorted[index]?.id && entry.owner === sorted[index]?.owner,
      )
    ) {
      throw new Error("Recovery point obligations are not in canonical order.");
    }
  }
}

function assertObligationIds(obligations: {
  external: readonly RecoveryPointObligation[];
  reconstructed: readonly RecoveryPointObligation[];
  ephemeral: readonly RecoveryPointObligation[];
}): void {
  const ids = new Set<string>();
  for (const entries of [obligations.external, obligations.reconstructed, obligations.ephemeral]) {
    for (const obligation of entries) {
      if (ids.has(obligation.id)) {
        throw new Error(`Recovery point contains duplicate obligation id: ${obligation.id}.`);
      }
      ids.add(obligation.id);
    }
  }
}

function assertCanonicalTimestamp(value: string, label: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`Recovery point ${label} is not a canonical timestamp.`);
  }
}

function digestRecoveryPoint(manifestWithoutId: object): string {
  return sha256Hex(stableStringify(manifestWithoutId));
}

function compareComponents(left: RecoveryPointComponent, right: RecoveryPointComponent): number {
  if (left.kind !== right.kind) {
    return left.kind === "sqlite-global" ? -1 : 1;
  }
  return compareCodeUnits(left.id, right.id);
}

function compareObligations(left: RecoveryPointObligation, right: RecoveryPointObligation): number {
  return compareCodeUnits(left.id, right.id) || compareCodeUnits(left.owner, right.owner);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
