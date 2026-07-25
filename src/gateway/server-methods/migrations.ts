// Gateway handlers expose reviewed, memory-only migration plans to trusted operators.
import crypto from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  type MemoryMigrationItem,
  type MemoryMigrationProviderPlan,
  type MigrationsMemoryApplyResult,
  type MigrationsMemoryPlanResult,
  validateMigrationsMemoryApplyParams,
  validateMigrationsMemoryPlanParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { stableStringify } from "../../agents/stable-stringify.js";
import {
  applyProviderMemoryImport,
  listMemoryMigrationProviders,
  planProviderMemoryImport,
} from "../../commands/migrate/memory-import.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { summarizeMigrationItems } from "../../plugin-sdk/migration.js";
import type { MigrationItem, MigrationPlan, MigrationProviderPlugin } from "../../plugins/types.js";
import { isValidAgentId, normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

const MEMORY_APPLY_DEDUPE_PREFIX = "migrations.memory.apply:";
const activeApplies = new Set<string>();

function emptySummary() {
  return summarizeMigrationItems([]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type CachedMemoryApply = {
  requestFingerprint: string;
  result: MigrationsMemoryApplyResult;
};

type MemoryApplyOutcome =
  | { ok: true; result: MigrationsMemoryApplyResult }
  | { ok: false; error: ReturnType<typeof errorShape> };

type InFlightMemoryApply = {
  requestFingerprint: string;
  completion: Promise<MemoryApplyOutcome>;
};

const inFlightMemoryApplies = new WeakMap<object, Map<string, InFlightMemoryApply>>();

function memoryApplyInflightMap(dedupe: object): Map<string, InFlightMemoryApply> {
  let active = inFlightMemoryApplies.get(dedupe);
  if (!active) {
    active = new Map();
    inFlightMemoryApplies.set(dedupe, active);
  }
  return active;
}

function memoryApplyRequestFingerprint(params: {
  agentId: string;
  providerId: string;
  planFingerprint: string;
  itemIds: string[];
  overwrite?: boolean;
}): string {
  return stableStringify({
    agentId: params.agentId,
    providerId: params.providerId,
    planFingerprint: params.planFingerprint,
    itemIds: params.itemIds,
    overwrite: params.overwrite === true,
  });
}

function isCachedMemoryApply(value: unknown): value is CachedMemoryApply {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CachedMemoryApply>;
  return typeof candidate.requestFingerprint === "string" && candidate.result !== undefined;
}

function toWireItem(item: MigrationItem): MemoryMigrationItem {
  return {
    id: item.id,
    status: item.status,
    ...(item.source ? { source: item.source } : {}),
    ...(item.target ? { target: item.target } : {}),
    ...(item.message !== undefined ? { message: item.message } : {}),
    ...(item.reason !== undefined ? { reason: item.reason } : {}),
    ...(item.details !== undefined ? { details: item.details } : {}),
  };
}

function fingerprintMemoryPlan(params: {
  agentId: string;
  workspace: string;
  providerId: string;
  overwrite?: boolean;
  plan: MigrationPlan;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      stableStringify({
        version: 3,
        agentId: params.agentId,
        workspace: params.workspace,
        providerId: params.providerId,
        overwrite: params.overwrite === true,
        // Apply receives the full plan, so every provider-visible field must bind to the review.
        plan: params.plan,
      }),
    )
    .digest("hex");
}

function targetAgentOrRespond(
  rawAgentId: string,
  config: OpenClawConfig,
  respond: RespondFn,
): string | undefined {
  if (!isValidAgentId(rawAgentId)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid agent id"));
    return undefined;
  }
  const agentId = normalizeAgentId(rawAgentId);
  if (!new Set(listAgentIds(config)).has(agentId)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agent id"));
    return undefined;
  }
  return agentId;
}

async function planMemoryProvider(params: {
  provider: MigrationProviderPlugin;
  config: OpenClawConfig;
  agentId: string;
  overwrite?: boolean;
}): Promise<MemoryMigrationProviderPlan> {
  const base = {
    providerId: params.provider.id,
    label: params.provider.label,
    ...(params.provider.description ? { description: params.provider.description } : {}),
  };
  try {
    const { detection, plan } = await planProviderMemoryImport({
      provider: params.provider,
      config: params.config,
      agentId: params.agentId,
      overwrite: params.overwrite,
    });
    if (detection && !detection.found) {
      return {
        ...base,
        found: false,
        ...(detection.source ? { source: detection.source } : {}),
        ...(detection.confidence ? { confidence: detection.confidence } : {}),
        ...(detection.message ? { message: detection.message } : {}),
        summary: emptySummary(),
        items: [],
      };
    }
    const found = plan.items.length > 0;
    const workspace = resolveAgentWorkspaceDir(params.config, params.agentId);
    return {
      ...base,
      found,
      planFingerprint: fingerprintMemoryPlan({
        agentId: params.agentId,
        workspace,
        providerId: params.provider.id,
        overwrite: params.overwrite,
        plan,
      }),
      source: plan.source,
      ...(plan.target ? { target: plan.target } : {}),
      ...(detection?.confidence ? { confidence: detection.confidence } : {}),
      ...(detection?.message ? { message: detection.message } : {}),
      summary: plan.summary,
      items: plan.items.map(toWireItem),
      ...(plan.warnings?.length ? { warnings: plan.warnings } : {}),
    };
  } catch (error) {
    return {
      ...base,
      found: false,
      error: errorMessage(error),
      summary: emptySummary(),
      items: [],
    };
  }
}

function findMemoryProvider(
  providers: readonly MigrationProviderPlugin[],
  providerId: string,
): MigrationProviderPlugin | undefined {
  return providers.find((provider) => provider.id === providerId);
}

export const migrationsHandlers: GatewayRequestHandlers = {
  "migrations.memory.plan": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateMigrationsMemoryPlanParams,
        "migrations.memory.plan",
        respond,
      )
    ) {
      return;
    }
    const config = context.getRuntimeConfig();
    const agentId = targetAgentOrRespond(params.agentId, config, respond);
    if (!agentId) {
      return;
    }
    const providers = listMemoryMigrationProviders(config);
    const planned = await Promise.all(
      providers.map(
        async (provider) =>
          await planMemoryProvider({
            provider,
            config,
            agentId,
            overwrite: params.overwrite,
          }),
      ),
    );
    const result: MigrationsMemoryPlanResult = {
      agentId,
      workspace: resolveAgentWorkspaceDir(config, agentId),
      providers: planned,
    };
    respond(true, result, undefined);
  },

  "migrations.memory.apply": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateMigrationsMemoryApplyParams,
        "migrations.memory.apply",
        respond,
      )
    ) {
      return;
    }
    const config = context.getRuntimeConfig();
    const agentId = targetAgentOrRespond(params.agentId, config, respond);
    if (!agentId) {
      return;
    }
    const requestFingerprint = memoryApplyRequestFingerprint({
      agentId,
      providerId: params.providerId,
      planFingerprint: params.planFingerprint,
      itemIds: params.itemIds,
      overwrite: params.overwrite,
    });
    const dedupeKey = `${MEMORY_APPLY_DEDUPE_PREFIX}${params.idempotencyKey}`;
    const cached = context.dedupe.get(dedupeKey);
    if (cached && isCachedMemoryApply(cached.payload)) {
      if (cached.payload.requestFingerprint !== requestFingerprint) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "memory import idempotency key was reused"),
        );
        return;
      }
      respond(true, cached.payload.result, undefined, { cached: true });
      return;
    }
    const provider = findMemoryProvider(listMemoryMigrationProviders(config), params.providerId);
    if (!provider) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "unknown memory migration provider"),
      );
      return;
    }
    const inFlightMap = memoryApplyInflightMap(context.dedupe);
    const inFlight = inFlightMap.get(dedupeKey);
    if (inFlight) {
      if (inFlight.requestFingerprint !== requestFingerprint) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "memory import idempotency key was reused"),
        );
        return;
      }
      const outcome = await inFlight.completion;
      if (outcome.ok) {
        respond(true, outcome.result, undefined, { cached: true });
      } else {
        respond(false, undefined, outcome.error, { cached: true });
      }
      return;
    }
    let settle!: (outcome: MemoryApplyOutcome) => void;
    const completion = new Promise<MemoryApplyOutcome>((resolve) => {
      settle = resolve;
    });
    // Reserve before awaited planning/apply work. Success moves to the gateway dedupe cache;
    // failure releases the key so the same frozen request can be retried.
    inFlightMap.set(dedupeKey, { requestFingerprint, completion });
    const complete = (outcome: MemoryApplyOutcome) => {
      settle(outcome);
      if (outcome.ok) {
        respond(true, outcome.result, undefined);
      } else {
        respond(false, undefined, outcome.error);
      }
    };
    const applyKey = `${agentId}:${provider.id}`;
    if (activeApplies.has(applyKey)) {
      complete({
        ok: false,
        error: errorShape(ErrorCodes.UNAVAILABLE, "memory import already running", {
          retryable: true,
          retryAfterMs: 1000,
        }),
      });
      inFlightMap.delete(dedupeKey);
      return;
    }
    activeApplies.add(applyKey);
    try {
      const { plan } = await planProviderMemoryImport({
        provider,
        config,
        agentId,
        overwrite: params.overwrite,
      });
      const currentFingerprint = fingerprintMemoryPlan({
        agentId,
        workspace: resolveAgentWorkspaceDir(config, agentId),
        providerId: provider.id,
        overwrite: params.overwrite,
        plan,
      });
      if (currentFingerprint !== params.planFingerprint) {
        complete({
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            "memory migration plan changed; refresh the plan before importing",
          ),
        });
        return;
      }
      const selectable = new Map(
        plan.items
          .filter((item) => item.status === "planned" || item.status === "conflict")
          .map((item) => [item.id, item]),
      );
      const unavailable = params.itemIds.filter((id) => !selectable.has(id));
      if (unavailable.length > 0) {
        complete({
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `memory migration items changed; refresh the plan (${unavailable.join(", ")})`,
          ),
        });
        return;
      }
      const selectedConflicts = params.itemIds.filter(
        (id) => selectable.get(id)?.status === "conflict",
      );
      if (!params.overwrite && selectedConflicts.length > 0) {
        complete({
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            "selected memory was already imported; enable replacement and refresh the plan",
          ),
        });
        return;
      }
      const applied = await applyProviderMemoryImport({
        provider,
        config,
        agentId,
        itemIds: params.itemIds,
        overwrite: params.overwrite,
        preflightPlan: plan,
      });
      const result: MigrationsMemoryApplyResult = {
        providerId: applied.providerId,
        source: applied.source,
        ...(applied.target ? { target: applied.target } : {}),
        summary: applied.summary,
        items: applied.items.map(toWireItem),
        ...(applied.warnings?.length ? { warnings: applied.warnings } : {}),
        ...(applied.backupPath ? { backupPath: applied.backupPath } : {}),
        ...(applied.reportDir ? { reportDir: applied.reportDir } : {}),
      };
      context.dedupe.set(dedupeKey, {
        ts: Date.now(),
        ok: true,
        payload: { requestFingerprint, result } satisfies CachedMemoryApply,
      });
      complete({ ok: true, result });
    } catch (error) {
      complete({
        ok: false,
        error: errorShape(ErrorCodes.UNAVAILABLE, errorMessage(error)),
      });
    } finally {
      activeApplies.delete(applyKey);
      inFlightMap.delete(dedupeKey);
    }
  },
};
