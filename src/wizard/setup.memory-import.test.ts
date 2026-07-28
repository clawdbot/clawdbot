import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  MigrationApplyResult,
  MigrationPlan,
  MigrationProviderPlugin,
} from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";

const mocks = vi.hoisted(() => ({
  providers: [] as MigrationProviderPlugin[],
  planProviderMemoryImport: vi.fn(),
  applyProviderMemoryImport: vi.fn(),
}));

vi.mock("../commands/migrate/memory-import.js", () => ({
  listMemoryMigrationProviders: () => mocks.providers,
  planProviderMemoryImport: mocks.planProviderMemoryImport,
  applyProviderMemoryImport: mocks.applyProviderMemoryImport,
}));

import { runSetupMemoryImportStep } from "./setup.memory-import.js";

const config: OpenClawConfig = {
  agents: {
    defaults: { workspace: "/tmp/openclaw-memory-step" },
    list: [{ id: "main", default: true }],
  },
};

function runtime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() as never };
}

function provider(id: string, label = id): MigrationProviderPlugin {
  return {
    id,
    label,
    supportedItemKinds: ["memory"],
    plan: vi.fn(),
    apply: vi.fn(),
  };
}

function planFor(
  providerId: string,
  options: { planned?: string[]; conflicts?: string[] } = {},
): MigrationPlan {
  const planned = options.planned ?? [`memory:${providerId}:one`];
  const conflicts = options.conflicts ?? [];
  const items: MigrationPlan["items"] = [
    ...planned.map((id) => ({
      id,
      kind: "memory" as const,
      action: "copy" as const,
      status: "planned" as const,
      source: `/source/${providerId}/${id}.md`,
      target: `/tmp/openclaw-memory-step/memory/imports/${providerId}/${id}.md`,
    })),
    ...conflicts.map((id) => ({
      id,
      kind: "memory" as const,
      action: "copy" as const,
      status: "conflict" as const,
      source: `/source/${providerId}/${id}.md`,
      target: `/tmp/openclaw-memory-step/memory/imports/${providerId}/${id}.md`,
    })),
  ];
  return {
    providerId,
    source: `/source/${providerId}`,
    target: "/tmp/openclaw-memory-step",
    items,
    summary: {
      total: items.length,
      planned: planned.length,
      migrated: 0,
      skipped: 0,
      conflicts: conflicts.length,
      errors: 0,
      sensitive: 0,
    },
  };
}

function applied(plan: MigrationPlan): MigrationApplyResult {
  return {
    ...plan,
    items: plan.items.map((item) => ({ ...item, status: "migrated" as const })),
    summary: {
      ...plan.summary,
      planned: 0,
      migrated: plan.summary.planned,
      skipped: plan.summary.conflicts,
      conflicts: 0,
    },
  };
}

describe("runSetupMemoryImportStep", () => {
  beforeEach(() => {
    mocks.providers = [];
    mocks.planProviderMemoryImport.mockReset();
    mocks.applyProviderMemoryImport.mockReset();
  });

  it("shows no prompts when no memory providers are available", async () => {
    const prompter = createWizardPrompter();

    await runSetupMemoryImportStep({ config, prompter, runtime: runtime() });

    expect(prompter.note).not.toHaveBeenCalled();
    expect(prompter.confirm).not.toHaveBeenCalled();
  });

  it("shows no prompts when providers have no planned memory items", async () => {
    const codex = provider("codex", "Codex");
    mocks.providers = [codex];
    mocks.planProviderMemoryImport.mockResolvedValue({
      detection: { found: true, source: "/source/codex" },
      plan: planFor("codex", { planned: [], conflicts: ["memory:existing"] }),
    });
    const prompter = createWizardPrompter();

    await runSetupMemoryImportStep({ config, prompter, runtime: runtime() });

    expect(prompter.note).not.toHaveBeenCalled();
    expect(prompter.confirm).not.toHaveBeenCalled();
  });

  it("does not apply when a single-provider import is declined", async () => {
    const codex = provider("codex", "Codex");
    mocks.providers = [codex];
    mocks.planProviderMemoryImport.mockResolvedValue({
      detection: { found: true, source: "/source/codex" },
      plan: planFor("codex"),
    });
    const prompter = createWizardPrompter({ confirm: vi.fn(async () => false) });

    await runSetupMemoryImportStep({ config, prompter, runtime: runtime() });

    expect(mocks.applyProviderMemoryImport).not.toHaveBeenCalled();
    expect(prompter.multiselect).not.toHaveBeenCalled();
    const notes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    // The skip hint must not suggest `openclaw migrate <id>`: that command runs
    // the full provider migration, not a memory-only retry.
    expect(notes).toContain("Memory import page");
    expect(notes).not.toContain("openclaw migrate");
  });

  it("applies only the selected providers with exact planned item ids", async () => {
    const codex = provider("codex", "Codex");
    const claude = provider("claude", "Claude");
    const codexPlan = planFor("codex", { planned: ["memory:codex:one", "memory:codex:two"] });
    const claudePlan = planFor("claude");
    mocks.providers = [codex, claude];
    mocks.planProviderMemoryImport.mockImplementation(async ({ provider: selectedProvider }) => {
      const plan = selectedProvider.id === "codex" ? codexPlan : claudePlan;
      return { detection: { found: true, source: plan.source }, plan };
    });
    mocks.applyProviderMemoryImport.mockImplementation(async ({ preflightPlan }) =>
      applied(preflightPlan),
    );
    const multiselect = vi.fn(async () => ["codex"]) as WizardPrompter["multiselect"];
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => true),
      multiselect,
      disableBackNavigation: vi.fn(),
    });

    await runSetupMemoryImportStep({ config, prompter, runtime: runtime() });

    expect(multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ initialValues: ["codex", "claude"] }),
    );
    expect(mocks.applyProviderMemoryImport).toHaveBeenCalledOnce();
    expect(mocks.applyProviderMemoryImport).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: codex,
        agentId: "main",
        itemIds: ["memory:codex:one", "memory:codex:two"],
        preflightPlan: codexPlan,
      }),
    );
  });

  it("continues applying remaining providers after one fails", async () => {
    const codex = provider("codex", "Codex");
    const claude = provider("claude", "Claude");
    mocks.providers = [codex, claude];
    mocks.planProviderMemoryImport.mockImplementation(async ({ provider: selectedProvider }) => {
      const plan = planFor(selectedProvider.id);
      return { detection: { found: true, source: plan.source }, plan };
    });
    mocks.applyProviderMemoryImport
      .mockRejectedValueOnce(new Error("copy unavailable"))
      .mockImplementationOnce(async ({ preflightPlan }) => applied(preflightPlan));
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => true),
      multiselect: vi.fn(async () => ["codex", "claude"]) as WizardPrompter["multiselect"],
    });

    await expect(
      runSetupMemoryImportStep({ config, prompter, runtime: runtime() }),
    ).resolves.toBeUndefined();

    expect(mocks.applyProviderMemoryImport).toHaveBeenCalledTimes(2);
    const notes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    expect(notes).toContain("copy unavailable");
    expect(notes).toContain("Claude: 1 migrated");
  });

  it("surfaces conflict counts in the offer", async () => {
    const hermes = provider("hermes", "Hermes");
    mocks.providers = [hermes];
    mocks.planProviderMemoryImport.mockResolvedValue({
      detection: { found: true, source: "/source/hermes" },
      plan: planFor("hermes", {
        planned: ["memory:new"],
        conflicts: ["memory:old-one", "memory:old-two"],
      }),
    });
    const prompter = createWizardPrompter({ confirm: vi.fn(async () => false) });

    await runSetupMemoryImportStep({ config, prompter, runtime: runtime() });

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("2 already imported"),
      "Memories found",
    );
  });
});
