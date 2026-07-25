// Setup migration finalization owns deferred activation, reporting, and terminal acknowledgement.
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { writeMigrationReport } from "../plugin-sdk/migration-runtime.js";
import { summarizeMigrationItems } from "../plugin-sdk/migration.js";
import type {
  MigrationApplyResult,
  MigrationConfigRuntime,
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
} from "../plugins/types.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";
import {
  buildSetupMigrationPhasePlan,
  mergeSetupMigrationPhaseResults,
  type SetupMigrationPromotionOutcome,
  type SetupMigrationPromotionResume,
} from "./setup.migration-stage.js";

type SetupMigrationImportOutcome = SetupMigrationPromotionOutcome & {
  acknowledgePromotion?: () => Promise<void>;
};

function withPromotionAcknowledgement(
  outcome: SetupMigrationImportOutcome,
  acknowledgePromotion: () => Promise<void>,
): SetupMigrationImportOutcome {
  Object.defineProperty(outcome, "acknowledgePromotion", {
    value: acknowledgePromotion,
    enumerable: false,
  });
  return outcome;
}

function hasDeferredMigrationItems(plan: MigrationPlan): boolean {
  return plan.items.some(
    (item) => item.applyPhase === "after-promotion" && item.status === "planned",
  );
}

export function assertDeferredMigrationApplyContract(
  provider: MigrationProviderPlugin,
  plan: MigrationPlan,
): void {
  if (hasDeferredMigrationItems(plan) && provider.deferredApply?.retrySafe !== true) {
    throw new Error(
      `Migration provider "${provider.id}" cannot defer activation during onboarding because it does not declare retry-safe deferred apply.`,
    );
  }
}

function deferredRetryInstruction(providerId: string): string {
  return `Some post-promotion migration activation steps are still pending. Retry only those steps with openclaw onboard --flow import --import-from ${providerId}.`;
}

function deferredMigrationFailure(plan: MigrationPlan, error: unknown): MigrationApplyResult {
  const reason = formatErrorMessage(error);
  const retry = deferredRetryInstruction(plan.providerId);
  const items = plan.items.map((item) =>
    item.applyPhase === "after-promotion" && (item.status === "planned" || item.status === "error")
      ? { ...item, status: "warning" as const, reason }
      : item,
  );
  return {
    ...plan,
    items,
    summary: summarizeMigrationItems(items),
    warnings: [...new Set([...(plan.warnings ?? []), retry])],
    nextSteps: [...new Set([retry, ...(plan.nextSteps ?? [])])],
  };
}

const COMPLETED_AFTER_PROMOTION_REASON = "completed after promotion";

function isCompletedDeferredMigrationItem(item: MigrationPlan["items"][number]): boolean {
  return item.status === "migrated" || item.deferredCompletion === true;
}

function buildPendingDeferredMigrationPlan(
  plan: MigrationPlan,
  result: MigrationApplyResult | undefined,
): MigrationPlan {
  const completedItemIds = new Set(
    result?.items
      .filter(
        (item) => item.applyPhase === "after-promotion" && isCompletedDeferredMigrationItem(item),
      )
      .map((item) => item.id),
  );
  const deferredPlan = buildSetupMigrationPhasePlan(plan, "after-promotion");
  const items = deferredPlan.items.map((item) =>
    completedItemIds.has(item.id)
      ? {
          ...item,
          status: "skipped" as const,
          reason: COMPLETED_AFTER_PROMOTION_REASON,
          deferredCompletion: true as const,
        }
      : item,
  );
  return { ...deferredPlan, items, summary: summarizeMigrationItems(items) };
}

function mergeDeferredMigrationResults(params: {
  previous: MigrationApplyResult | undefined;
  next: MigrationApplyResult;
}): MigrationApplyResult {
  if (!params.previous) {
    return params.next;
  }
  const previousById = new Map(params.previous.items.map((item) => [item.id, item]));
  const items = params.next.items.map((item) =>
    item.status === "skipped" && item.reason === COMPLETED_AFTER_PROMOTION_REASON
      ? (previousById.get(item.id) ?? item)
      : item,
  );
  const retry = deferredRetryInstruction(params.next.providerId);
  return {
    ...params.next,
    items,
    summary: summarizeMigrationItems(items),
    warnings: [
      ...new Set([
        ...(params.previous.warnings ?? []).filter((warning) => warning !== retry),
        ...(params.next.warnings ?? []),
      ]),
    ],
    nextSteps: [
      ...new Set([
        ...(params.previous.nextSteps ?? []).filter((nextStep) => nextStep !== retry),
        ...(params.next.nextSteps ?? []),
      ]),
    ],
  };
}

function hasPendingDeferredMigrationItems(
  plan: MigrationPlan,
  result: MigrationApplyResult | undefined,
): boolean {
  const resultById = new Map(result?.items.map((item) => [item.id, item]));
  return plan.items.some(
    (item) =>
      item.applyPhase === "after-promotion" &&
      item.status === "planned" &&
      !isCompletedDeferredMigrationItem(resultById.get(item.id) ?? item),
  );
}

async function createPromotionConfigRuntime(
  config: OpenClawConfig,
): Promise<MigrationConfigRuntime> {
  const { mutateConfigFile } = await import("../config/mutate.js");
  let currentConfig = structuredClone(config);
  return {
    current: () => currentConfig,
    async mutateConfigFile(mutation) {
      const result = await mutateConfigFile(mutation);
      currentConfig = structuredClone(result.nextConfig);
      return result;
    },
  };
}

export async function finalizeSetupMigrationPromotion(params: {
  provider: MigrationProviderPlugin;
  resume: SetupMigrationPromotionResume;
  config: OpenClawConfig;
  stateDir: string;
  logger: MigrationProviderContext["logger"];
  prompter: WizardPrompter;
  formatMigrationResult: (result: MigrationApplyResult) => string[];
}): Promise<SetupMigrationImportOutcome> {
  const { continuation } = params.resume;
  const reportDir = path.dirname(params.resume.journalPath);
  await params.resume.copyReportArtifacts();

  const configRuntime = await createPromotionConfigRuntime(params.config);
  let deferredResult = continuation.deferredResult;
  if (
    hasDeferredMigrationItems(continuation.plan) &&
    hasPendingDeferredMigrationItems(continuation.plan, deferredResult)
  ) {
    const previousDeferredResult = deferredResult;
    const deferredPlan = buildPendingDeferredMigrationPlan(
      continuation.plan,
      previousDeferredResult,
    );
    let preparation:
      | Awaited<ReturnType<NonNullable<MigrationProviderPlugin["prepareApply"]>>>
      | undefined;
    let retryResult: MigrationApplyResult;
    try {
      const deferredContext: MigrationProviderContext = {
        config: params.config,
        configRuntime,
        stateDir: params.stateDir,
        logger: params.logger,
        reportDir,
        ...(continuation.source ? { source: continuation.source } : {}),
        ...(continuation.includeSecrets !== undefined
          ? { includeSecrets: continuation.includeSecrets }
          : {}),
        ...(continuation.providerOptions ? { providerOptions: continuation.providerOptions } : {}),
        overwrite: false,
      };
      preparation = await params.provider.prepareApply?.(deferredContext);
      retryResult = mergeDeferredMigrationResults({
        previous: previousDeferredResult,
        next: await params.provider.apply(deferredContext, deferredPlan),
      });
      if (hasPendingDeferredMigrationItems(continuation.plan, retryResult)) {
        retryResult = deferredMigrationFailure(
          retryResult,
          "activation did not complete every deferred item",
        );
      }
    } catch (error) {
      retryResult = mergeDeferredMigrationResults({
        previous: previousDeferredResult,
        next: deferredMigrationFailure(deferredPlan, error),
      });
    } finally {
      const disposable = preparation as { dispose?: () => void | Promise<void> } | undefined;
      await disposable?.dispose?.();
    }
    deferredResult = retryResult;
    await params.resume.saveDeferredResult(deferredResult);
  }

  const finalResult = mergeSetupMigrationPhaseResults({
    plan: continuation.plan,
    staged: continuation.stagedResult,
    ...(deferredResult ? { deferred: deferredResult } : {}),
  });
  finalResult.reportDir = reportDir;
  await writeMigrationReport(finalResult, {
    title: `${continuation.providerLabel} Migration Report`,
  });

  const hasPendingActivation = hasPendingDeferredMigrationItems(continuation.plan, deferredResult);
  if (!hasPendingActivation) {
    await params.resume.complete();
  }
  await params.resume.cleanup();
  await params.prompter.note(
    params.formatMigrationResult(finalResult).join("\n"),
    t("wizard.migration.appliedTitle"),
  );
  if (!continuation.continueOnboarding) {
    await params.prompter.outro(t("wizard.migration.complete"));
  } else {
    await params.prompter.note(
      t("wizard.migration.continuing"),
      t("wizard.migration.appliedTitle"),
    );
  }
  return hasPendingActivation
    ? continuation.outcome
    : withPromotionAcknowledgement(continuation.outcome, params.resume.acknowledge);
}
