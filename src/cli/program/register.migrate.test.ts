// Migrate CLI registration tests cover public option forwarding.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerMigrateCommand } from "./register.migrate.js";

const mocks = vi.hoisted(() => ({
  migrateApplyCommand: vi.fn(),
  migrateDefaultCommand: vi.fn(),
  migrateListCommand: vi.fn(),
  migratePlanCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../commands/migrate.js", () => ({
  migrateApplyCommand: mocks.migrateApplyCommand,
  migrateDefaultCommand: mocks.migrateDefaultCommand,
  migrateListCommand: mocks.migrateListCommand,
  migratePlanCommand: mocks.migratePlanCommand,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

async function runCli(args: string[]): Promise<void> {
  const program = new Command();
  registerMigrateCommand(program);
  await program.parseAsync(args, { from: "user" });
}

describe("registerMigrateCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.migrateApplyCommand.mockResolvedValue(undefined);
    mocks.migrateDefaultCommand.mockResolvedValue(undefined);
    mocks.migrateListCommand.mockResolvedValue(undefined);
    mocks.migratePlanCommand.mockResolvedValue(undefined);
  });

  it("forwards --agent through default, plan, and apply flows", async () => {
    await runCli(["migrate", "codex", "--agent", "research", "--item", "auth:openai", "--dry-run"]);
    expect(mocks.migrateDefaultCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({ targetAgentId: "research", itemIds: ["auth:openai"] }),
    );

    await runCli(["migrate", "plan", "codex", "--agent", "research", "--item", "auth:openai"]);
    expect(mocks.migratePlanCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({ targetAgentId: "research", itemIds: ["auth:openai"] }),
    );

    await runCli([
      "migrate",
      "apply",
      "codex",
      "--agent",
      "research",
      "--item",
      "auth:openai",
      "--yes",
    ]);
    expect(mocks.migrateApplyCommand).toHaveBeenCalledWith(
      mocks.runtime,
      expect.objectContaining({ targetAgentId: "research", itemIds: ["auth:openai"] }),
    );
  });
});
