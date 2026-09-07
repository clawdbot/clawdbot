import fs from "node:fs/promises";
import path from "node:path";
// Gateway migration tests cover agent scoping, fresh plans, and exact item selection.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { MigrationPlan, MigrationProviderPlugin } from "../../plugins/types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const mocks = vi.hoisted(() => ({
  providers: [] as MigrationProviderPlugin[],
  runMigrationApply: vi.fn(),
}));

vi.mock("../../plugins/migration-provider-runtime.js", () => ({
  ensureStandaloneMigrationProviderRegistryLoaded: vi.fn(),
  resolvePluginMigrationProviders: vi.fn(() => mocks.providers),
}));

vi.mock("../../commands/migrate/apply.js", () => ({
  runMigrationApply: mocks.runMigrationApply,
}));

import { migrationsHandlers } from "./migrations.js";

type RespondCall = [
  boolean,
  unknown?,
  { code: number; message: string }?,
  Record<string, unknown>?,
];

function createConfig() {
  return {
    agents: {
      defaults: { workspace: "/tmp/workspace-main" },
      list: [
        { id: "main", default: true },
        { id: "research", workspace: "/tmp/workspace-research" },
      ],
    },
  } as never;
}

let config = createConfig();
let sourceRoot = "";
let dedupe: Map<string, { ts: number; ok: boolean; payload?: unknown }>;

function memoryPlan(): MigrationPlan {
  return {
    providerId: "codex",
    source: sourceRoot,
    target: "/tmp/workspace-research",
    summary: {
      total: 2,
      planned: 2,
      migrated: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      sensitive: 0,
    },
    items: [
      {
        id: "memory:one",
        kind: "memory",
        action: "copy",
        status: "planned",
        source: path.join(sourceRoot, "MEMORY.md"),
        target: "/tmp/workspace-research/memory/imports/codex/MEMORY.md",
      },
      {
        id: "workspace:ignored",
        kind: "workspace",
        action: "copy",
        status: "planned",
        source: path.join(sourceRoot, "AGENTS.md"),
        target: "/tmp/workspace-research/AGENTS.md",
      },
    ],
  };
}

function provider(plan = memoryPlan()): MigrationProviderPlugin {
  return {
    id: "codex",
    label: "Codex",
    supportedItemKinds: ["memory"],
    detect: vi.fn(async () => ({
      found: true,
      source: sourceRoot,
      confidence: "high" as const,
    })),
    plan: vi.fn(async (ctx) => {
      expect(ctx.targetAgentId).toBe("research");
      expect(ctx.itemKinds).toEqual(["memory"]);
      return plan;
    }),
    apply: vi.fn(),
  };
}

function invoke(method: keyof typeof migrationsHandlers, params: Record<string, unknown>) {
  const respond = vi.fn();
  const requestParams =
    method === "migrations.memory.apply" && !("idempotencyKey" in params)
      ? { idempotencyKey: "memory-import-test", ...params }
      : params;
  return {
    respond,
    run: async () =>
      await expectDefined(
        migrationsHandlers[method],
        `${method} handler test invariant`,
      )({
        params: requestParams,
        respond: respond as never,
        context: { getRuntimeConfig: () => config, dedupe } as never,
        client: null,
        req: { type: "req", id: "req-1", method },
        isWebchatConnect: () => false,
      }),
  };
}

function firstCall(respond: ReturnType<typeof vi.fn>): RespondCall {
  const call = respond.mock.calls[0] as RespondCall | undefined;
  if (!call) {
    throw new Error("expected gateway response");
  }
  return call;
}

async function loadPlanFingerprint(overwrite = false): Promise<string> {
  const request = invoke("migrations.memory.plan", {
    agentId: "research",
    ...(overwrite ? { overwrite: true } : {}),
  });
  await request.run();
  const [ok, rawResult] = firstCall(request.respond);
  expect(ok).toBe(true);
  const result = rawResult as {
    providers: Array<{ planFingerprint?: string }>;
  };
  const fingerprint = result.providers[0]?.planFingerprint;
  if (!fingerprint) {
    throw new Error("expected memory plan fingerprint");
  }
  return fingerprint;
}

describe("memory migration gateway handlers", () => {
  beforeEach(async () => {
    sourceRoot = tempDirs.make("openclaw-memory-gateway-");
    await fs.writeFile(path.join(sourceRoot, "MEMORY.md"), "reviewed memory", "utf8");
    config = createConfig();
    mocks.providers = [provider()];
    mocks.runMigrationApply.mockReset();
    dedupe = new Map();
  });

  it("returns memory-only plans for the selected agent", async () => {
    const request = invoke("migrations.memory.plan", { agentId: "research" });

    await request.run();

    const [ok, rawResult] = firstCall(request.respond);
    expect(ok).toBe(true);
    const result = rawResult as {
      agentId: string;
      workspace: string;
      providers: Array<{ items: Array<{ id: string }>; summary: { total: number } }>;
    };
    expect(result.agentId).toBe("research");
    expect(result.workspace).toBe("/tmp/workspace-research");
    expect(result.providers[0]?.items.map((item) => item.id)).toEqual(["memory:one"]);
    expect(result.providers[0]?.summary.total).toBe(1);
    expect(
      (result.providers[0] as { planFingerprint?: string } | undefined)?.planFingerprint,
    ).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("reports oversized provider plans instead of returning an unusable selection", async () => {
    const oversized = memoryPlan();
    oversized.items = Array.from({ length: 2001 }, (_, index) => ({
      ...oversized.items[0]!,
      id: `memory:${index}`,
    }));
    oversized.summary.total = oversized.items.length;
    oversized.summary.planned = oversized.items.length;
    mocks.providers = [provider(oversized)];
    const request = invoke("migrations.memory.plan", { agentId: "research" });

    await request.run();

    const [, rawResult] = firstCall(request.respond);
    const result = rawResult as {
      providers: Array<{ error?: string; items: unknown[] }>;
    };
    expect(result.providers[0]?.error).toContain("maximum is 2000");
    expect(result.providers[0]?.items).toEqual([]);
  });

  it("rejects an unknown destination agent", async () => {
    const request = invoke("migrations.memory.plan", { agentId: "missing" });

    await request.run();

    const [ok, , error] = firstCall(request.respond);
    expect(ok).toBe(false);
    expect(error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(error?.message).toContain("unknown agent id");
  });

  it("rejects a malformed destination agent before normalization", async () => {
    const request = invoke("migrations.memory.plan", { agentId: "research!!!" });

    await request.run();

    const [ok, , error] = firstCall(request.respond);
    expect(ok).toBe(false);
    expect(error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(error?.message).toContain("invalid agent id");
  });

  it("rejects apply when source bytes changed after preview", async () => {
    const planFingerprint = await loadPlanFingerprint();
    await fs.writeFile(path.join(sourceRoot, "MEMORY.md"), "changed memory", "utf8");
    const request = invoke("migrations.memory.apply", {
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:one"],
    });

    await request.run();

    const [ok, , error] = firstCall(request.respond);
    expect(ok).toBe(false);
    expect(error?.message).toContain("plan changed");
    expect(mocks.runMigrationApply).not.toHaveBeenCalled();
  });

  it("binds conflict source bytes when replacement is enabled", async () => {
    const plan = memoryPlan();
    plan.items[0]!.status = "conflict";
    plan.items[0]!.reason = "target exists";
    plan.summary = { ...plan.summary, planned: 1, conflicts: 1 };
    mocks.providers = [provider(plan)];
    const planFingerprint = await loadPlanFingerprint(true);
    await fs.writeFile(path.join(sourceRoot, "MEMORY.md"), "changed memory", "utf8");
    const request = invoke("migrations.memory.apply", {
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:one"],
      overwrite: true,
    });

    await request.run();

    const [ok, , error] = firstCall(request.respond);
    expect(ok).toBe(false);
    expect(error?.message).toContain("plan changed");
    expect(mocks.runMigrationApply).not.toHaveBeenCalled();
  });

  it("reports unsupported actionable memory operations during planning", async () => {
    const plan = memoryPlan();
    plan.items[0]!.action = "append";
    mocks.providers = [provider(plan)];
    const request = invoke("migrations.memory.plan", { agentId: "research" });

    await request.run();

    const [ok, rawResult] = firstCall(request.respond);
    expect(ok).toBe(true);
    expect(rawResult).toMatchObject({
      providers: [{ found: false, error: expect.stringContaining("only supports copy actions") }],
    });
  });

  it("rejects apply when an operation changed after preview", async () => {
    const plan = memoryPlan();
    mocks.providers = [provider(plan)];
    const planFingerprint = await loadPlanFingerprint();
    plan.items[0]!.action = "append";
    const request = invoke("migrations.memory.apply", {
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:one"],
    });

    await request.run();

    const [ok, , error] = firstCall(request.respond);
    expect(ok).toBe(false);
    expect(error?.message).toContain("only supports copy actions");
    expect(mocks.runMigrationApply).not.toHaveBeenCalled();
  });

  it.each([
    ["metadata", (plan: MigrationPlan) => (plan.metadata = { revision: "new" })],
    ["warnings", (plan: MigrationPlan) => (plan.warnings = ["updated warning"])],
    ["item message", (plan: MigrationPlan) => (plan.items[0]!.message = "updated message")],
  ])("rejects apply when plan %s changes after preview", async (_field, mutatePlan) => {
    const plan = memoryPlan();
    mocks.providers = [provider(plan)];
    const planFingerprint = await loadPlanFingerprint();
    mutatePlan(plan);
    const request = invoke("migrations.memory.apply", {
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:one"],
    });

    await request.run();

    const [ok, , error] = firstCall(request.respond);
    expect(ok).toBe(false);
    expect(error?.message).toContain("plan changed");
    expect(mocks.runMigrationApply).not.toHaveBeenCalled();
  });

  it("rejects stale item ids from a freshly rebuilt apply plan", async () => {
    const planFingerprint = await loadPlanFingerprint();
    const request = invoke("migrations.memory.apply", {
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:stale"],
    });

    await request.run();

    const [ok, , error] = firstCall(request.respond);
    expect(ok).toBe(false);
    expect(error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(error?.message).toContain("refresh the plan");
    expect(mocks.runMigrationApply).not.toHaveBeenCalled();
  });

  it("applies only the exact selected ids from the fresh plan", async () => {
    const applied = memoryPlan();
    applied.items = [applied.items[0]!];
    applied.summary.total = 1;
    mocks.runMigrationApply.mockResolvedValue(applied);
    const planFingerprint = await loadPlanFingerprint();
    const request = invoke("migrations.memory.apply", {
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:one"],
    });

    await request.run();

    expect(firstCall(request.respond)[0]).toBe(true);
    expect(mocks.runMigrationApply).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "codex",
        opts: expect.objectContaining({
          targetAgentId: "research",
          itemKinds: ["memory"],
          itemIds: ["memory:one"],
          allowPartialResult: true,
          preflightPlan: expect.objectContaining({ providerId: "codex" }),
        }),
      }),
    );
  });

  it("replays a completed import when its idempotency key is retried", async () => {
    const applied = memoryPlan();
    applied.items = [applied.items[0]!];
    applied.summary.total = 1;
    mocks.runMigrationApply.mockResolvedValue(applied);
    const planFingerprint = await loadPlanFingerprint();
    const params = {
      idempotencyKey: "memory-import-retry",
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:one"],
    };
    const first = invoke("migrations.memory.apply", params);
    await first.run();
    await fs.writeFile(path.join(sourceRoot, "MEMORY.md"), "changed after import", "utf8");
    const retry = invoke("migrations.memory.apply", params);

    await retry.run();

    expect(firstCall(first.respond)[0]).toBe(true);
    expect(firstCall(retry.respond)[0]).toBe(true);
    expect(firstCall(retry.respond)[3]).toEqual({ cached: true });
    expect(mocks.runMigrationApply).toHaveBeenCalledOnce();
  });

  it("joins identical in-flight retries and rejects mismatched key reuse", async () => {
    const applied = memoryPlan();
    applied.items = [applied.items[0]!];
    applied.summary.total = 1;
    let finishApply!: (result: MigrationPlan) => void;
    mocks.runMigrationApply.mockImplementation(
      async () =>
        await new Promise<MigrationPlan>((resolve) => {
          finishApply = resolve;
        }),
    );
    const planFingerprint = await loadPlanFingerprint();
    const params = {
      idempotencyKey: "memory-import-in-flight",
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:one"],
    };
    const first = invoke("migrations.memory.apply", params);
    const firstRun = first.run();
    await vi.waitFor(() => expect(mocks.runMigrationApply).toHaveBeenCalledOnce());

    const mismatched = invoke("migrations.memory.apply", {
      ...params,
      itemIds: ["memory:other"],
    });
    await mismatched.run();
    expect(firstCall(mismatched.respond)[2]?.message).toContain("idempotency key was reused");

    const retry = invoke("migrations.memory.apply", params);
    const retryRun = retry.run();
    await Promise.resolve();
    expect(retry.respond).not.toHaveBeenCalled();
    finishApply(applied);
    await Promise.all([firstRun, retryRun]);

    expect(firstCall(first.respond)[0]).toBe(true);
    expect(firstCall(retry.respond)[0]).toBe(true);
    expect(firstCall(retry.respond)[3]).toEqual({ cached: true });
    expect(mocks.runMigrationApply).toHaveBeenCalledOnce();
  });

  it("rejects an idempotency key reused for a different import", async () => {
    const applied = memoryPlan();
    applied.items = [applied.items[0]!];
    applied.summary.total = 1;
    mocks.runMigrationApply.mockResolvedValue(applied);
    const planFingerprint = await loadPlanFingerprint();
    const first = invoke("migrations.memory.apply", {
      idempotencyKey: "memory-import-reused",
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:one"],
    });
    await first.run();
    const reused = invoke("migrations.memory.apply", {
      idempotencyKey: "memory-import-reused",
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:other"],
    });

    await reused.run();

    const [ok, , error] = firstCall(reused.respond);
    expect(ok).toBe(false);
    expect(error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(error?.message).toContain("idempotency key was reused");
    expect(mocks.runMigrationApply).toHaveBeenCalledOnce();
  });

  it("returns partial failures and recovery metadata to the Control UI", async () => {
    const applied = { ...memoryPlan(), reportDir: "/tmp/migration-report" };
    applied.items = [
      {
        ...applied.items[0]!,
        status: "error",
        reason: "copy failed",
        details: { recoveryPath: "/tmp/staged-memory" },
      },
    ];
    applied.summary = { ...applied.summary, total: 1, planned: 0, errors: 1 };
    mocks.runMigrationApply.mockResolvedValue(applied);
    const planFingerprint = await loadPlanFingerprint();
    const request = invoke("migrations.memory.apply", {
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:one"],
    });

    await request.run();

    const [ok, rawResult] = firstCall(request.respond);
    expect(ok).toBe(true);
    expect(rawResult).toMatchObject({
      reportDir: "/tmp/migration-report",
      summary: { errors: 1 },
      items: [{ details: { recoveryPath: "/tmp/staged-memory" } }],
    });
  });

  it("rejects apply when the selected agent workspace changed after preview", async () => {
    const planFingerprint = await loadPlanFingerprint();
    const mutableConfig = config as {
      agents: { list: Array<{ id: string; workspace?: string }> };
    };
    const research = mutableConfig.agents.list.find((agent) => agent.id === "research");
    if (!research) {
      throw new Error("expected research agent");
    }
    research.workspace = "/tmp/workspace-research-moved";

    const request = invoke("migrations.memory.apply", {
      agentId: "research",
      providerId: "codex",
      planFingerprint,
      itemIds: ["memory:one"],
    });
    await request.run();

    const [ok, , error] = firstCall(request.respond);
    expect(ok).toBe(false);
    expect(error?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(error?.message).toContain("plan changed");
    expect(mocks.runMigrationApply).not.toHaveBeenCalled();
  });
});
