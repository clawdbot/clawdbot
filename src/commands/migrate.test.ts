import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MigrationApplyResult, MigrationPlan } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  backupCreateCommand: vi.fn(),
  cancelSymbol: Symbol("cancel"),
  clackCancel: vi.fn(),
  clackIsCancel: vi.fn(),
  multiselect: vi.fn(),
  progress: {
    setLabel: vi.fn(),
    setPercent: vi.fn(),
    tick: vi.fn(),
  },
  promptYesNo: vi.fn(),
  provider: {
    id: "hermes",
    label: "Hermes",
    plan: vi.fn(),
    apply: vi.fn(),
  },
  withProgress: vi.fn(),
}));

mocks.withProgress.mockImplementation(
  async (_opts: unknown, run: (progress: unknown) => unknown) => await run(mocks.progress),
);

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  loadConfig: () => ({}),
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/tmp/openclaw-migrate-command-test",
}));

vi.mock("../cli/prompt.js", () => ({
  promptYesNo: mocks.promptYesNo,
}));

vi.mock("../cli/progress.js", () => ({
  withProgress: mocks.withProgress,
}));

vi.mock("@clack/prompts", () => ({
  cancel: mocks.clackCancel,
  isCancel: mocks.clackIsCancel,
  log: { message: vi.fn() },
}));

vi.mock("./migrate/skill-selection-prompt.js", () => ({
  promptMigrationSelectionValues: mocks.multiselect,
  promptMigrationSkillSelectionValues: mocks.multiselect,
}));

vi.mock("../plugins/migration-provider-runtime.js", () => ({
  ensureStandaloneMigrationProviderRegistryLoaded: vi.fn(),
  resolvePluginMigrationProvider: () => mocks.provider,
  resolvePluginMigrationProviders: () => [mocks.provider],
}));

vi.mock("./backup.js", () => ({
  backupCreateCommand: mocks.backupCreateCommand,
}));

const {
  MIGRATION_SKILL_SELECTION_ACCEPT,
  MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF,
  MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON,
} = await import("./migrate/selection.js");
const { migrateApplyCommand, migrateDefaultCommand, migratePlanCommand } =
  await import("./migrate.js");

function plan(overrides: Partial<MigrationPlan> = {}): MigrationPlan {
  return {
    providerId: "hermes",
    source: "/tmp/hermes",
    summary: {
      total: 1,
      planned: 1,
      migrated: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      sensitive: 0,
    },
    items: [{ id: "workspace:AGENTS.md", kind: "workspace", action: "copy", status: "planned" }],
    ...overrides,
  };
}

function codexSkillPlan(overrides: Partial<MigrationPlan> = {}): MigrationPlan {
  const items: MigrationPlan["items"] = [
    {
      id: "skill:alpha",
      kind: "skill",
      action: "copy",
      status: "planned",
      source: "/tmp/codex/skills/alpha",
      target: "/tmp/openclaw/workspace/skills/alpha",
      details: {
        skillName: "alpha",
        sourceLabel: "Codex skill",
      },
    },
    {
      id: "skill:beta",
      kind: "skill",
      action: "copy",
      status: "planned",
      source: "/tmp/codex/skills/beta",
      target: "/tmp/openclaw/workspace/skills/beta",
      details: {
        skillName: "beta",
        sourceLabel: "Personal AgentSkill",
      },
    },
    {
      id: "archive:config.toml",
      kind: "archive",
      action: "archive",
      status: "planned",
    },
  ];
  return {
    providerId: "codex",
    source: "/tmp/codex",
    summary: {
      total: 3,
      planned: 3,
      migrated: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      sensitive: 0,
    },
    items,
    ...overrides,
  };
}

function codexPluginPlan(overrides: Partial<MigrationPlan> = {}): MigrationPlan {
  const items: MigrationPlan["items"] = [
    {
      id: "plugin:google-calendar",
      kind: "plugin",
      action: "install",
      status: "planned",
      details: {
        configKey: "google-calendar",
        marketplaceName: "openai-curated",
        pluginName: "google-calendar",
      },
    },
    {
      id: "plugin:gmail",
      kind: "plugin",
      action: "install",
      status: "planned",
      details: {
        configKey: "gmail",
        marketplaceName: "openai-curated",
        pluginName: "gmail",
      },
    },
    {
      id: "config:codex-plugins",
      kind: "config",
      action: "merge",
      status: "planned",
      details: {
        value: {
          enabled: true,
          config: {
            codexPlugins: {
              enabled: true,
              allow_destructive_actions: true,
              plugins: {
                "google-calendar": {
                  enabled: true,
                  marketplaceName: "openai-curated",
                  pluginName: "google-calendar",
                },
                gmail: {
                  enabled: true,
                  marketplaceName: "openai-curated",
                  pluginName: "gmail",
                },
              },
            },
          },
        },
      },
    },
  ];
  return {
    providerId: "codex",
    source: "/tmp/codex",
    summary: {
      total: 3,
      planned: 3,
      migrated: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      sensitive: 0,
    },
    items,
    ...overrides,
  };
}

type MockCallSource = {
  mock: {
    calls: ReadonlyArray<ReadonlyArray<unknown>>;
  };
};

type MigrationSelectionPrompt = {
  initialValues?: unknown;
  message?: unknown;
  options?: Array<{ hint?: unknown; label?: unknown; value?: unknown }>;
  required?: unknown;
};

function mockCall(source: MockCallSource, callIndex = 0): ReadonlyArray<unknown> {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call;
}

function mockArg(source: MockCallSource, callIndex: number, argIndex: number) {
  return mockCall(source, callIndex)[argIndex];
}

function multiselectPrompt(callIndex = 0): MigrationSelectionPrompt {
  return mockArg(mocks.multiselect, callIndex, 0) as MigrationSelectionPrompt;
}

function firstApplyContext(): Record<string, unknown> {
  return mockArg(mocks.provider.apply, 0, 0) as Record<string, unknown>;
}

function firstAppliedPlan(): MigrationPlan {
  return mockArg(mocks.provider.apply, 0, 1) as MigrationPlan;
}

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit(code) {
    throw new Error(`exit ${code}`);
  },
};

describe("migrateApplyCommand", () => {
  const originalIsTty = process.stdin.isTTY;

  beforeEach(async () => {
    await fs.rm("/tmp/openclaw-migrate-command-test", { force: true, recursive: true });
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    mocks.provider.plan.mockReset();
    mocks.provider.apply.mockReset();
    mocks.withProgress.mockClear();
    mocks.progress.setLabel.mockClear();
    mocks.progress.setPercent.mockClear();
    mocks.progress.tick.mockClear();
    mocks.multiselect.mockReset();
    mocks.clackCancel.mockReset();
    mocks.clackIsCancel.mockReset();
    mocks.clackIsCancel.mockImplementation((value) => value === mocks.cancelSymbol);
    mocks.promptYesNo.mockReset();
    mocks.backupCreateCommand.mockReset();
    mocks.backupCreateCommand.mockResolvedValue({ archivePath: "/tmp/openclaw-backup.tgz" });
  });

  afterEach(async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalIsTty,
    });
    await fs.rm("/tmp/openclaw-migrate-command-test", { force: true, recursive: true });
    vi.clearAllMocks();
  });

  it("requires explicit force before skipping the pre-migration backup", async () => {
    await expect(
      migrateApplyCommand(runtime, { provider: "hermes", yes: true, noBackup: true }),
    ).rejects.toThrow("--no-backup requires --force");
    expect(mocks.provider.plan).not.toHaveBeenCalled();
  });

  it("requires --yes in non-interactive apply mode", async () => {
    await expect(migrateApplyCommand(runtime, { provider: "hermes" })).rejects.toThrow(
      "requires --yes",
    );
    expect(mocks.provider.plan).not.toHaveBeenCalled();
  });

  it("rejects --verify-plugin-apps for non-Codex providers", async () => {
    await expect(
      migrateApplyCommand(runtime, { provider: "hermes", yes: true, verifyPluginApps: true }),
    ).rejects.toThrow("--verify-plugin-apps is only supported for Codex migrations");
    expect(mocks.provider.plan).not.toHaveBeenCalled();
    expect(mocks.provider.apply).not.toHaveBeenCalled();
  });

  it("rejects --verify-plugin-apps for non-Codex default and plan paths", async () => {
    await expect(
      migrateDefaultCommand(runtime, { provider: "hermes", verifyPluginApps: true }),
    ).rejects.toThrow("--verify-plugin-apps is only supported for Codex migrations");
    await expect(
      migratePlanCommand(runtime, { provider: "hermes", verifyPluginApps: true }),
    ).rejects.toThrow("--verify-plugin-apps is only supported for Codex migrations");
    expect(mocks.provider.plan).not.toHaveBeenCalled();
    expect(mocks.provider.apply).not.toHaveBeenCalled();
  });

  it("passes --verify-plugin-apps into Codex migration planning", async () => {
    const planned = codexPluginPlan();
    mocks.provider.plan.mockImplementation(async (ctx) => {
      expect(ctx.providerOptions).toEqual({ verifyPluginApps: true });
      return planned;
    });

    const result = await migrateDefaultCommand(runtime, {
      provider: "codex",
      dryRun: true,
      verifyPluginApps: true,
    });

    expect(result).toBe(planned);
    expect(mocks.provider.plan).toHaveBeenCalledTimes(1);
    expect(mocks.provider.apply).not.toHaveBeenCalled();
  });

  it("passes --verify-plugin-apps into Codex plan command", async () => {
    const planned = codexPluginPlan();
    mocks.provider.plan.mockImplementation(async (ctx) => {
      expect(ctx.providerOptions).toEqual({ verifyPluginApps: true });
      return planned;
    });

    const result = await migratePlanCommand(runtime, {
      provider: "codex",
      verifyPluginApps: true,
    });

    expect(result).toBe(planned);
    expect(mocks.provider.plan).toHaveBeenCalledTimes(1);
    expect(mocks.withProgress).toHaveBeenCalledWith(
      expect.objectContaining({ indeterminate: true, label: "Scanning codex migration…" }),
      expect.any(Function),
    );
  });

  it("does not wrap JSON planning in progress output", async () => {
    const planned = codexPluginPlan();
    mocks.provider.plan.mockResolvedValue(planned);

    const result = await migratePlanCommand(runtime, {
      provider: "codex",
      json: true,
    });

    expect(result).toBe(planned);
    expect(mocks.withProgress).not.toHaveBeenCalled();
  });

  it("passes --verify-plugin-apps into Codex apply planning and apply contexts", async () => {
    const planned = codexPluginPlan();
    const applied: MigrationApplyResult = {
      ...planned,
      summary: { ...planned.summary, planned: 0, migrated: planned.summary.planned },
      items: planned.items.map((item) => ({ ...item, status: "migrated" as const })),
    };
    mocks.provider.plan.mockImplementation(async (ctx) => {
      expect(ctx.providerOptions).toEqual({ verifyPluginApps: true });
      return planned;
    });
    mocks.provider.apply.mockImplementation(async (ctx) => {
      expect(ctx.providerOptions).toEqual({ verifyPluginApps: true });
      return applied;
    });

    await migrateApplyCommand(runtime, { provider: "codex", yes: true, verifyPluginApps: true });

    expect(mocks.provider.plan).toHaveBeenCalledTimes(1);
    expect(mocks.provider.apply).toHaveBeenCalledTimes(1);
  });

  it("uses embedded config override and return patch mode for Codex planning and apply", async () => {
    const configOverride = {
      plugins: {
        entries: {
          codex: { enabled: true },
        },
      },
    };
    const planned = codexPluginPlan();
    const applied: MigrationApplyResult = {
      ...planned,
      summary: { ...planned.summary, planned: 0, migrated: planned.summary.planned },
      items: planned.items.map((item) => ({ ...item, status: "migrated" as const })),
    };
    mocks.provider.plan.mockImplementation(async (ctx) => {
      expect(ctx.config).toBe(configOverride);
      expect(ctx.providerOptions).toEqual({ configPatchMode: "return" });
      return planned;
    });
    mocks.provider.apply.mockImplementation(async (ctx) => {
      expect(ctx.config).toBe(configOverride);
      expect(ctx.providerOptions).toEqual({ configPatchMode: "return" });
      return applied;
    });

    await migrateApplyCommand(runtime, {
      provider: "codex",
      yes: true,
      configOverride,
      configPatchMode: "return",
    });

    expect(mocks.provider.plan).toHaveBeenCalledTimes(1);
    expect(mocks.provider.apply).toHaveBeenCalledTimes(1);
  });

  it("previews and prompts before interactive apply without --yes", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const planned = plan();
    const applied: MigrationApplyResult = {
      ...planned,
      summary: { ...planned.summary, planned: 0, migrated: 1 },
      items: planned.items.map((item) => ({ ...item, status: "migrated" })),
    };
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.provider.apply.mockResolvedValue(applied);
    mocks.promptYesNo.mockResolvedValue(true);

    await migrateApplyCommand(runtime, { provider: "hermes" });

    expect(mocks.provider.plan).toHaveBeenCalledTimes(1);
    expect(mocks.promptYesNo).toHaveBeenCalledWith("Apply this migration now?", false);
    expect(mocks.backupCreateCommand).toHaveBeenCalled();
    expect(typeof firstApplyContext()).toBe("object");
    expect(firstAppliedPlan()).toBe(planned);
  });

  it("prompts for Codex skills before interactive default apply", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const planned = codexSkillPlan();
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.multiselect.mockResolvedValue(["skill:alpha"]);
    mocks.promptYesNo.mockResolvedValue(true);
    mocks.provider.apply.mockImplementation(async (_ctx, selectedPlan: MigrationPlan) => ({
      ...selectedPlan,
      summary: { ...selectedPlan.summary, planned: 0, migrated: 2 },
      items: selectedPlan.items.map((item) =>
        item.status === "planned" ? { ...item, status: "migrated" as const } : item,
      ),
    }));

    await migrateDefaultCommand(runtime, { provider: "codex" });

    const selectionPrompt = multiselectPrompt();
    expect(String(selectionPrompt.message)).toContain("Select Codex skills");
    expect(selectionPrompt.initialValues).toStrictEqual(["skill:alpha", "skill:beta"]);
    expect(selectionPrompt.required).toBe(false);
    expect(selectionPrompt.options?.map(({ label, value }) => ({ label, value }))).toStrictEqual([
      { value: MIGRATION_SKILL_SELECTION_ACCEPT, label: "Accept recommended" },
      { value: "skill:alpha", label: "alpha" },
      { value: "skill:beta", label: "beta" },
      { value: MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON, label: "Toggle all on" },
      { value: MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF, label: "Toggle all off" },
    ]);
    expect(mocks.promptYesNo).toHaveBeenCalledWith("Apply this migration now?", false);
    const appliedPlan = firstAppliedPlan();
    expect(appliedPlan.summary.planned).toBe(2);
    expect(appliedPlan.summary.skipped).toBe(1);
    expect(appliedPlan.summary.conflicts).toBe(0);
    const itemsById = new Map(appliedPlan.items.map((item) => [item.id, item]));
    expect(itemsById.get("skill:alpha")?.status).toBe("planned");
    expect(itemsById.get("skill:beta")?.status).toBe("skipped");
    expect(itemsById.get("skill:beta")?.reason).toBe("not selected for migration");
    expect(itemsById.get("archive:config.toml")?.status).toBe("planned");
  });

  it("prompts for native Codex plugins after interactive skill selection", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const skillPlan = codexSkillPlan();
    const pluginPlan = codexPluginPlan();
    const planned = codexSkillPlan({
      summary: {
        total: skillPlan.items.length + pluginPlan.items.length,
        planned: skillPlan.items.length + pluginPlan.items.length,
        migrated: 0,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
      items: [...skillPlan.items, ...pluginPlan.items],
    });
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.multiselect
      .mockResolvedValueOnce(["skill:alpha"])
      .mockResolvedValueOnce(["plugin:gmail"]);
    mocks.promptYesNo.mockResolvedValue(true);
    mocks.provider.apply.mockImplementation(async (_ctx, selectedPlan: MigrationPlan) => ({
      ...selectedPlan,
      summary: { ...selectedPlan.summary, planned: 0, migrated: selectedPlan.summary.planned },
      items: selectedPlan.items.map((item) =>
        item.status === "planned" ? { ...item, status: "migrated" as const } : item,
      ),
    }));

    await migrateDefaultCommand(runtime, { provider: "codex" });

    expect(mocks.multiselect).toHaveBeenCalledTimes(2);
    const skillPrompt = multiselectPrompt();
    expect(String(skillPrompt.message)).toContain("Select Codex skills");
    const pluginPrompt = multiselectPrompt(1);
    expect(String(pluginPrompt.message)).toContain("Select native Codex plugins");
    expect(pluginPrompt.initialValues).toStrictEqual(["plugin:google-calendar", "plugin:gmail"]);
    expect(pluginPrompt.required).toBe(false);
    expect(pluginPrompt.options?.map(({ label, value }) => ({ label, value }))).toStrictEqual([
      { value: MIGRATION_SKILL_SELECTION_ACCEPT, label: "Accept recommended" },
      { value: "plugin:google-calendar", label: "google-calendar" },
      { value: "plugin:gmail", label: "gmail" },
      { value: MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON, label: "Toggle all on" },
      { value: MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF, label: "Toggle all off" },
    ]);
    expect(mocks.promptYesNo).toHaveBeenCalledWith("Apply this migration now?", false);
    const appliedPlan = firstAppliedPlan();
    expect(appliedPlan.summary.planned).toBe(4);
    expect(appliedPlan.summary.skipped).toBe(2);
    expect(appliedPlan.summary.conflicts).toBe(0);
    const itemsById = new Map(appliedPlan.items.map((item) => [item.id, item]));
    expect(itemsById.get("skill:alpha")?.status).toBe("planned");
    expect(itemsById.get("skill:beta")?.status).toBe("skipped");
    expect(itemsById.get("skill:beta")?.reason).toBe("not selected for migration");
    expect(itemsById.get("plugin:google-calendar")?.status).toBe("skipped");
    expect(itemsById.get("plugin:google-calendar")?.reason).toBe("not selected for migration");
    expect(itemsById.get("plugin:gmail")?.status).toBe("planned");
    expect(itemsById.get("config:codex-plugins")?.status).toBe("planned");
    expect(
      Object.keys(
        (
          (
            (
              appliedPlan.items.find((item) => item.id === "config:codex-plugins")?.details
                ?.value as Record<string, unknown>
            ).config as Record<string, unknown>
          ).codexPlugins as Record<string, unknown>
        ).plugins as Record<string, unknown>,
      ),
    ).toEqual(["gmail"]);
  });

  it("keeps all default plugin selections when interactive skills are toggled off", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const skillPlan = codexSkillPlan();
    const pluginPlan = codexPluginPlan();
    const planned = codexSkillPlan({
      summary: {
        total: skillPlan.items.length + pluginPlan.items.length,
        planned: skillPlan.items.length + pluginPlan.items.length,
        migrated: 0,
        skipped: 0,
        conflicts: 0,
        errors: 0,
        sensitive: 0,
      },
      items: [...skillPlan.items, ...pluginPlan.items],
    });
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.multiselect
      .mockResolvedValueOnce([MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF])
      .mockResolvedValueOnce(["plugin:google-calendar", "plugin:gmail"]);
    mocks.promptYesNo.mockResolvedValue(true);
    mocks.provider.apply.mockImplementation(async (_ctx, selectedPlan: MigrationPlan) => ({
      ...selectedPlan,
      summary: { ...selectedPlan.summary, planned: 0, migrated: selectedPlan.summary.planned },
      items: selectedPlan.items.map((item) =>
        item.status === "planned" ? { ...item, status: "migrated" as const } : item,
      ),
    }));

    await migrateDefaultCommand(runtime, { provider: "codex" });

    const pluginPrompt = multiselectPrompt(1);
    expect(String(pluginPrompt.message)).toContain("Select native Codex plugins");
    expect(pluginPrompt.initialValues).toStrictEqual(["plugin:google-calendar", "plugin:gmail"]);
    const appliedPlan = firstAppliedPlan();
    expect(appliedPlan.summary.planned).toBe(4);
    expect(appliedPlan.summary.skipped).toBe(2);
    expect(appliedPlan.summary.conflicts).toBe(0);
    const itemsById = new Map(appliedPlan.items.map((item) => [item.id, item]));
    expect(itemsById.get("skill:alpha")?.status).toBe("skipped");
    expect(itemsById.get("skill:alpha")?.reason).toBe("not selected for migration");
    expect(itemsById.get("skill:beta")?.status).toBe("skipped");
    expect(itemsById.get("skill:beta")?.reason).toBe("not selected for migration");
    expect(itemsById.get("plugin:google-calendar")?.status).toBe("planned");
    expect(itemsById.get("plugin:gmail")?.status).toBe("planned");
    expect(itemsById.get("config:codex-plugins")?.status).toBe("planned");
  });

  it("leaves target-existing Codex plugins unchecked with a conflict hint", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const planned = codexPluginPlan({
      summary: {
        total: 3,
        planned: 2,
        migrated: 0,
        skipped: 0,
        conflicts: 1,
        errors: 0,
        sensitive: 0,
      },
      items: [
        {
          id: "plugin:google-calendar",
          kind: "plugin",
          action: "install",
          status: "conflict",
          reason: "plugin exists",
          details: {
            configKey: "google-calendar",
            marketplaceName: "openai-curated",
            pluginName: "google-calendar",
          },
        },
        codexPluginPlan().items[1],
        codexPluginPlan().items[2],
      ],
    });
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.multiselect.mockResolvedValue(["plugin:gmail"]);
    mocks.promptYesNo.mockResolvedValue(true);
    mocks.provider.apply.mockImplementation(async (_ctx, selectedPlan: MigrationPlan) => ({
      ...selectedPlan,
      summary: { ...selectedPlan.summary, planned: 0, migrated: selectedPlan.summary.planned },
      items: selectedPlan.items.map((item) =>
        item.status === "planned" ? { ...item, status: "migrated" as const } : item,
      ),
    }));

    await migrateDefaultCommand(runtime, { provider: "codex" });

    const pluginPrompt = multiselectPrompt();
    expect(String(pluginPrompt.message)).toContain("Select native Codex plugins");
    expect(pluginPrompt.initialValues).toStrictEqual(["plugin:gmail"]);
    const optionsByValue = new Map(pluginPrompt.options?.map((option) => [option.value, option]));
    expect(optionsByValue.get("plugin:google-calendar")?.label).toBe("google-calendar");
    expect(String(optionsByValue.get("plugin:google-calendar")?.hint)).toContain(
      "already installed in workspace",
    );
    expect(optionsByValue.get("plugin:gmail")?.label).toBe("gmail");
    const appliedPlan = firstAppliedPlan();
    expect(appliedPlan.summary.planned).toBe(2);
    expect(appliedPlan.summary.skipped).toBe(1);
    expect(appliedPlan.summary.conflicts).toBe(0);
    const itemsById = new Map(appliedPlan.items.map((item) => [item.id, item]));
    expect(itemsById.get("plugin:google-calendar")?.status).toBe("skipped");
    expect(itemsById.get("plugin:google-calendar")?.reason).toBe("not selected for migration");
    expect(itemsById.get("plugin:gmail")?.status).toBe("planned");
  });

  it("does not apply when interactive Codex plugin migration chooses no plugins", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const planned = codexPluginPlan();
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.multiselect.mockResolvedValue([MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF]);

    const result = await migrateDefaultCommand(runtime, { provider: "codex" });

    const pluginPrompt = multiselectPrompt();
    expect(String(pluginPrompt.message)).toContain("Select native Codex plugins");
    expect(mocks.promptYesNo).not.toHaveBeenCalled();
    expect(mocks.backupCreateCommand).not.toHaveBeenCalled();
    expect(mocks.provider.apply).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "No Codex skills or native Codex plugins selected for migration.",
    );
    expect(result.summary.planned).toBe(0);
    expect(result.summary.skipped).toBe(3);
    expect(result.summary.conflicts).toBe(0);
    const itemsById = new Map(result.items.map((item) => [item.id, item]));
    expect(itemsById.get("plugin:google-calendar")?.status).toBe("skipped");
    expect(itemsById.get("plugin:google-calendar")?.reason).toBe("not selected for migration");
    expect(itemsById.get("plugin:gmail")?.status).toBe("skipped");
    expect(itemsById.get("plugin:gmail")?.reason).toBe("not selected for migration");
    expect(itemsById.get("config:codex-plugins")?.status).toBe("skipped");
    expect(itemsById.get("config:codex-plugins")?.reason).toBe("not selected for migration");
  });

  it("does not prompt for Codex plugins when --plugin selected them explicitly", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const planned = codexPluginPlan();
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.promptYesNo.mockResolvedValue(true);
    mocks.provider.apply.mockImplementation(async (_ctx, selectedPlan: MigrationPlan) => ({
      ...selectedPlan,
      summary: { ...selectedPlan.summary, planned: 0, migrated: selectedPlan.summary.planned },
      items: selectedPlan.items.map((item) =>
        item.status === "planned" ? { ...item, status: "migrated" as const } : item,
      ),
    }));

    await migrateDefaultCommand(runtime, { provider: "codex", plugins: ["gmail"] });

    expect(mocks.multiselect).not.toHaveBeenCalled();
    expect(mocks.promptYesNo).toHaveBeenCalledWith("Apply this migration now?", false);
    const appliedPlan = firstAppliedPlan();
    expect(appliedPlan.summary.planned).toBe(2);
    expect(appliedPlan.summary.skipped).toBe(1);
    expect(appliedPlan.summary.conflicts).toBe(0);
    const itemsById = new Map(appliedPlan.items.map((item) => [item.id, item]));
    expect(itemsById.get("plugin:google-calendar")?.status).toBe("skipped");
    expect(itemsById.get("plugin:google-calendar")?.reason).toBe("not selected for migration");
    expect(itemsById.get("plugin:gmail")?.status).toBe("planned");
  });

  it("leaves conflicting Codex skills unchecked by default", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const planned = codexSkillPlan({
      summary: {
        total: 3,
        planned: 2,
        migrated: 0,
        skipped: 0,
        conflicts: 1,
        errors: 0,
        sensitive: 0,
      },
      items: [
        {
          id: "skill:alpha",
          kind: "skill",
          action: "copy",
          status: "planned",
          details: { skillName: "alpha" },
        },
        {
          id: "skill:beta",
          kind: "skill",
          action: "copy",
          status: "conflict",
          reason: "target exists",
          details: { skillName: "beta" },
        },
        {
          id: "archive:config.toml",
          kind: "archive",
          action: "archive",
          status: "planned",
        },
      ],
    });
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.multiselect.mockResolvedValue(["skill:alpha"]);
    mocks.promptYesNo.mockResolvedValue(false);

    await migrateDefaultCommand(runtime, { provider: "codex" });

    const skillPrompt = multiselectPrompt();
    expect(skillPrompt.initialValues).toStrictEqual(["skill:alpha"]);
    const skillOptionsByValue = new Map(
      skillPrompt.options?.map((option) => [option.value, option]),
    );
    expect(skillOptionsByValue.get("skill:beta")?.label).toBe("beta");
    expect(mocks.promptYesNo).toHaveBeenCalledWith("Apply this migration now?", false);
    expect(mocks.provider.apply).not.toHaveBeenCalled();
  });

  it("does not apply archive-only Codex migration work after Toggle all off", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const planned = codexSkillPlan();
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.multiselect.mockResolvedValue([MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF]);

    const result = await migrateDefaultCommand(runtime, { provider: "codex" });

    expect(mocks.promptYesNo).not.toHaveBeenCalled();
    expect(mocks.backupCreateCommand).not.toHaveBeenCalled();
    expect(mocks.provider.apply).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "No Codex skills or native Codex plugins selected for migration.",
    );
    expect(result.summary.planned).toBe(1);
    expect(result.summary.skipped).toBe(2);
    expect(result.summary.conflicts).toBe(0);
    const itemsById = new Map(result.items.map((item) => [item.id, item]));
    expect(itemsById.get("skill:alpha")?.status).toBe("skipped");
    expect(itemsById.get("skill:alpha")?.reason).toBe("not selected for migration");
    expect(itemsById.get("skill:beta")?.status).toBe("skipped");
    expect(itemsById.get("skill:beta")?.reason).toBe("not selected for migration");
    expect(itemsById.get("archive:config.toml")?.status).toBe("planned");
  });

  it("applies Toggle all on unless Toggle all off is also selected", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const planned = codexSkillPlan();
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.multiselect.mockResolvedValue([MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON]);
    mocks.promptYesNo.mockResolvedValue(true);
    mocks.provider.apply.mockImplementation(async (_ctx, selectedPlan: MigrationPlan) => ({
      ...selectedPlan,
      summary: { ...selectedPlan.summary, planned: 0, migrated: 3 },
      items: selectedPlan.items.map((item) =>
        item.status === "planned" ? { ...item, status: "migrated" as const } : item,
      ),
    }));

    await migrateDefaultCommand(runtime, { provider: "codex" });

    let appliedPlan = firstAppliedPlan();
    expect(appliedPlan.summary.planned).toBe(3);
    expect(appliedPlan.summary.skipped).toBe(0);
    expect(appliedPlan.summary.conflicts).toBe(0);

    mocks.provider.plan.mockResolvedValue(planned);
    mocks.multiselect.mockResolvedValue([
      MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON,
      MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF,
    ]);
    mocks.promptYesNo.mockResolvedValue(true);
    mocks.provider.apply.mockClear();
    mocks.promptYesNo.mockClear();

    await migrateDefaultCommand(runtime, { provider: "codex" });

    expect(mocks.promptYesNo).not.toHaveBeenCalled();
    expect(mocks.provider.apply).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "No Codex skills or native Codex plugins selected for migration.",
    );
  });

  it("does not apply when interactive apply confirmation is declined", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const planned = plan();
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.promptYesNo.mockResolvedValue(false);

    const result = await migrateApplyCommand(runtime, { provider: "hermes", overwrite: true });

    expect(result).toBe(planned);
    expect(mocks.promptYesNo).toHaveBeenCalledWith("Apply this migration now?", false);
    expect(runtime.log).toHaveBeenCalledWith("Migration cancelled.");
    expect(mocks.backupCreateCommand).not.toHaveBeenCalled();
    expect(mocks.provider.apply).not.toHaveBeenCalled();
  });

  it("prints a JSON plan without applying when interactive apply uses --json without --yes", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    const planned = plan({
      items: [
        {
          id: "config:mcp-servers",
          kind: "config",
          action: "merge",
          status: "planned",
          details: {
            value: {
              time: {
                env: { OPENAI_API_KEY: "short-dev-key", SAFE_FLAG: "visible" },
                headers: { Authorization: "Bearer short-dev-key" },
              },
            },
          },
        },
      ],
    });
    const logs: string[] = [];
    const jsonRuntime: RuntimeEnv = {
      ...runtime,
      log(message) {
        logs.push(String(message));
      },
    };
    mocks.provider.plan.mockResolvedValue(planned);

    const result = await migrateApplyCommand(jsonRuntime, {
      provider: "hermes",
      json: true,
    });

    expect(result).toBe(planned);
    expect(logs).toHaveLength(1);
    const logPayload = JSON.parse(logs[0] ?? "{}") as {
      items?: Array<{
        details?: {
          value?: {
            time?: {
              env?: Record<string, unknown>;
              headers?: Record<string, unknown>;
            };
          };
        };
      }>;
      providerId?: unknown;
      summary?: { planned?: unknown };
    };
    expect(logPayload.providerId).toBe("hermes");
    expect(logPayload.summary?.planned).toBe(1);
    expect(logPayload.items?.[0]?.details?.value?.time?.env?.OPENAI_API_KEY).toBe("[redacted]");
    expect(logPayload.items?.[0]?.details?.value?.time?.env?.SAFE_FLAG).toBe("visible");
    expect(logPayload.items?.[0]?.details?.value?.time?.headers?.Authorization).toBe("[redacted]");
    expect(logs[0]).not.toContain("short-dev-key");
    expect(mocks.promptYesNo).not.toHaveBeenCalled();
    expect(mocks.backupCreateCommand).not.toHaveBeenCalled();
    expect(mocks.provider.apply).not.toHaveBeenCalled();
  });

  it("does not create a backup or apply when the preflight plan has conflicts", async () => {
    mocks.provider.plan.mockResolvedValue(
      plan({
        summary: {
          total: 1,
          planned: 0,
          migrated: 0,
          skipped: 0,
          conflicts: 1,
          errors: 0,
          sensitive: 0,
        },
        items: [
          {
            id: "workspace:SOUL.md",
            kind: "workspace",
            action: "copy",
            status: "conflict",
          },
        ],
      }),
    );

    await expect(migrateApplyCommand(runtime, { provider: "hermes", yes: true })).rejects.toThrow(
      "Migration has 1 conflict",
    );
    expect(mocks.backupCreateCommand).not.toHaveBeenCalled();
    expect(mocks.provider.apply).not.toHaveBeenCalled();
  });

  it("filters explicit Codex skills before apply conflict checks", async () => {
    const planned = codexSkillPlan({
      summary: {
        total: 3,
        planned: 2,
        migrated: 0,
        skipped: 0,
        conflicts: 1,
        errors: 0,
        sensitive: 0,
      },
      items: [
        {
          id: "skill:alpha",
          kind: "skill",
          action: "copy",
          status: "planned",
          details: { skillName: "alpha" },
        },
        {
          id: "skill:beta",
          kind: "skill",
          action: "copy",
          status: "conflict",
          reason: "target exists",
          details: { skillName: "beta" },
        },
        {
          id: "archive:config.toml",
          kind: "archive",
          action: "archive",
          status: "planned",
        },
      ],
    });
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.provider.apply.mockImplementation(async (_ctx, selectedPlan: MigrationPlan) => ({
      ...selectedPlan,
      summary: { ...selectedPlan.summary, planned: 0, migrated: 2 },
      items: selectedPlan.items.map((item) =>
        item.status === "planned" ? { ...item, status: "migrated" as const } : item,
      ),
    }));

    await migrateApplyCommand(runtime, { provider: "codex", yes: true, skills: ["alpha"] });

    const appliedPlan = firstAppliedPlan();
    expect(appliedPlan.summary.planned).toBe(2);
    expect(appliedPlan.summary.skipped).toBe(1);
    expect(appliedPlan.summary.conflicts).toBe(0);
    const itemsById = new Map(appliedPlan.items.map((item) => [item.id, item]));
    expect(itemsById.get("skill:alpha")?.status).toBe("planned");
    expect(itemsById.get("skill:beta")?.status).toBe("skipped");
    expect(itemsById.get("skill:beta")?.reason).toBe("not selected for migration");
    expect(mocks.backupCreateCommand).toHaveBeenCalled();
  });

  it("filters explicit Codex plugins before apply", async () => {
    const planned = codexPluginPlan();
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.provider.apply.mockImplementation(async (_ctx, selectedPlan: MigrationPlan) => ({
      ...selectedPlan,
      summary: { ...selectedPlan.summary, planned: 0, migrated: 2 },
      items: selectedPlan.items.map((item) =>
        item.status === "planned" ? { ...item, status: "migrated" as const } : item,
      ),
    }));

    await migrateApplyCommand(runtime, { provider: "codex", yes: true, plugins: ["gmail"] });

    const appliedPlan = firstAppliedPlan();
    expect(appliedPlan.summary.planned).toBe(2);
    expect(appliedPlan.summary.skipped).toBe(1);
    expect(appliedPlan.summary.conflicts).toBe(0);
    const itemsById = new Map(appliedPlan.items.map((item) => [item.id, item]));
    expect(itemsById.get("plugin:google-calendar")?.status).toBe("skipped");
    expect(itemsById.get("plugin:google-calendar")?.reason).toBe("not selected for migration");
    expect(itemsById.get("plugin:gmail")?.status).toBe("planned");
    expect(itemsById.get("config:codex-plugins")?.status).toBe("planned");
    expect(mocks.backupCreateCommand).toHaveBeenCalled();
  });

  it("creates a verified backup before applying a conflict-free migration", async () => {
    const planned = plan();
    const applied: MigrationApplyResult = {
      ...planned,
      summary: { ...planned.summary, planned: 0, migrated: 1 },
      items: planned.items.map((item) => ({ ...item, status: "migrated" })),
    };
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.provider.apply.mockResolvedValue(applied);

    const result = await migrateApplyCommand(runtime, { provider: "hermes", yes: true });

    const backupCall = mockCall(mocks.backupCreateCommand);
    expect(typeof (backupCall?.[0] as { log?: unknown } | undefined)?.log).toBe("function");
    expect(backupCall?.[1]).toStrictEqual({ output: undefined, verify: true });
    const applyContext = firstApplyContext();
    expect(applyContext.backupPath).toBe("/tmp/openclaw-backup.tgz");
    expect(String(applyContext.reportDir)).toContain("/migration/hermes/");
    expect(firstAppliedPlan()).toBe(planned);
    expect(result.backupPath).toBe("/tmp/openclaw-backup.tgz");
  });

  it("prints only the final result for root apply in JSON mode", async () => {
    const planned = plan({
      items: [
        {
          id: "config:mcp-servers",
          kind: "config",
          action: "merge",
          status: "planned",
          details: {
            value: {
              time: {
                env: { OPENAI_API_KEY: "short-dev-key" },
                headers: { "x-api-key": "another-short-dev-key" },
              },
            },
          },
        },
      ],
    });
    const applied: MigrationApplyResult = {
      ...planned,
      summary: { ...planned.summary, planned: 0, migrated: 1 },
      items: planned.items.map((item) => ({ ...item, status: "migrated" })),
    };
    const logs: string[] = [];
    const jsonRuntime: RuntimeEnv = {
      ...runtime,
      log(message) {
        logs.push(String(message));
      },
    };
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.provider.apply.mockResolvedValue(applied);

    await migrateDefaultCommand(jsonRuntime, { provider: "hermes", yes: true, json: true });

    expect(logs).toHaveLength(1);
    expect(mocks.withProgress).not.toHaveBeenCalled();
    const logPayload = JSON.parse(logs[0] ?? "{}") as {
      backupPath?: unknown;
      items?: Array<{
        details?: {
          value?: {
            time?: {
              env?: Record<string, unknown>;
              headers?: Record<string, unknown>;
            };
          };
        };
      }>;
      providerId?: unknown;
    };
    expect(logPayload.providerId).toBe("hermes");
    expect(logPayload.backupPath).toBe("/tmp/openclaw-backup.tgz");
    expect(logPayload.items?.[0]?.details?.value?.time?.env?.OPENAI_API_KEY).toBe("[redacted]");
    expect(logPayload.items?.[0]?.details?.value?.time?.headers?.["x-api-key"]).toBe("[redacted]");
    expect(logs[0]).not.toContain("short-dev-key");
    expect(logs[0]).not.toContain("another-short-dev-key");
    expect(logs[0]).not.toContain("Migration plan");
  });

  it("keeps provider info logs off stdout in JSON mode", async () => {
    const planned = plan();
    const applied: MigrationApplyResult = {
      ...planned,
      summary: { ...planned.summary, planned: 0, migrated: 1 },
      items: planned.items.map((item) => ({ ...item, status: "migrated" })),
    };
    const logs: string[] = [];
    const errors: string[] = [];
    const jsonRuntime: RuntimeEnv = {
      ...runtime,
      log(message) {
        logs.push(String(message));
      },
      error(message) {
        errors.push(String(message));
      },
    };
    mocks.provider.plan.mockImplementation(async (ctx) => {
      ctx.logger.info("provider planning");
      return planned;
    });
    mocks.provider.apply.mockImplementation(async (ctx) => {
      ctx.logger.info("provider applying");
      return applied;
    });

    await migrateDefaultCommand(jsonRuntime, { provider: "hermes", yes: true, json: true });

    expect(logs).toHaveLength(1);
    expect((JSON.parse(logs[0] ?? "{}") as { providerId?: unknown }).providerId).toBe("hermes");
    expect(errors).toEqual(["provider planning", "provider applying"]);
  });

  it("applies the already-reviewed default plan instead of planning again", async () => {
    const planned = plan();
    const applied: MigrationApplyResult = {
      ...planned,
      summary: { ...planned.summary, planned: 0, migrated: 1 },
      items: planned.items.map((item) => ({ ...item, status: "migrated" })),
    };
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.provider.apply.mockResolvedValue(applied);

    await migrateDefaultCommand(runtime, { provider: "hermes", yes: true });

    expect(mocks.provider.plan).toHaveBeenCalledTimes(1);
    expect(mocks.withProgress).toHaveBeenCalledTimes(2);
    expect(typeof firstApplyContext()).toBe("object");
    expect(firstAppliedPlan()).toBe(planned);
  });

  it("fails after writing JSON output when apply reports item errors", async () => {
    const planned = plan();
    const applied: MigrationApplyResult = {
      ...planned,
      summary: {
        ...planned.summary,
        planned: 0,
        errors: 1,
      },
      items: planned.items.map((item) => ({
        ...item,
        status: "error",
        reason: "copy failed",
      })),
    };
    const logs: string[] = [];
    const jsonRuntime: RuntimeEnv = {
      ...runtime,
      log(message) {
        logs.push(String(message));
      },
    };
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.provider.apply.mockResolvedValue(applied);

    await expect(
      migrateApplyCommand(jsonRuntime, { provider: "hermes", yes: true, json: true }),
    ).rejects.toThrow("Migration finished with 1 error");

    expect(logs).toHaveLength(1);
    const logPayload = JSON.parse(logs[0] ?? "{}") as {
      providerId?: unknown;
      reportDir?: unknown;
      summary?: { errors?: unknown };
    };
    expect(logPayload.providerId).toBe("hermes");
    expect(logPayload.summary?.errors).toBe(1);
    expect(String(logPayload.reportDir)).toContain("/migration/hermes/");
  });

  it("fails after writing JSON output when apply reports late conflicts", async () => {
    const planned = plan();
    const applied: MigrationApplyResult = {
      ...planned,
      summary: {
        ...planned.summary,
        planned: 0,
        conflicts: 1,
      },
      items: planned.items.map((item) => ({
        ...item,
        status: "conflict",
        reason: "target exists",
      })),
    };
    const logs: string[] = [];
    const jsonRuntime: RuntimeEnv = {
      ...runtime,
      log(message) {
        logs.push(String(message));
      },
    };
    mocks.provider.plan.mockResolvedValue(planned);
    mocks.provider.apply.mockResolvedValue(applied);

    await expect(
      migrateApplyCommand(jsonRuntime, { provider: "hermes", yes: true, json: true }),
    ).rejects.toThrow("Migration finished with 1 conflict");

    expect(logs).toHaveLength(1);
    const logPayload = JSON.parse(logs[0] ?? "{}") as {
      providerId?: unknown;
      reportDir?: unknown;
      summary?: { conflicts?: unknown };
    };
    expect(logPayload.providerId).toBe("hermes");
    expect(logPayload.summary?.conflicts).toBe(1);
    expect(String(logPayload.reportDir)).toContain("/migration/hermes/");
  });

  it("prints the dry-run plan in JSON mode even when --yes is set", async () => {
    const planned = plan();
    const logs: string[] = [];
    const jsonRuntime: RuntimeEnv = {
      ...runtime,
      log(message) {
        logs.push(String(message));
      },
    };
    mocks.provider.plan.mockResolvedValue(planned);

    await migrateDefaultCommand(jsonRuntime, {
      provider: "hermes",
      yes: true,
      dryRun: true,
      json: true,
    });

    expect(logs).toHaveLength(1);
    const logPayload = JSON.parse(logs[0] ?? "{}") as {
      providerId?: unknown;
      summary?: { planned?: unknown };
    };
    expect(logPayload.providerId).toBe("hermes");
    expect(logPayload.summary?.planned).toBe(1);
    expect(mocks.provider.apply).not.toHaveBeenCalled();
    expect(mocks.backupCreateCommand).not.toHaveBeenCalled();
  });

  it("includes provider warnings in JSON dry-run output", async () => {
    const warning = "Provider warning.";
    const planned = codexPluginPlan({ warnings: [warning] });
    const logs: string[] = [];
    const errors: string[] = [];
    const jsonRuntime: RuntimeEnv = {
      ...runtime,
      log(message) {
        logs.push(String(message));
      },
      error(message) {
        errors.push(String(message));
      },
    };
    mocks.provider.plan.mockResolvedValue(planned);

    await migrateDefaultCommand(jsonRuntime, {
      provider: "codex",
      dryRun: true,
      json: true,
    });

    expect(logs).toHaveLength(1);
    expect(errors).toEqual([]);
    const logPayload = JSON.parse(logs[0] ?? "{}") as { warnings?: unknown };
    expect(logPayload.warnings).toEqual([warning]);
  });
});
