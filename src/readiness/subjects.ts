import { randomUUID } from "node:crypto";
import { getOpenClawProcessInstanceId } from "../infra/process-instance-id.js";
import type { OpenClawPluginReadinessSubjectCollector } from "../plugins/plugin-registration.types.js";

export const CORE_READINESS_SUBJECT_REFS = {
  process: "openclaw/process/current",
  gateway: "openclaw/gateway/current",
  config: "openclaw/config/active",
  plugins: "openclaw/plugins/active",
  workspace: "openclaw/workspace/default",
} as const;
const OPENCLAW_INSTANCE_ID_ENV = "OPENCLAW_INSTANCE_ID";

const SUBJECT_REF_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,191}$/;
const SUBJECT_KIND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PLUGIN_SUBJECT_PART_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SUBJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_SUBJECTS = 128;
const MAX_PLUGIN_SUBJECTS = 64;
const MAX_RELATED_SUBJECTS = 16;

export type ReadinessSubject = {
  ref: string;
  kind: string;
  id?: string;
  generation?: string;
  parentRef?: string;
};

export type ReadinessIdentity = {
  producerRef: string;
  subjects: ReadinessSubject[];
};

type ReadinessSubjectReference = {
  subjectRef: string;
  relatedSubjectRefs?: string[];
};

type PluginReadinessSubjectCollector = OpenClawPluginReadinessSubjectCollector;

type PluginSubjectCollection = {
  collector: PluginReadinessSubjectCollector;
  defaultRef: string;
  subjects: ReadinessSubject[];
  validateReferences: (subjectRef: string, relatedSubjectRefs?: string[]) => boolean;
};

export class InvalidReadinessSubjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReadinessSubjectError";
  }
}

function normalizePluginSubjectPart(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return PLUGIN_SUBJECT_PART_PATTERN.test(normalized) ? normalized : undefined;
}

function isValidOpaqueIdentity(value: string | undefined): boolean {
  return value === undefined || SUBJECT_ID_PATTERN.test(value);
}

function mergeCompatibleSubjects(
  left: ReadinessSubject,
  right: ReadinessSubject,
): ReadinessSubject | undefined {
  if (left.ref !== right.ref || left.kind !== right.kind) {
    return undefined;
  }
  for (const field of ["id", "generation", "parentRef"] as const) {
    if (left[field] !== undefined && right[field] !== undefined && left[field] !== right[field]) {
      return undefined;
    }
  }
  return {
    ref: left.ref,
    kind: left.kind,
    ...mergeOptionalSubjectField("id", left.id, right.id),
    ...mergeOptionalSubjectField("generation", left.generation, right.generation),
    ...mergeOptionalSubjectField("parentRef", left.parentRef, right.parentRef),
  };
}

function mergeOptionalSubjectField<K extends "id" | "generation" | "parentRef">(
  field: K,
  left: string | undefined,
  right: string | undefined,
): Partial<Pick<ReadinessSubject, K>> {
  const value = left ?? right;
  return value === undefined ? {} : ({ [field]: value } as Pick<ReadinessSubject, K>);
}

function assertValidSubject(subject: ReadinessSubject): void {
  if (!SUBJECT_REF_PATTERN.test(subject.ref) || !SUBJECT_KIND_PATTERN.test(subject.kind)) {
    throw new Error("invalid readiness subject name");
  }
  if (!isValidOpaqueIdentity(subject.id) || !isValidOpaqueIdentity(subject.generation)) {
    throw new Error("invalid readiness subject identity");
  }
  if (subject.parentRef !== undefined && !SUBJECT_REF_PATTERN.test(subject.parentRef)) {
    throw new Error("invalid readiness subject parent");
  }
}

function createCoreSubjects(gatewayInstanceId?: string): ReadinessSubject[] {
  return [
    {
      ref: CORE_READINESS_SUBJECT_REFS.process,
      kind: "openclaw.process",
      id: getOpenClawProcessInstanceId(),
    },
    {
      ref: CORE_READINESS_SUBJECT_REFS.gateway,
      kind: "openclaw.gateway",
      ...(gatewayInstanceId ? { id: gatewayInstanceId } : {}),
      parentRef: CORE_READINESS_SUBJECT_REFS.process,
    },
    { ref: CORE_READINESS_SUBJECT_REFS.config, kind: "openclaw.config" },
    { ref: CORE_READINESS_SUBJECT_REFS.plugins, kind: "openclaw.plugins" },
    { ref: CORE_READINESS_SUBJECT_REFS.workspace, kind: "openclaw.workspace" },
  ];
}

export function createGatewayReadinessIdentity(params?: {
  instanceId?: string;
  createInstanceId?: () => string;
  env?: NodeJS.ProcessEnv;
}): ReadinessIdentity {
  const supplied = params?.instanceId ?? (params?.env ?? process.env)[OPENCLAW_INSTANCE_ID_ENV];
  const instanceId = supplied?.trim() || (params?.createInstanceId ?? randomUUID)();
  if (!isValidOpaqueIdentity(instanceId)) {
    throw new Error("invalid Gateway readiness instance identity");
  }
  return {
    producerRef: CORE_READINESS_SUBJECT_REFS.gateway,
    subjects: createCoreSubjects(instanceId),
  };
}

export function createProcessReadinessIdentity(): ReadinessIdentity {
  return {
    producerRef: CORE_READINESS_SUBJECT_REFS.process,
    subjects: createCoreSubjects(),
  };
}

export function createPluginReadinessSubjectCollection(params: {
  pluginId: string;
  criterionId: string;
}): PluginSubjectCollection {
  const pluginId = normalizePluginSubjectPart(params.pluginId);
  const criterionId = normalizePluginSubjectPart(params.criterionId);
  if (!pluginId || !criterionId) {
    throw new InvalidReadinessSubjectError("invalid plugin readiness subject owner");
  }
  const prefix = `plugin.${pluginId}/`;
  const defaultRef = `${prefix}criterion/${criterionId}`;
  const subjects = new Map<string, ReadinessSubject>();
  subjects.set(defaultRef, {
    ref: defaultRef,
    kind: `plugin.${pluginId}.criterion`,
    id: criterionId,
  });

  return {
    defaultRef,
    collector: {
      declare(input) {
        const kind = normalizePluginSubjectPart(input.kind);
        const key = normalizePluginSubjectPart(input.key);
        if (!kind || !key) {
          throw new InvalidReadinessSubjectError("invalid plugin readiness subject name");
        }
        if (
          !isValidOpaqueIdentity(input.identity?.id) ||
          !isValidOpaqueIdentity(input.identity?.generation)
        ) {
          throw new InvalidReadinessSubjectError("invalid plugin readiness subject identity");
        }
        const ref = `${prefix}${kind}/${key}`;
        if (
          input.parentRef &&
          !input.parentRef.startsWith(prefix) &&
          !Object.values(CORE_READINESS_SUBJECT_REFS).includes(
            input.parentRef as (typeof CORE_READINESS_SUBJECT_REFS)[keyof typeof CORE_READINESS_SUBJECT_REFS],
          )
        ) {
          throw new InvalidReadinessSubjectError("invalid plugin readiness subject parent");
        }
        if (input.parentRef?.startsWith(prefix) && !subjects.has(input.parentRef)) {
          throw new InvalidReadinessSubjectError("unresolved plugin readiness subject parent");
        }
        const subject: ReadinessSubject = {
          ref,
          kind: `plugin.${pluginId}.${kind}`,
          ...(input.identity?.id ? { id: input.identity.id } : {}),
          ...(input.identity?.generation ? { generation: input.identity.generation } : {}),
          ...(input.parentRef ? { parentRef: input.parentRef } : {}),
        };
        assertValidSubject(subject);
        const existing = subjects.get(ref);
        if (!existing && subjects.size > MAX_PLUGIN_SUBJECTS) {
          throw new InvalidReadinessSubjectError("plugin readiness subject limit exceeded");
        }
        const merged = existing ? mergeCompatibleSubjects(existing, subject) : subject;
        if (!merged) {
          throw new InvalidReadinessSubjectError(
            "conflicting plugin readiness subject declaration",
          );
        }
        subjects.set(ref, merged);
        return ref;
      },
    },
    get subjects() {
      return Array.from(subjects.values());
    },
    validateReferences(subjectRef, relatedSubjectRefs = []) {
      if (relatedSubjectRefs.length > MAX_RELATED_SUBJECTS) {
        return false;
      }
      const references = [subjectRef, ...relatedSubjectRefs];
      return references.every(
        (ref) =>
          subjects.has(ref) ||
          Object.values(CORE_READINESS_SUBJECT_REFS).includes(
            ref as (typeof CORE_READINESS_SUBJECT_REFS)[keyof typeof CORE_READINESS_SUBJECT_REFS],
          ),
      );
    },
  };
}

function assertNoParentCycles(subjects: Map<string, ReadinessSubject>): void {
  for (const subject of subjects.values()) {
    const seen = new Set<string>([subject.ref]);
    let parentRef = subject.parentRef;
    while (parentRef) {
      if (!subjects.has(parentRef)) {
        throw new Error("unresolved readiness subject parent");
      }
      if (seen.has(parentRef)) {
        throw new Error("readiness subject parent cycle");
      }
      seen.add(parentRef);
      parentRef = subjects.get(parentRef)?.parentRef;
    }
  }
}

export function reconcileReadinessIdentity(params: {
  base: ReadinessIdentity;
  subjects?: readonly ReadinessSubject[];
  references: readonly ReadinessSubjectReference[];
}): ReadinessIdentity {
  const subjects = new Map<string, ReadinessSubject>();
  for (const subject of [...params.base.subjects, ...(params.subjects ?? [])]) {
    assertValidSubject(subject);
    const existing = subjects.get(subject.ref);
    const merged = existing ? mergeCompatibleSubjects(existing, subject) : subject;
    if (!merged) {
      throw new Error("conflicting readiness subject declaration");
    }
    subjects.set(subject.ref, merged);
  }
  if (subjects.size > MAX_SUBJECTS || !subjects.has(params.base.producerRef)) {
    throw new Error("invalid readiness identity package");
  }
  assertNoParentCycles(subjects);
  const retained = new Set<string>([params.base.producerRef]);
  for (const reference of params.references) {
    const related = Array.from(new Set(reference.relatedSubjectRefs ?? [])).toSorted();
    if (related.length > MAX_RELATED_SUBJECTS) {
      throw new Error("readiness related subject limit exceeded");
    }
    for (const ref of [reference.subjectRef, ...related]) {
      if (!subjects.has(ref)) {
        throw new Error("unresolved readiness subject reference");
      }
      retained.add(ref);
    }
  }
  for (const ref of Array.from(retained)) {
    let parentRef = subjects.get(ref)?.parentRef;
    while (parentRef) {
      if (!subjects.has(parentRef)) {
        throw new Error("unresolved readiness subject parent");
      }
      retained.add(parentRef);
      parentRef = subjects.get(parentRef)?.parentRef;
    }
  }
  return {
    producerRef: params.base.producerRef,
    subjects: Array.from(retained, (ref) => subjects.get(ref) as ReadinessSubject).toSorted(
      (a, b) => a.ref.localeCompare(b.ref),
    ),
  };
}

export function normalizeRelatedSubjectRefs(
  refs: readonly string[] | undefined,
): string[] | undefined {
  if (!refs || refs.length === 0) {
    return undefined;
  }
  return Array.from(new Set(refs)).toSorted();
}
