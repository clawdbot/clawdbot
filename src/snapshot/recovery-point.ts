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

const RECOVERY_POINT_VERSION = "openclaw-recovery-point/v1";
const RECOVERY_POINT_ACCEPTANCE_VERSION = "openclaw-recovery-point-acceptance/v1";

const RECOVERY_POINT_INVENTORY_VERSION = "openclaw-runtime-sqlite-inventory/v1";

const MAX_OWNER_MANIFEST_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,254}$/u;

const obligationSchema = z
  .object({
    id: z.string().regex(SAFE_ID_PATTERN),
    kind: z.enum(["secret-ref", "plugin-dependency", "runtime-cache"]),
    owner: z.string().regex(SAFE_ID_PATTERN),
    readinessRequired: z.boolean(),
  })
  .strict();

const componentBaseSchema = {
  id: z.string().regex(SAFE_ID_PATTERN),
  artifactSha256: z.string().regex(SHA256_PATTERN),
  artifactSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ownerManifestSha256: z.string().regex(SHA256_PATTERN),
  ownerManifestSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
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
    inventory: z
      .object({
        version: z.literal(RECOVERY_POINT_INVENTORY_VERSION),
        requiredComponentIds: z.array(z.string().regex(SAFE_ID_PATTERN)).min(2),
      })
      .strict(),
    protection: z.object({ mode: z.literal("host-protected") }).strict(),
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

const recoveryPointAcceptanceSchema = z
  .object({
    version: z.literal(RECOVERY_POINT_ACCEPTANCE_VERSION),
    acceptanceSetId: z.string().regex(SHA256_PATTERN),
    recoveryPointId: z.string().regex(SHA256_PATTERN),
    aggregateManifestSha256: z.string().regex(SHA256_PATTERN),
    aggregateManifestSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    components: z.array(
      z
        .object({
          componentId: z.string().regex(SAFE_ID_PATTERN),
          ownerManifestSha256: z.string().regex(SHA256_PATTERN),
          ownerManifestSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
          artifactSha256: z.string().regex(SHA256_PATTERN),
          artifactSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    ),
  })
  .strict();

type RecoveryPointObligation = z.infer<typeof obligationSchema>;
type RecoveryPointComponent = z.infer<typeof recoveryPointComponentSchema>;
export type RecoveryPointManifest = z.infer<typeof recoveryPointManifestSchema>;
export type RecoveryPointAcceptance = z.infer<typeof recoveryPointAcceptanceSchema>;

export type RecoveryPointSqliteSnapshot = {
  readonly provider: SqliteSnapshotProvider;
  readonly ref: SnapshotRef;
};

type RecoveryPointObligations = {
  readonly external?: readonly RecoveryPointObligation[];
  readonly reconstructed?: readonly RecoveryPointObligation[];
  readonly ephemeral?: readonly RecoveryPointObligation[];
};

export async function createRecoveryPointManifest(params: {
  snapshots: readonly RecoveryPointSqliteSnapshot[];
  expectedAgentIds: readonly string[];
  obligations?: RecoveryPointObligations;
  now?: () => Date;
}): Promise<RecoveryPointManifest> {
  const now = (params.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Recovery point timestamp is invalid.");
  }

  const components = await Promise.all(params.snapshots.map(buildVerifiedComponent));
  components.sort(compareComponents);
  const requiredComponentIds = normalizeRequiredComponentIds(params.expectedAgentIds);
  assertRequiredSqliteInventory(components, requiredComponentIds);

  const manifestWithoutId = {
    version: RECOVERY_POINT_VERSION,
    createdAt: now.toISOString(),
    inventory: {
      version: RECOVERY_POINT_INVENTORY_VERSION,
      requiredComponentIds,
    },
    protection: { mode: "host-protected" },
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
  assertCanonicalRequiredInventory(manifest.inventory.requiredComponentIds);
  assertRequiredSqliteInventory(manifest.components, manifest.inventory.requiredComponentIds);
  assertDependencies(manifest.components);
  assertCanonicalObligationOrder(manifest.obligations);
  assertObligationIds(manifest.obligations);
  assertSupportedObligations(manifest.obligations);

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
  expectedAgentIds: readonly string[];
}): Promise<{ manifest: RecoveryPointManifest; acceptance: RecoveryPointAcceptance }> {
  const manifest = verifyRecoveryPointManifest(params.manifest);
  const requiredComponentIds = normalizeRequiredComponentIds(params.expectedAgentIds);
  if (!isDeepStrictEqual(manifest.inventory.requiredComponentIds, requiredComponentIds)) {
    throw new Error("Recovery point inventory does not match the state owner's expected agents.");
  }
  const actualComponents = await Promise.all(params.snapshots.map(buildVerifiedComponent));
  actualComponents.sort(compareComponents);
  assertRequiredSqliteInventory(actualComponents, requiredComponentIds);
  if (!isDeepStrictEqual(actualComponents, manifest.components)) {
    throw new Error("Recovery point SQLite components do not match the verified owner snapshots.");
  }
  return { manifest, acceptance: createRecoveryPointAcceptance(manifest) };
}

export function createRecoveryPointAcceptance(value: unknown): RecoveryPointAcceptance {
  const manifest = verifyRecoveryPointManifest(value);
  const manifestBytes = Buffer.from(stableStringify(manifest), "utf8");
  const acceptanceWithoutId = {
    version: RECOVERY_POINT_ACCEPTANCE_VERSION,
    recoveryPointId: manifest.recoveryPointId,
    aggregateManifestSha256: sha256Hex(manifestBytes),
    aggregateManifestSizeBytes: manifestBytes.byteLength,
    components: manifest.components.map((component) => ({
      componentId: component.id,
      ownerManifestSha256: component.ownerManifestSha256,
      ownerManifestSizeBytes: component.ownerManifestSizeBytes,
      artifactSha256: component.artifactSha256,
      artifactSizeBytes: component.artifactSizeBytes,
    })),
  };
  return recoveryPointAcceptanceSchema.parse({
    ...acceptanceWithoutId,
    acceptanceSetId: sha256Hex(stableStringify(acceptanceWithoutId)),
  });
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
    !isDeepStrictEqual(secondManifestRead.parsed, secondVerification.manifest) ||
    firstManifestRead.sha256 !== secondManifestRead.sha256
  ) {
    throw new Error(
      `SQLite owner manifest changed during recovery-point composition: ${snapshot.ref.path}`,
    );
  }
  return componentFromSnapshotManifest(
    secondVerification.manifest,
    secondManifestRead.sha256,
    secondManifestRead.sizeBytes,
  );
}

async function readOwnerManifest(
  ref: SnapshotRef,
): Promise<{ parsed: unknown; sha256: string; sizeBytes: number }> {
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
      sizeBytes: manifestRead.buffer.byteLength,
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
  ownerManifestSizeBytes: number,
): RecoveryPointComponent {
  const common = {
    artifactSha256: manifest.artifact.sha256,
    artifactSizeBytes: manifest.artifact.sizeBytes,
    ownerManifestSha256,
    ownerManifestSizeBytes,
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
  assertSupportedObligations(normalized);
  return normalized;
}

function normalizeRequiredComponentIds(expectedAgentIds: readonly string[]): string[] {
  if (expectedAgentIds.length === 0) {
    throw new Error("Recovery point V1 requires at least one expected agent.");
  }
  const normalizedAgentIds = expectedAgentIds.map((agentId) => normalizeAgentId(agentId));
  for (let index = 0; index < expectedAgentIds.length; index += 1) {
    if (
      !isValidAgentId(expectedAgentIds[index] ?? "") ||
      normalizedAgentIds[index] !== expectedAgentIds[index]
    ) {
      throw new Error(`Recovery point expected agent id is invalid: ${expectedAgentIds[index]}.`);
    }
  }
  const uniqueAgentIds = new Set(normalizedAgentIds);
  if (uniqueAgentIds.size !== normalizedAgentIds.length) {
    throw new Error("Recovery point expected agent inventory contains duplicates.");
  }
  return [
    "sqlite/global",
    ...normalizedAgentIds.toSorted(compareCodeUnits).map((agentId) => `sqlite/agent/${agentId}`),
  ];
}

function assertCanonicalRequiredInventory(requiredComponentIds: readonly string[]): void {
  const agentIds = requiredComponentIds.map((componentId, index) => {
    if (index === 0 && componentId === "sqlite/global") {
      return undefined;
    }
    return componentId.startsWith("sqlite/agent/")
      ? componentId.slice("sqlite/agent/".length)
      : null;
  });
  if (agentIds.some((agentId) => agentId === null)) {
    throw new Error("Recovery point required-component inventory is invalid.");
  }
  const expected = normalizeRequiredComponentIds(
    agentIds.filter((agentId): agentId is string => agentId !== undefined),
  );
  if (!isDeepStrictEqual(requiredComponentIds, expected)) {
    throw new Error("Recovery point required-component inventory is not canonical.");
  }
}

function assertRequiredSqliteInventory(
  components: readonly RecoveryPointComponent[],
  requiredComponentIds: readonly string[],
): void {
  const ids = new Set<string>();
  for (const component of components) {
    if (ids.has(component.id)) {
      throw new Error(`Recovery point contains duplicate component id: ${component.id}.`);
    }
    ids.add(component.id);
  }
  const componentIds = components.map((component) => component.id);
  if (!isDeepStrictEqual(componentIds, requiredComponentIds)) {
    throw new Error("Recovery point SQLite components do not match the required inventory.");
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
    if (!isDeepStrictEqual(component.dependsOn, component.dependsOn.toSorted(compareCodeUnits))) {
      throw new Error(
        `Recovery point component ${component.id} dependencies are not in canonical order.`,
      );
    }
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

function assertSupportedObligations(obligations: {
  external: readonly RecoveryPointObligation[];
  reconstructed: readonly RecoveryPointObligation[];
  ephemeral: readonly RecoveryPointObligation[];
}): void {
  const supported = new Set([
    "external:secret-ref:secrets",
    "external:plugin-dependency:plugins",
    "reconstructed:plugin-dependency:plugins",
    "ephemeral:runtime-cache:openclaw-runtime",
  ]);
  const treatments = [
    ["external", obligations.external],
    ["reconstructed", obligations.reconstructed],
    ["ephemeral", obligations.ephemeral],
  ] as const;
  for (const [treatment, entries] of treatments) {
    for (const obligation of entries) {
      if (!supported.has(`${treatment}:${obligation.kind}:${obligation.owner}`)) {
        throw new Error(
          `Recovery point obligation ${obligation.id} has unsupported treatment, kind, or owner.`,
        );
      }
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
