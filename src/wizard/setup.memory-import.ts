import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { createMigrationLogger } from "../commands/migrate/context.js";
import {
  applyProviderMemoryImport,
  listMemoryMigrationProviders,
  planProviderMemoryImport,
} from "../commands/migrate/memory-import.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { MigrationPlan, MigrationProviderPlugin } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";

type MemoryImportOffer = {
  provider: MigrationProviderPlugin;
  plan: MigrationPlan;
  source: string;
  plannedIds: string[];
  conflicts: number;
};

// No CLI hint here: `openclaw migrate <id>` runs the FULL provider migration
// (config/credentials/skills), not a memory-only retry. The Control UI Memory
// import page is the only equivalent memory-scoped surface.
async function showSkipHint(prompter: WizardPrompter): Promise<void> {
  await prompter.note(t("wizard.memoryImport.skipHint"), t("wizard.memoryImport.title"));
}

export async function runSetupMemoryImportStep(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
}): Promise<void> {
  const agentId = resolveDefaultAgentId(params.config);
  const providers = listMemoryMigrationProviders(params.config);
  if (providers.length === 0) {
    return;
  }

  const logger = createMigrationLogger(params.runtime);
  const offers: MemoryImportOffer[] = [];
  for (const provider of providers) {
    try {
      // Omit the runtime: provider plan/apply writers would print raw JSON
      // between the wizard prompts; this page renders its own notes.
      const { detection, plan } = await planProviderMemoryImport({
        provider,
        config: params.config,
        agentId,
        overwrite: false,
      });
      const plannedIds = plan.items
        .filter((item) => item.status === "planned")
        .map((item) => item.id);
      if (detection?.found === false || plannedIds.length === 0) {
        continue;
      }
      offers.push({
        provider,
        plan,
        source: detection?.source ?? plan.source,
        plannedIds,
        conflicts: plan.items.filter((item) => item.status === "conflict").length,
      });
    } catch (error) {
      // Discovery is advisory; one broken source must not block onboarding.
      logger.debug?.(
        `Memory migration provider ${provider.id} planning failed: ${formatErrorMessage(error)}`,
      );
    }
  }
  if (offers.length === 0) {
    return;
  }

  const offerLines = offers.map((offer) => {
    const conflictSuffix = offer.conflicts
      ? t("wizard.memoryImport.conflictSuffix", { count: offer.conflicts })
      : "";
    return t("wizard.memoryImport.offerLine", {
      label: offer.provider.label,
      source: offer.source,
      count: offer.plannedIds.length,
      conflictSuffix,
    });
  });
  await params.prompter.note(offerLines.join("\n"), t("wizard.memoryImport.title"));

  const confirmed = await params.prompter.confirm({
    message: t("wizard.memoryImport.confirm"),
    initialValue: true,
  });
  if (!confirmed) {
    await showSkipHint(params.prompter);
    return;
  }

  const selectedIds =
    offers.length === 1
      ? [offers[0]!.provider.id]
      : await params.prompter.multiselect({
          message: t("wizard.memoryImport.selectSources"),
          options: offers.map((offer) => ({
            value: offer.provider.id,
            label: offer.provider.label,
            hint: offer.source,
          })),
          initialValues: offers.map((offer) => offer.provider.id),
        });
  const selected = new Set(selectedIds);
  const selectedOffers = offers.filter((offer) => selected.has(offer.provider.id));
  if (selectedOffers.length === 0) {
    await showSkipHint(params.prompter);
    return;
  }

  params.prompter.disableBackNavigation?.();
  const workspace = resolveAgentWorkspaceDir(params.config, agentId);
  const summaryLines: string[] = [];
  const failureLines: string[] = [];
  for (const offer of selectedOffers) {
    const progress = params.prompter.progress(
      t("wizard.memoryImport.importing", { label: offer.provider.label }),
    );
    try {
      const result = await applyProviderMemoryImport({
        provider: offer.provider,
        config: params.config,
        agentId,
        itemIds: offer.plannedIds,
        overwrite: false,
        preflightPlan: offer.plan,
      });
      summaryLines.push(
        t("wizard.memoryImport.summaryLine", {
          label: offer.provider.label,
          migrated: result.summary.migrated,
          skipped: result.summary.skipped,
          target: result.target ?? offer.plan.target ?? workspace,
        }),
      );
      // Conflicts count as incomplete: a selected item was skipped because its
      // target appeared between planning and copying.
      const incomplete = result.summary.errors + result.summary.conflicts;
      if (incomplete > 0) {
        const reason = t("wizard.memoryImport.partialFailure", { count: incomplete });
        failureLines.push(
          t("wizard.memoryImport.failureLine", {
            label: offer.provider.label,
            reason,
          }),
        );
        progress.stop(t("wizard.memoryImport.importFailed", { label: offer.provider.label }));
        await params.prompter.note(
          t("wizard.memoryImport.applyFailed", {
            label: offer.provider.label,
            reason,
          }),
          t("wizard.memoryImport.errorTitle"),
        );
      } else {
        progress.stop(t("wizard.memoryImport.imported", { label: offer.provider.label }));
      }
    } catch (error) {
      const reason = formatErrorMessage(error);
      summaryLines.push(
        t("wizard.memoryImport.summaryLine", {
          label: offer.provider.label,
          migrated: 0,
          skipped: 0,
          target: offer.plan.target ?? workspace,
        }),
      );
      failureLines.push(
        t("wizard.memoryImport.failureLine", {
          label: offer.provider.label,
          reason,
        }),
      );
      progress.stop(t("wizard.memoryImport.importFailed", { label: offer.provider.label }));
      await params.prompter.note(
        t("wizard.memoryImport.applyFailed", {
          label: offer.provider.label,
          reason,
        }),
        t("wizard.memoryImport.errorTitle"),
      );
    }
  }

  await params.prompter.note(
    [...summaryLines, ...failureLines].join("\n"),
    t("wizard.memoryImport.summaryTitle"),
  );
}
