import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginReadinessCriterionRegistration,
  PluginRegistry,
} from "../plugins/registry-types.js";
import type { ReadinessCondition } from "./conditions.js";

const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_CACHE_TTL_MS = 5_000;

export type PluginReadinessProviderDescriptor = {
  id: string;
  pluginId: string;
  pluginName?: string;
  description: string;
};

export function listPluginReadinessProviders(
  registry: Pick<PluginRegistry, "readinessCriteria">,
): PluginReadinessProviderDescriptor[] {
  return registry.readinessCriteria.map((registration) => ({
    id: registration.id,
    pluginId: registration.pluginId,
    ...(registration.pluginName ? { pluginName: registration.pluginName } : {}),
    description: registration.criterion.description,
  }));
}

type CachedEvaluation = {
  expiresAt: number;
  value: Promise<ReadinessCondition>;
  rawPending: boolean;
};

function unavailableCondition(
  registration: PluginReadinessCriterionRegistration,
  reason: string,
  message: string,
): ReadinessCondition {
  return {
    type: registration.id,
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
}): Promise<ReadinessCondition> {
  const { registration } = params;
  let timeout: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      params.raw,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
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
      !result.reason.trim() ||
      typeof result.message !== "string" ||
      !result.message.trim()
    ) {
      return unavailableCondition(
        registration,
        "CriterionInvalidResult",
        `Readiness criterion ${registration.id} returned an invalid result.`,
      );
    }
    return {
      type: registration.id,
      status: result.status,
      requirement: "advisory",
      reason: result.reason,
      message: result.message,
    };
  } catch {
    const timedOut = params.controller.signal.aborted;
    return unavailableCondition(
      registration,
      timedOut ? "CriterionTimedOut" : "CriterionCheckFailed",
      timedOut
        ? `Readiness criterion ${registration.id} exceeded ${params.timeoutMs}ms.`
        : `Readiness criterion ${registration.id} could not be evaluated.`,
    );
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
  const cache = new WeakMap<PluginReadinessCriterionRegistration, CachedEvaluation>();

  return async (params: {
    registry: Pick<PluginRegistry, "readinessCriteria">;
    config: OpenClawConfig;
    criterionIds?: ReadonlySet<string>;
  }): Promise<ReadinessCondition[]> => {
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
      const controller = new AbortController();
      const raw = Promise.resolve().then(() =>
        registration.criterion.check({
          config: params.config,
          pluginConfig: registration.pluginConfig,
          signal: controller.signal,
        }),
      );
      const value = evaluateRegistration({ registration, raw, controller, timeoutMs });
      const entry: CachedEvaluation = {
        expiresAt: currentTime + cacheTtlMs,
        value,
        rawPending: true,
      };
      cache.set(registration, entry);
      void raw.then(
        () => {
          entry.rawPending = false;
        },
        () => {
          entry.rawPending = false;
        },
      );
      return value;
    });
    return Promise.all(evaluated);
  };
}
