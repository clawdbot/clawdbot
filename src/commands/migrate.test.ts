import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MigrationApplyResult, MigrationPlan } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  backupCreateCommand: vi.fn(),
  promptYesNo: vi.fn(),
  provider: {
    id: "hermes",
    label: "Hermes",
    plan: vi.fn(),
    apply: vi.fn(),
  },
}));

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

vi.mock("../plugins/migration-provider-runtime.js", () => ({
  resolvePluginMigrationProvider: () => mocks.provider,
  resolvePluginMigrationProviders: () => [mocks.provider],
}));

vi.mock("./backup.js", () => ({
  backupCreateCommand: mocks.backupCreateCommand,
}));

const { migrateApplyCommand, migrateDefaultCommand } = await import("./migrate.js");

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
    expect(mocks.provider.apply).toHaveBeenCalledWith(expect.any(Object), planned);
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
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      providerId: "hermes",
      summary: { planned: 1 },
      items: [
        {
          details: {
            value: {
              time: {
                env: { OPENAI_API_KEY: "[redacted]", SAFE_FLAG: "visible" },
                headers: { Authorization: "[redacted]" },
              },
            },
          },
        },
      ],
    });
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

    expect(mocks.backupCreateCommand).toHaveBeenCalledWith(
      expect.objectContaining({ log: expect.any(Function) }),
      { output: undefined, verify: true },
    );
    expect(mocks.provider.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        backupPath: "/tmp/openclaw-backup.tgz",
        reportDir: expect.stringContaining("/migration/hermes/"),
      }),
      planned,
    );
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
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      providerId: "hermes",
      backupPath: "/tmp/openclaw-backup.tgz",
      items: [
        {
          details: {
            value: {
              time: {
                env: { OPENAI_API_KEY: "[redacted]" },
                headers: { "x-api-key": "[redacted]" },
              },
            },
          },
        },
      ],
    });
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
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({ providerId: "hermes" });
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
    expect(mocks.provider.apply).toHaveBeenCalledWith(expect.any(Object), planned);
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
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      providerId: "hermes",
      summary: { errors: 1 },
      reportDir: expect.stringContaining("/migration/hermes/"),
    });
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
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      providerId: "hermes",
      summary: { conflicts: 1 },
      reportDir: expect.stringContaining("/migration/hermes/"),
    });
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
    expect(JSON.parse(logs[0] ?? "{}")).toMatchObject({
      providerId: "hermes",
      summary: { planned: 1 },
    });
    expect(mocks.provider.apply).not.toHaveBeenCalled();
    expect(mocks.backupCreateCommand).not.toHaveBeenCalled();
  });
});
