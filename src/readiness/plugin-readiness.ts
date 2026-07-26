import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginReadinessCriterionRegistration,
  PluginRegistry,
} from "../plugins/registry-types.js";
import type { ReadinessCondition, ReadinessContribution } from "./conditions.js";
import { READINESS_REASON_PATTERN, sanitizeProviderReadinessMessage } from "./sanitize.js";
import {
  CORE_READINESS_SUBJECT_REFS,
  createPluginReadinessSubjectCollection,
  InvalidReadinessSubjectError,
  normalizeRelatedSubjectRefs,
  type ReadinessSubject,
} from "./subjects.js";

const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_CACHE_TTL_MS = 5_000;

type CachedEvaluation = {
  expiresAt: number;
  value: Promise<PluginReadinessEvaluation>;
  rawPending: boolean;
};

type PluginReadinessEvaluation = {
  condition: ReadinessCondition;
  subjects: ReadinessSubject[];
};

function defaultSubjects(
  subjectCollection: ReturnType<typeof createPluginReadinessSubjectCollection>,
): ReadinessSubject[] {
  return subjectCollection.subjects.filter(
    (subject) => subject.ref === subjectCollection.defaultRef,
  );
}

function unavailableCondition(
  registration: PluginReadinessCriterionRegistration,
  reason: string,
  message: string,
  subjectRef: string,
): ReadinessCondition {
  return {
    type: registration.id,
    subjectRef,
    status: "Unknown",
    requirement: "advisory",
    reason,
    message,
  };
}

async function evaluateRegistration(params: {
  registration: PluginReadinessCriterionRegistration;
  raw: Promise<Awaited<ReturnType<PluginReadinessCriterionRegistration["criterion"]["check"]>>>;
  controller: AbortController;
  timeoutMs: number;
  subjectCollection: ReturnType<typeof createPluginReadinessSubjectCollection>;
}): Promise<PluginReadinessEvaluation> {
  const { registration } = params;
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    const result = await Promise.race([
      params.raw,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          params.controller.abort();
          reject(new Error("readiness criterion timed out"));
        }, params.timeoutMs);
        timeout.unref?.();
      }),
    ]);
    if (
      !result ||
      !["True", "False", "Unknown"].includes(result.status) ||
      typeof result.reason !== "string" ||
      !READINESS_REASON_PATTERN.test(result.reason) ||
      typeof result.message !== "string" ||
      !sanitizeProviderReadinessMessage(result.message)
    ) {
      return {
        condition: unavailableCondition(
          registration,
          "CriterionInvalidResult",
          `Readiness criterion ${registration.id} returned an invalid result.`,
          params.subjectCollection.defaultRef,
        ),
        subjects: defaultSubjects(params.subjectCollection),
      };
    }
    const message = sanitizeProviderReadinessMessage(result.message);
    if (!message) {
      return {
        condition: unavailableCondition(
          registration,
          "CriterionInvalidResult",
          `Readiness criterion ${registration.id} returned an invalid result.`,
          params.subjectCollection.defaultRef,
        ),
        subjects: defaultSubjects(params.subjectCollection),
      };
    }
    const subjectRef = result.subjectRef ?? params.subjectCollection.defaultRef;
    const relatedSubjectRefs = normalizeRelatedSubjectRefs(result.relatedSubjectRefs);
    const observedAtMs = result.observedAtMs;
    if (
      !params.subjectCollection.validateReferences(subjectRef, relatedSubjectRefs) ||
      (observedAtMs !== undefined && (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0))
    ) {
      return {
        condition: unavailableCondition(
          registration,
          "CriterionInvalidResult",
          `Readiness criterion ${registration.id} returned an invalid result.`,
          params.subjectCollection.defaultRef,
        ),
        subjects: defaultSubjects(params.subjectCollection),
      };
    }
    return {
      condition: {
        type: registration.id,
        subjectRef,
        ...(relatedSubjectRefs ? { relatedSubjectRefs } : {}),
        ...(observedAtMs !== undefined ? { observedAtMs } : {}),
        status: result.status,
        requirement: "advisory",
        reason: result.reason,
        message,
      },
      subjects: params.subjectCollection.subjects,
    };
  } catch (error) {
    const invalid = error instanceof InvalidReadinessSubjectError;
    return {
      condition: unavailableCondition(
        registration,
        invalid
          ? "CriterionInvalidResult"
          : timedOut
            ? "CriterionTimedOut"
            : "CriterionCheckFailed",
        invalid
          ? `Readiness criterion ${registration.id} returned an invalid result.`
          : timedOut
            ? `Readiness criterion ${registration.id} exceeded ${params.timeoutMs}ms.`
            : `Readiness criterion ${registration.id} could not be evaluated.`,
        params.subjectCollection.defaultRef,
      ),
      subjects: defaultSubjects(params.subjectCollection),
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export function createPluginReadinessResolver(options?: {
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
}) {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options?.now ?? Date.now;
  let cache = new WeakMap<PluginReadinessCriterionRegistration, CachedEvaluation>();
  let activeRegistry: Pick<PluginRegistry, "readinessCriteria"> | undefined;
  let activeConfig: OpenClawConfig | undefined;
  const activeControllers = new Set<AbortController>();
  const pendingByCriterionId = new Map<string, CachedEvaluation>();

  return async (params: {
    registry: Pick<PluginRegistry, "readinessCriteria">;
    config: OpenClawConfig;
    criterionIds?: ReadonlySet<string>;
  }): Promise<ReadinessContribution> => {
    if (params.registry !== activeRegistry || params.config !== activeConfig) {
      for (const controller of activeControllers) {
        controller.abort();
      }
      activeControllers.clear();
      cache = new WeakMap();
      activeRegistry = params.registry;
      activeConfig = params.config;
    }
    const registrations = params.criterionIds
      ? params.registry.readinessCriteria.filter((registration) =>
          params.criterionIds?.has(registration.id),
        )
      : params.registry.readinessCriteria;
    const evaluated = registrations.map((registration) => {
      const cached = cache.get(registration);
      const currentTime = now();
      if (cached && cached.expiresAt > currentTime) {
        return cached.value;
      }
      if (cached?.rawPending) {
        return cached.value;
      }
      const pending = pendingByCriterionId.get(registration.id);
      if (pending?.rawPending) {
        return pending.value;
      }
      const controller = new AbortController();
      activeControllers.add(controller);
      let subjectCollection: ReturnType<typeof createPluginReadinessSubjectCollection>;
      try {
        subjectCollection = createPluginReadinessSubjectCollection({
          pluginId: registration.pluginId,
          criterionId: registration.criterion.id,
        });
      } catch {
        activeControllers.delete(controller);
        return Promise.resolve({
          condition: unavailableCondition(
            registration,
            "CriterionInvalidResult",
            `Readiness criterion ${registration.id} has invalid registration metadata.`,
            CORE_READINESS_SUBJECT_REFS.plugins,
          ),
          subjects: [],
        });
      }
      const raw = Promise.resolve().then(() =>
        registration.criterion.check({
          config: params.config,
          pluginConfig: registration.pluginConfig,
          signal: controller.signal,
          subjects: subjectCollection.collector,
        }),
      );
      const value = evaluateRegistration({
        registration,
        raw,
        controller,
        timeoutMs,
        subjectCollection,
      });
      const entry: CachedEvaluation = {
        expiresAt: currentTime + cacheTtlMs,
        value,
        rawPending: true,
      };
      cache.set(registration, entry);
      pendingByCriterionId.set(registration.id, entry);
      void raw.then(
        () => {
          entry.rawPending = false;
          activeControllers.delete(controller);
          if (pendingByCriterionId.get(registration.id) === entry) {
            pendingByCriterionId.delete(registration.id);
          }
        },
        () => {
          entry.rawPending = false;
          activeControllers.delete(controller);
          if (pendingByCriterionId.get(registration.id) === entry) {
            pendingByCriterionId.delete(registration.id);
          }
        },
      );
      return value;
    });
    const evaluations = await Promise.all(evaluated);
    return {
      conditions: evaluations.map((entry) => entry.condition),
      subjects: evaluations.flatMap((entry) => entry.subjects),
    };
  };
}
