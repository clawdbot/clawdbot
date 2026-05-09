import { cancel, isCancel } from "@clack/prompts";
import { formatCliCommand } from "../cli/command-format.js";
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
  applyMigrationPluginSelection,
  applyMigrationSelectedPluginItemIds,
  applyMigrationSelectedSkillItemIds,
  applyMigrationSkillSelection,
  formatMigrationPluginSelectionHint,
  formatMigrationPluginSelectionLabel,
  formatMigrationSkillSelectionHint,
  formatMigrationSkillSelectionLabel,
  getDefaultMigrationPluginSelectionValues,
  getDefaultMigrationSkillSelectionValues,
  getMigrationPluginSelectionValue,
  getMigrationSkillSelectionValue,
  getSelectableMigrationPluginItems,
  getSelectableMigrationSkillItems,
  MIGRATION_SELECTION_SKIP,
  MIGRATION_SELECTION_TOGGLE_ALL_OFF,
  MIGRATION_SELECTION_TOGGLE_ALL_ON,
  resolveInteractiveMigrationPluginSelection,
  resolveInteractiveMigrationSkillSelection,
} from "./migrate/selection.js";
import { promptMigrationSelectionValues } from "./migrate/skill-selection-prompt.js";
import type {
  MigrateApplyOptions,
  MigrateCommonOptions,
  MigrateDefaultOptions,
} from "./migrate/types.js";

export type { MigrateApplyOptions, MigrateCommonOptions, MigrateDefaultOptions };

function selectMigrationItems(plan: MigrationPlan, opts: MigrateCommonOptions): MigrationPlan {
  return applyMigrationPluginSelection(
    applyMigrationSkillSelection(plan, opts.skills),
    opts.plugins,
  );
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
  const selected = await promptMigrationSelectionValues({
    message: stylePromptMessage("Select Codex skills to migrate into this agent"),
    options: [
      {
        value: MIGRATION_SELECTION_SKIP,
        label: "Skip for now",
      },
      {
        value: MIGRATION_SELECTION_TOGGLE_ALL_ON,
        label: "Toggle all on",
      },
      {
        value: MIGRATION_SELECTION_TOGGLE_ALL_OFF,
        label: "Toggle all off",
      },
      ...skillItems.map((item) => {
        const hint = formatMigrationSkillSelectionHint(item);
        return {
          value: getMigrationSkillSelectionValue(item),
          label: formatMigrationSkillSelectionLabel(item),
          hint: hint === undefined ? undefined : stylePromptHint(hint),
        };
      }),
    ],
    initialValues: getDefaultMigrationSkillSelectionValues(skillItems),
    required: false,
    selectableValues: skillItems.map(getMigrationSkillSelectionValue),
  });
  if (isCancel(selected)) {
    cancel(stylePromptTitle("Migration cancelled.") ?? "Migration cancelled.");
    runtime.log("Migration cancelled.");
    return null;
  }
  const selection = resolveInteractiveMigrationSkillSelection(skillItems, selected ?? []);
  if (selection.action === "skip") {
    runtime.log("Codex skill migration skipped for now.");
    return applyMigrationSelectedSkillItemIds(plan, new Set());
  }
  const selectedPlan = applyMigrationSelectedSkillItemIds(plan, selection.selectedItemIds);
  runtime.log(
    `Selected ${selection.selectedItemIds.size} of ${skillItems.length} Codex skills for migration.`,
  );
  return selectedPlan;
}

async function promptCodexMigrationPluginSelection(
  runtime: RuntimeEnv,
  plan: MigrationPlan,
  opts: MigrateCommonOptions & { yes?: boolean },
): Promise<MigrationPlan | null> {
  if (
    plan.providerId !== "codex" ||
    opts.yes ||
    opts.json ||
    opts.plugins !== undefined ||
    !process.stdin.isTTY
  ) {
    return plan;
  }
  const pluginItems = getSelectableMigrationPluginItems(plan);
  if (pluginItems.length === 0) {
    return plan;
  }
  const selected = await promptMigrationSelectionValues({
    message: stylePromptMessage("Select native Codex plugins to activate in this agent"),
    options: [
      {
        value: MIGRATION_SELECTION_SKIP,
        label: "Skip for now",
      },
      {
        value: MIGRATION_SELECTION_TOGGLE_ALL_ON,
        label: "Toggle all on",
      },
      {
        value: MIGRATION_SELECTION_TOGGLE_ALL_OFF,
        label: "Toggle all off",
      },
      ...pluginItems.map((item) => {
        const hint = formatMigrationPluginSelectionHint(item);
        return {
          value: getMigrationPluginSelectionValue(item),
          label: formatMigrationPluginSelectionLabel(item),
          hint: hint === undefined ? undefined : stylePromptHint(hint),
        };
      }),
    ],
    initialValues: getDefaultMigrationPluginSelectionValues(pluginItems),
    required: false,
    selectableValues: pluginItems.map(getMigrationPluginSelectionValue),
  });
  if (isCancel(selected)) {
    cancel(stylePromptTitle("Migration cancelled.") ?? "Migration cancelled.");
    runtime.log("Migration cancelled.");
    return null;
  }
  const selection = resolveInteractiveMigrationPluginSelection(pluginItems, selected ?? []);
  if (selection.action === "skip") {
    runtime.log("Codex plugin migration skipped for now.");
    return null;
  }
  const selectedPlan = applyMigrationSelectedPluginItemIds(plan, selection.selectedItemIds);
  runtime.log(
    `Selected ${selection.selectedItemIds.size} of ${pluginItems.length} native Codex plugins for activation.`,
  );
  return selectedPlan;
}

async function promptCodexMigrationSelections(
  runtime: RuntimeEnv,
  plan: MigrationPlan,
  opts: MigrateCommonOptions & { yes?: boolean },
): Promise<MigrationPlan | null> {
  const skillSelectedPlan = await promptCodexMigrationSkillSelection(runtime, plan, opts);
  if (!skillSelectedPlan) {
    return null;
  }
  return await promptCodexMigrationPluginSelection(runtime, skillSelectedPlan, opts);
}

function hasSelectedCodexMigrationWork(plan: MigrationPlan): boolean {
  return plan.items.some(
    (item) =>
      item.status === "planned" &&
      ((item.kind === "skill" && item.action === "copy") ||
        (item.kind === "plugin" && item.action === "install")),
  );
}

function shouldSkipCodexApplyAfterInteractiveSelection(plan: MigrationPlan): boolean {
  return plan.providerId === "codex" && !hasSelectedCodexMigrationWork(plan);
}

function logNoCodexSelection(runtime: RuntimeEnv): void {
  runtime.log("No Codex skills or native Codex plugins selected for migration.");
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
    runtime.log(
      `No migration providers found. Run ${formatCliCommand("openclaw plugins list")} to verify provider plugins are installed and enabled.`,
    );
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
    throw new Error(
      `Migration provider is required. Run ${formatCliCommand("openclaw migrate list")} to choose one.`,
    );
  }
  const plan = selectMigrationItems(
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
    throw new Error(
      `Migration provider is required. Run ${formatCliCommand("openclaw migrate list")} to choose one.`,
    );
  }
  if (opts.noBackup && !opts.force) {
    throw new Error("--no-backup requires --force because it skips the automatic rollback copy.");
  }
  if (!opts.yes && !process.stdin.isTTY) {
    throw new Error(
      `openclaw migrate apply requires --yes in non-interactive mode. Preview first with ${formatCliCommand("openclaw migrate plan --provider <provider>")}.`,
    );
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
    const selectedPlan = await promptCodexMigrationSelections(runtime, plan, opts);
    if (!selectedPlan) {
      return plan;
    }
    if (shouldSkipCodexApplyAfterInteractiveSelection(selectedPlan)) {
      logNoCodexSelection(runtime);
      return selectedPlan;
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
      ? selectMigrationItems(
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
    const selectedPlan = await promptCodexMigrationSelections(runtime, plan, opts);
    if (!selectedPlan) {
      return plan;
    }
    if (shouldSkipCodexApplyAfterInteractiveSelection(selectedPlan)) {
      logNoCodexSelection(runtime);
      return selectedPlan;
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
