import { cancel, isCancel, multiselect } from "@clack/prompts";
import { promptYesNo } from "../cli/prompt.js";
import { getRuntimeConfig } from "../config/config.js";
import { redactMigrationPlan } from "../plugin-sdk/migration.js";
import {
  ensureStandaloneMigrationProviderRegistryLoaded,
  resolvePluginMigrationProviders,
} from "../plugins/migration-provider-runtime.js";
import type { MigrationApplyResult, MigrationPlan } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { writeRuntimeJson } from "../runtime.js";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";
import { runMigrationApply } from "./migrate/apply.js";
import { formatMigrationPlan } from "./migrate/output.js";
import { createMigrationPlan, resolveMigrationProvider } from "./migrate/providers.js";
import {
  applyMigrationSelectedSkillItemIds,
  applyMigrationSkillSelection,
  formatMigrationSkillSelectionHint,
  formatMigrationSkillSelectionLabel,
  getMigrationSkillSelectionValue,
  getSelectableMigrationSkillItems,
} from "./migrate/selection.js";
import type {
  MigrateApplyOptions,
  MigrateCommonOptions,
  MigrateDefaultOptions,
} from "./migrate/types.js";

export type { MigrateApplyOptions, MigrateCommonOptions, MigrateDefaultOptions };

function selectMigrationSkills(plan: MigrationPlan, opts: MigrateCommonOptions): MigrationPlan {
  return applyMigrationSkillSelection(plan, opts.skills);
}

async function promptCodexMigrationSkillSelection(
  runtime: RuntimeEnv,
  plan: MigrationPlan,
  opts: MigrateCommonOptions & { yes?: boolean },
): Promise<MigrationPlan | null> {
  if (
    plan.providerId !== "codex" ||
    opts.yes ||
    opts.json ||
    opts.skills !== undefined ||
    !process.stdin.isTTY
  ) {
    return plan;
  }
  const skillItems = getSelectableMigrationSkillItems(plan);
  if (skillItems.length === 0) {
    return plan;
  }
  const selected = await multiselect<string>({
    message: stylePromptMessage("Select Codex skills to migrate into this agent"),
    options: skillItems.map((item) => {
      const hint = formatMigrationSkillSelectionHint(item);
      return {
        value: getMigrationSkillSelectionValue(item),
        label: formatMigrationSkillSelectionLabel(item),
        hint: hint === undefined ? undefined : stylePromptHint(hint),
      };
    }),
    initialValues: skillItems.map(getMigrationSkillSelectionValue),
    required: false,
  });
  if (isCancel(selected)) {
    cancel(stylePromptTitle("Migration cancelled.") ?? "Migration cancelled.");
    runtime.log("Migration cancelled.");
    return null;
  }
  const selectedPlan = applyMigrationSelectedSkillItemIds(plan, new Set(selected));
  runtime.log(`Selected ${selected.length} of ${skillItems.length} Codex skills for migration.`);
  return selectedPlan;
}

export async function migrateListCommand(runtime: RuntimeEnv, opts: { json?: boolean } = {}) {
  const cfg = getRuntimeConfig();
  ensureStandaloneMigrationProviderRegistryLoaded({ cfg });
  const providers = resolvePluginMigrationProviders({ cfg }).map((provider) => ({
    id: provider.id,
    label: provider.label,
    description: provider.description,
  }));
  if (opts.json) {
    writeRuntimeJson(runtime, { providers });
    return;
  }
  if (providers.length === 0) {
    runtime.log("No migration providers found.");
    return;
  }
  runtime.log(
    providers
      .map((provider) =>
        provider.description
          ? `${provider.id}\t${provider.label} - ${provider.description}`
          : `${provider.id}\t${provider.label}`,
      )
      .join("\n"),
  );
}

export async function migratePlanCommand(
  runtime: RuntimeEnv,
  opts: MigrateCommonOptions,
): Promise<MigrationPlan> {
  const providerId = opts.provider?.trim();
  if (!providerId) {
    throw new Error("Migration provider is required.");
  }
  const plan = selectMigrationSkills(
    await createMigrationPlan(runtime, { ...opts, provider: providerId }),
    opts,
  );
  if (opts.json) {
    writeRuntimeJson(runtime, redactMigrationPlan(plan));
  } else {
    runtime.log(formatMigrationPlan(plan).join("\n"));
  }
  return plan;
}

export async function migrateApplyCommand(
  runtime: RuntimeEnv,
  opts: MigrateApplyOptions & { yes: true },
): Promise<MigrationApplyResult>;
export async function migrateApplyCommand(
  runtime: RuntimeEnv,
  opts: MigrateApplyOptions,
): Promise<MigrationApplyResult | MigrationPlan>;
export async function migrateApplyCommand(
  runtime: RuntimeEnv,
  opts: MigrateApplyOptions,
): Promise<MigrationApplyResult | MigrationPlan> {
  const providerId = opts.provider?.trim();
  if (!providerId) {
    throw new Error("Migration provider is required.");
  }
  if (opts.noBackup && !opts.force) {
    throw new Error("--no-backup requires --force.");
  }
  if (!opts.yes && !process.stdin.isTTY) {
    throw new Error("openclaw migrate apply requires --yes in non-interactive mode.");
  }
  const provider = resolveMigrationProvider(providerId);
  if (!opts.yes) {
    const plan = await migratePlanCommand(runtime, {
      ...opts,
      provider: providerId,
      json: opts.json,
    });
    if (opts.json) {
      return plan;
    }
    const selectedPlan = await promptCodexMigrationSkillSelection(runtime, plan, opts);
    if (!selectedPlan) {
      return plan;
    }
    const ok = await promptYesNo("Apply this migration now?", false);
    if (!ok) {
      runtime.log("Migration cancelled.");
      return selectedPlan;
    }
    return await runMigrationApply({
      runtime,
      opts: { ...opts, provider: providerId, yes: true, preflightPlan: selectedPlan },
      providerId,
      provider,
    });
  }
  return await runMigrationApply({ runtime, opts, providerId, provider });
}

export async function migrateDefaultCommand(
  runtime: RuntimeEnv,
  opts: MigrateDefaultOptions,
): Promise<MigrationPlan | MigrationApplyResult> {
  const providerId = opts.provider?.trim();
  if (!providerId) {
    await migrateListCommand(runtime, { json: opts.json });
    return {
      providerId: "list",
      source: "",
      summary: {
        total: 0,
        planned: 0,
        migrated: 0,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
      items: [],
    };
  }
  const plan =
    opts.json && opts.yes && !opts.dryRun
      ? selectMigrationSkills(
          await createMigrationPlan(runtime, { ...opts, provider: providerId }),
          opts,
        )
      : await migratePlanCommand(runtime, {
          ...opts,
          provider: providerId,
          json: opts.json && (opts.dryRun || !opts.yes),
        });
  if (opts.dryRun) {
    return plan;
  }
  if (opts.json && !opts.yes) {
    return plan;
  }
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      runtime.log("Re-run with --yes to apply this migration non-interactively.");
      return plan;
    }
    const selectedPlan = await promptCodexMigrationSkillSelection(runtime, plan, opts);
    if (!selectedPlan) {
      return plan;
    }
    const ok = await promptYesNo("Apply this migration now?", false);
    if (!ok) {
      runtime.log("Migration cancelled.");
      return selectedPlan;
    }
    return await migrateApplyCommand(runtime, {
      ...opts,
      provider: providerId,
      yes: true,
      json: opts.json,
      preflightPlan: selectedPlan,
    });
  }
  return await migrateApplyCommand(runtime, {
    ...opts,
    provider: providerId,
    yes: true,
    json: opts.json,
    preflightPlan: plan,
  });
}
