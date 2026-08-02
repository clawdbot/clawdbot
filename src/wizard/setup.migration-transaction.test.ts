// Transactional onboarding migration tests exercise the classic full-import caller.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeMigrationItems } from "../plugin-sdk/migration.js";
import type {
  MigrationApplyResult,
  MigrationConfigRuntime,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
} from "../plugins/types.js";
import { WizardCancelledError, type WizardPrompter } from "./prompts.js";

const mocks = vi.hoisted(() => ({
  canonicalMutateConfigFile: vi.fn(),
  currentConfig: undefined as { value: Record<string, unknown> } | undefined,
  provider: undefined as MigrationProviderPlugin | undefined,
  verify: vi.fn(),
}));

vi.mock("../plugins/migration-provider-runtime.js", () => ({
  ensureStandaloneMigrationProviderRegistryLoaded: vi.fn(),
  resolvePluginMigrationProvider: () => mocks.provider,
  resolvePluginMigrationProviders: () => (mocks.provider ? [mocks.provider] : []),
}));

vi.mock("./setup.inference-verification.js", () => ({
  offerLiveModelVerification: mocks.verify,
}));

vi.mock("../config/mutate.js", () => ({
  mutateConfigFile: mocks.canonicalMutateConfigFile,
}));

import { runSetupMigrationImport } from "./setup.migration-import.js";

const tempRoots = new Set<string>();
let previousStateDir: string | undefined;

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-migration-transaction-"));
  tempRoots.add(root);
  return root;
}

function runtime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
  };
}

function prompter(): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    confirm: vi.fn(async () => true),
    select: vi.fn(async () => "claude") as WizardPrompter["select"],
    multiselect: vi.fn(async () => []) as WizardPrompter["multiselect"],
    text: vi.fn(async () => "") as WizardPrompter["text"],
    progress: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
  } as WizardPrompter;
}

function provider(params: {
  source: string;
  mutateDuringApply?: () => Promise<void>;
  importModel?: boolean;
  deferred?: boolean;
  retrySafeDeferred?: boolean;
  deferredItemIds?: string[];
  onDeferredApply?: (
    itemId: string,
    ctx: MigrationProviderContext,
  ) => Promise<"already-satisfied" | "error" | "migrated">;
}): MigrationProviderPlugin {
  return {
    id: "claude",
    label: "Claude",
    ...(params.deferred && params.retrySafeDeferred !== false
      ? { deferredApply: { retrySafe: true as const } }
      : {}),
    async plan(ctx) {
      const workspace = ctx.config.agents?.defaults?.workspace;
      if (!workspace) {
        throw new Error("missing workspace");
      }
      const items: MigrationPlan["items"] = [
        {
          id: "workspace:memory",
          kind: "memory",
          action: "copy",
          status: "planned",
          source: params.source,
          target: path.join(workspace, "MEMORY.md"),
        },
      ];
      if (params.deferred) {
        for (const itemId of params.deferredItemIds ?? ["plugin:calendar"]) {
          items.push({
            id: itemId,
            kind: "plugin",
            action: "install",
            status: "planned",
            applyPhase: "after-promotion",
            target: `plugins.entries.codex.config.codexPlugins.plugins.${itemId}`,
          });
        }
      }
      return {
        providerId: "claude",
        source: params.source,
        target: workspace,
        items,
        summary: summarizeMigrationItems(items),
      };
    },
    async apply(ctx, plan): Promise<MigrationApplyResult> {
      if (!plan) {
        throw new Error("missing plan");
      }
      const items: MigrationItem[] = [];
      for (const item of plan.items) {
        if (item.status !== "planned") {
          items.push(item);
          continue;
        }
        if (item.id === "workspace:memory") {
          await fs.mkdir(path.dirname(item.target!), { recursive: true });
          await fs.copyFile(item.source!, item.target!);
          items.push({ ...item, status: "migrated" as const });
          continue;
        }
        if (item.applyPhase === "after-promotion") {
          const status = (await params.onDeferredApply?.(item.id, ctx)) ?? "error";
          items.push(
            status === "already-satisfied"
              ? {
                  ...item,
                  status: "skipped",
                  deferredCompletion: true,
                  reason: "already satisfied",
                }
              : status === "migrated"
                ? { ...item, status }
                : { ...item, status, reason: "activation failed" },
          );
          continue;
        }
        items.push(item);
      }
      if (params.importModel) {
        const configRuntime = ctx.configRuntime;
        if (!configRuntime) {
          throw new Error("missing staged config runtime");
        }
        await configRuntime.mutateConfigFile({
          base: "runtime",
          afterWrite: { mode: "none", reason: "staged migration test" },
          mutate(draft) {
            draft.agents ??= {};
            draft.agents.defaults ??= {};
            draft.agents.defaults.model = { primary: "openai/gpt-5.6-sol" };
          },
        });
      }
      await params.mutateDuringApply?.();
      return {
        ...plan,
        items,
        summary: summarizeMigrationItems(items),
        reportDir: ctx.reportDir,
      };
    },
  };
}

async function runImport(params: {
  root: string;
  source: string;
  currentConfig: { value: Record<string, unknown> };
  commit?: (
    config: Record<string, unknown>,
    expectedConfig: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
}) {
  const workspace = path.join(params.root, "workspace");
  mocks.currentConfig = params.currentConfig;
  process.env.OPENCLAW_STATE_DIR = path.join(params.root, "openclaw-state");
  return await runSetupMigrationImport({
    opts: {
      importFrom: "claude",
      importSource: params.source,
      nonInteractive: true,
      workspace,
    },
    baseConfig: {},
    detections: [],
    prompter: prompter(),
    runtime: runtime(),
    readConfigFile: async () => structuredClone(params.currentConfig.value),
    commitConfigFile: async (config, expectedConfig) => {
      const committed = params.commit
        ? await params.commit(
            config as Record<string, unknown>,
            expectedConfig as Record<string, unknown>,
          )
        : config;
      params.currentConfig.value = structuredClone(committed as Record<string, unknown>);
      return committed;
    },
    continueOnboarding: true,
  });
}

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  mocks.currentConfig = undefined;
  mocks.canonicalMutateConfigFile.mockReset();
  mocks.canonicalMutateConfigFile.mockImplementation(
    async (mutation: Parameters<MigrationConfigRuntime["mutateConfigFile"]>[0]) => {
      if (!mocks.currentConfig) {
        throw new Error("missing current config fixture");
      }
      const draft = structuredClone(mocks.currentConfig.value);
      const result = await mutation.mutate(draft, {
        snapshot: {} as never,
        previousHash: "fixture-hash",
      });
      mocks.currentConfig.value = structuredClone(draft);
      return {
        nextConfig: draft,
        result,
        path: "<canonical-config-runtime>",
        previousHash: "fixture-hash",
        snapshot: {} as never,
        persistedHash: "fixture-next-hash",
        afterWrite: mutation.afterWrite,
        followUp: { mode: "none", reason: "fixture", requiresRestart: false },
      };
    },
  );
  mocks.verify.mockReset();
  mocks.verify.mockResolvedValue({
    config: {},
    verified: true,
    modelRef: "openai/gpt-5.6-sol",
  });
});

afterEach(async () => {
  const [{ closeOpenClawAgentDatabasesForTest }, { closeOpenClawStateDatabaseForTest }] =
    await Promise.all([
      import("../state/openclaw-agent-db.js"),
      import("../state/openclaw-state-db.js"),
    ]);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  mocks.provider = undefined;
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  for (const root of tempRoots) {
    await fs.rm(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe("transactional setup migration import", () => {
  it("promotes a Claude import with no model and returns no imported inference", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "source-memory.md");
    await fs.writeFile(source, "remember this\n", "utf8");
    mocks.provider = provider({ source });
    const currentConfig = { value: {} };

    const outcome = await runImport({ root, source, currentConfig });

    expect(outcome).toEqual({ kind: "no-imported-inference" });
    expect(await fs.readFile(path.join(root, "workspace", "MEMORY.md"), "utf8")).toBe(
      "remember this\n",
    );
    expect(JSON.stringify(currentConfig.value)).not.toContain(".openclaw-migration-");
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("rejects deferred activation from providers without a retry-safe contract", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "source-memory.md");
    await fs.writeFile(source, "remember this\n", "utf8");
    mocks.provider = provider({ source, deferred: true, retrySafeDeferred: false });
    const currentConfig = { value: {} };

    await expect(runImport({ root, source, currentConfig })).rejects.toThrow(
      "does not declare retry-safe deferred apply",
    );
    await expect(fs.access(path.join(root, "workspace", "MEMORY.md"))).rejects.toThrow();
    expect(currentConfig.value).toEqual({});
  });

  it("accepts an already-satisfied retry-safe deferred effect as complete", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "source-memory.md");
    await fs.writeFile(source, "remember this\n", "utf8");
    mocks.provider = provider({
      source,
      deferred: true,
      onDeferredApply: async () => "already-satisfied",
    });
    const currentConfig = { value: {} };

    await expect(runImport({ root, source, currentConfig })).resolves.toEqual({
      kind: "no-imported-inference",
    });

    const reportRoot = path.join(root, "openclaw-state", "migration", "claude");
    const [reportDir] = await fs.readdir(reportRoot);
    const report = JSON.parse(
      await fs.readFile(path.join(reportRoot, reportDir!, "report.json"), "utf8"),
    ) as MigrationApplyResult;
    expect(report.items.find((item) => item.id === "plugin:calendar")).toMatchObject({
      status: "skipped",
      deferredCompletion: true,
    });
    const journal = JSON.parse(
      await fs.readFile(path.join(reportRoot, reportDir!, "onboarding-promotion.json"), "utf8"),
    ) as { status: string };
    expect(journal.status).toBe("completed");
  });

  it("leaves the live target untouched when imported inference verification fails", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "source-memory.md");
    await fs.writeFile(source, "remember this\n", "utf8");
    mocks.provider = provider({ source, importModel: true });
    mocks.verify.mockRejectedValueOnce(new Error("verification failed"));
    const currentConfig = { value: {} };

    await expect(runImport({ root, source, currentConfig })).rejects.toThrow("verification failed");

    await expect(fs.access(path.join(root, "workspace", "MEMORY.md"))).rejects.toThrow();
    expect(currentConfig.value).toEqual({});
  });

  it("leaves the live target untouched when imported inference repair is cancelled", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "source-memory.md");
    await fs.writeFile(source, "remember this\n", "utf8");
    mocks.provider = provider({ source, importModel: true });
    mocks.verify.mockRejectedValueOnce(new WizardCancelledError("cancelled"));
    const currentConfig = { value: {} };

    await expect(runImport({ root, source, currentConfig })).rejects.toBeInstanceOf(
      WizardCancelledError,
    );
    await expect(fs.access(path.join(root, "workspace", "MEMORY.md"))).rejects.toThrow();
    expect(currentConfig.value).toEqual({});
  });

  it("aborts promotion when the source changes after staged apply", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "source-memory.md");
    await fs.writeFile(source, "before\n", "utf8");
    mocks.provider = provider({
      source,
      mutateDuringApply: async () => {
        await fs.appendFile(source, "after\n", "utf8");
      },
    });
    const currentConfig = { value: {} };

    await expect(runImport({ root, source, currentConfig })).rejects.toThrow(
      "Migration source changed before promotion",
    );
    await expect(fs.access(path.join(root, "workspace", "MEMORY.md"))).rejects.toThrow();
    expect(currentConfig.value).toEqual({});
  });

  it("aborts promotion when config changes during staged apply", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "source-memory.md");
    await fs.writeFile(source, "remember this\n", "utf8");
    const currentConfig = { value: {} };
    mocks.provider = provider({
      source,
      mutateDuringApply: async () => {
        currentConfig.value = { gateway: { port: 23456 } };
      },
    });

    await expect(runImport({ root, source, currentConfig })).rejects.toThrow(
      "Migration target changed before promotion",
    );
    await expect(fs.access(path.join(root, "workspace", "MEMORY.md"))).rejects.toThrow();
  });

  it("runs deferred activation only after promotion and keeps failures as warnings", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "source-memory.md");
    await fs.writeFile(source, "remember this\n", "utf8");
    const liveMemory = path.join(root, "workspace", "MEMORY.md");
    let deferredCalls = 0;
    mocks.provider = provider({
      source,
      deferred: true,
      onDeferredApply: async () => {
        deferredCalls += 1;
        expect(await fs.readFile(liveMemory, "utf8")).toBe("remember this\n");
        return "error";
      },
    });
    const currentConfig = { value: {} };

    await expect(runImport({ root, source, currentConfig })).resolves.toEqual({
      kind: "no-imported-inference",
    });

    expect(deferredCalls).toBe(1);
    const reportRoot = path.join(root, "openclaw-state", "migration", "claude");
    const [reportDir] = await fs.readdir(reportRoot);
    const report = JSON.parse(
      await fs.readFile(path.join(reportRoot, reportDir!, "report.json"), "utf8"),
    ) as MigrationApplyResult;
    expect(report.items.filter((item) => item.id === "plugin:calendar")).toHaveLength(1);
    expect(report.items.find((item) => item.id === "plugin:calendar")?.status).toBe("warning");
    expect(report.warnings?.join("\n")).toContain(
      "Retry only those steps with openclaw onboard --flow import --import-from claude",
    );
    expect(JSON.stringify(report)).not.toContain(".openclaw-migration-");
  });

  it("routes deferred config writes through the canonical runtime", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "source-memory.md");
    await fs.writeFile(source, "remember this\n", "utf8");
    mocks.provider = provider({
      source,
      deferred: true,
      onDeferredApply: async (_itemId, ctx) => {
        await ctx.configRuntime?.mutateConfigFile({
          base: "runtime",
          afterWrite: { mode: "none", reason: "migration activation test" },
          mutate(draft) {
            draft.gateway = { ...draft.gateway, port: 23456 };
          },
        });
        return "migrated";
      },
    });
    const currentConfig = { value: {} };

    await runImport({ root, source, currentConfig });

    expect(mocks.canonicalMutateConfigFile).toHaveBeenCalledOnce();
    expect(currentConfig.value).toMatchObject({ gateway: { port: 23456 } });
  });

  it("resumes only deferred activation after promotion without rerunning the import", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "source-memory.md");
    await fs.writeFile(source, "remember this\n", "utf8");
    let planCalls = 0;
    let deferredCalls = 0;
    const providerWithDeferredRetry = provider({
      source,
      deferred: true,
      onDeferredApply: async () => {
        deferredCalls += 1;
        return deferredCalls === 1 ? "error" : "migrated";
      },
    });
    const originalPlan = providerWithDeferredRetry.plan;
    providerWithDeferredRetry.plan = async (ctx) => {
      planCalls += 1;
      return await originalPlan(ctx);
    };
    mocks.provider = providerWithDeferredRetry;
    const currentConfig = { value: {} };

    await expect(runImport({ root, source, currentConfig })).resolves.toEqual({
      kind: "no-imported-inference",
    });
    await expect(runImport({ root, source, currentConfig })).resolves.toEqual({
      kind: "no-imported-inference",
    });

    expect(planCalls).toBe(1);
    expect(deferredCalls).toBe(2);
    expect(await fs.readFile(path.join(root, "workspace", "MEMORY.md"), "utf8")).toBe(
      "remember this\n",
    );
    const reportRoot = path.join(root, "openclaw-state", "migration", "claude");
    const [reportDir] = await fs.readdir(reportRoot);
    const report = JSON.parse(
      await fs.readFile(path.join(reportRoot, reportDir!, "report.json"), "utf8"),
    ) as MigrationApplyResult;
    expect(report.items.find((item) => item.id === "plugin:calendar")?.status).toBe("migrated");
    const journal = JSON.parse(
      await fs.readFile(path.join(reportRoot, reportDir!, "onboarding-promotion.json"), "utf8"),
    ) as { status: string };
    expect(journal.status).toBe("completed");
  });

  it("retries only deferred items that did not already activate", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "source-memory.md");
    await fs.writeFile(source, "remember this\n", "utf8");
    const activationCalls: string[] = [];
    mocks.provider = provider({
      source,
      deferred: true,
      deferredItemIds: ["plugin:calendar", "plugin:drive"],
      onDeferredApply: async (itemId) => {
        activationCalls.push(itemId);
        return itemId === "plugin:calendar" ? "migrated" : "error";
      },
    });
    const currentConfig = { value: {} };

    await runImport({ root, source, currentConfig });
    mocks.provider = provider({
      source,
      deferred: true,
      deferredItemIds: ["plugin:calendar", "plugin:drive"],
      onDeferredApply: async (itemId) => {
        activationCalls.push(itemId);
        return "migrated";
      },
    });
    await runImport({ root, source, currentConfig });

    expect(activationCalls).toEqual(["plugin:calendar", "plugin:drive", "plugin:drive"]);
    const reportRoot = path.join(root, "openclaw-state", "migration", "claude");
    const [reportDir] = await fs.readdir(reportRoot);
    const report = JSON.parse(
      await fs.readFile(path.join(reportRoot, reportDir!, "report.json"), "utf8"),
    ) as MigrationApplyResult;
    expect(report.items.find((item) => item.id === "plugin:calendar")?.status).toBe("migrated");
    expect(report.items.find((item) => item.id === "plugin:drive")?.status).toBe("migrated");
    expect(report.warnings?.join("\n")).not.toContain("Retry only those steps");
  });
});
