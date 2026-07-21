import { beforeEach, describe, expect, it, vi } from "vitest";
import { FsSafeError } from "../infra/fs-safe.js";

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  persisted: {} as Record<string, unknown>,
  transformConfigFileWithRetry: vi.fn(),
  withConfigMutationExclusive: vi.fn(),
  parseBindingSpecs: vi.fn(),
  ensureAgentWorkspace: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveAgentDir: vi.fn(),
  rootRead: vi.fn(),
  rootWrite: vi.fn(),
  mkdir: vi.fn(),
  readAgentDeletionJournal: vi.fn(() => undefined as Record<string, unknown> | undefined),
  claimCompletedAgentDeletion: vi.fn(() => true),
  maybeRepairAgentRoster: vi.fn(
    (config: Record<string, unknown>): { config: Record<string, unknown>; changes: string[] } => ({
      config,
      changes: [],
    }),
  ),
  completeLegacyMainFirstAgentDefaultIntent: vi.fn(),
  claimLegacyMainFirstAgentDefaultIntent: vi.fn((_agentId: string) => false),
  hasPendingLegacyMainFirstAgentDefaultIntent: vi.fn((_agentId?: string) => false),
  isLegacyImplicitMainOnlyRoster: vi.fn((_config: Record<string, unknown>) => false),
  migrateLegacyMainSessionStateOrThrow: vi.fn(async () => ({ changed: false })),
  readPendingLegacyMainFirstAgentDefaultIntent: vi.fn(() => undefined as string | undefined),
  reconcileLegacyMainFirstAgentDefaultIntent: vi.fn(),
  releaseLegacyMainFirstAgentDefaultIntent: vi.fn((_agentId: string) => {}),
  recordLegacyMainFirstAgentDefaultIntent: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ default: { mkdir: mocks.mkdir } }));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    transformConfigFileWithRetry: mocks.transformConfigFileWithRetry,
    withConfigMutationExclusive: mocks.withConfigMutationExclusive,
  };
});

vi.mock("../commands/agents.bindings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/agents.bindings.js")>()),
  parseBindingSpecs: mocks.parseBindingSpecs,
}));

vi.mock("./agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-scope.js")>()),
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  resolveAgentDir: mocks.resolveAgentDir,
}));

vi.mock("./agent-lifecycle-registry.js", () => ({
  claimCompletedAgentDeletion: mocks.claimCompletedAgentDeletion,
}));

vi.mock("../state/agent-deletion-journal.js", () => ({
  readAgentDeletionJournal: mocks.readAgentDeletionJournal,
}));

vi.mock("../commands/doctor/shared/agent-roster-repair.js", () => ({
  maybeRepairAgentRoster: mocks.maybeRepairAgentRoster,
}));

vi.mock("../commands/doctor/shared/legacy-main-session-migration.js", () => ({
  claimLegacyMainFirstAgentDefaultIntent: mocks.claimLegacyMainFirstAgentDefaultIntent,
  completeLegacyMainFirstAgentDefaultIntent: mocks.completeLegacyMainFirstAgentDefaultIntent,
  hasPendingLegacyMainFirstAgentDefaultIntent: mocks.hasPendingLegacyMainFirstAgentDefaultIntent,
  isLegacyImplicitMainOnlyRoster: mocks.isLegacyImplicitMainOnlyRoster,
  migrateLegacyMainSessionStateOrThrow: mocks.migrateLegacyMainSessionStateOrThrow,
  readPendingLegacyMainFirstAgentDefaultIntent: mocks.readPendingLegacyMainFirstAgentDefaultIntent,
  reconcileLegacyMainFirstAgentDefaultIntent: mocks.reconcileLegacyMainFirstAgentDefaultIntent,
  releaseLegacyMainFirstAgentDefaultIntent: mocks.releaseLegacyMainFirstAgentDefaultIntent,
  recordLegacyMainFirstAgentDefaultIntent: mocks.recordLegacyMainFirstAgentDefaultIntent,
}));

vi.mock("./workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace.js")>();
  return { ...actual, ensureAgentWorkspace: mocks.ensureAgentWorkspace };
});

vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionTranscriptsDirForAgent: (agentId: string) => `/tmp/transcripts-${agentId}`,
}));

vi.mock("../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/fs-safe.js")>();
  return {
    ...actual,
    root: vi.fn(async () => ({
      read: mocks.rootRead,
      write: mocks.rootWrite,
    })),
  };
});

import { createAgent, prepareLegacyAgentCreation } from "./agent-create.js";

describe("createAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config = {};
    mocks.persisted = {};
    mocks.readAgentDeletionJournal.mockReturnValue(undefined);
    mocks.claimCompletedAgentDeletion.mockReturnValue(true);
    mocks.completeLegacyMainFirstAgentDefaultIntent.mockClear();
    mocks.claimLegacyMainFirstAgentDefaultIntent.mockReturnValue(false);
    mocks.maybeRepairAgentRoster.mockImplementation((config) => ({ config, changes: [] }));
    mocks.hasPendingLegacyMainFirstAgentDefaultIntent.mockReturnValue(false);
    mocks.readPendingLegacyMainFirstAgentDefaultIntent.mockReturnValue(undefined);
    mocks.isLegacyImplicitMainOnlyRoster.mockReturnValue(false);
    mocks.migrateLegacyMainSessionStateOrThrow.mockResolvedValue({ changed: false });
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/default-researcher");
    mocks.resolveAgentDir.mockReturnValue("/tmp/agent-researcher");
    mocks.ensureAgentWorkspace.mockImplementation(async ({ dir }: { dir: string }) => ({
      dir,
      bootstrapPending: true,
    }));
    mocks.rootRead.mockResolvedValue({ buffer: Buffer.from("") });
    mocks.rootWrite.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.parseBindingSpecs.mockReturnValue({ bindings: [], errors: [] });
    mocks.withConfigMutationExclusive.mockImplementation(
      async (fn: (config: Record<string, unknown>) => Promise<unknown>) => await fn(mocks.config),
    );
    mocks.transformConfigFileWithRetry.mockImplementation(
      async ({
        transform,
      }: {
        transform: (config: Record<string, unknown>) => Promise<unknown>;
      }) => {
        const transformed = (await transform(structuredClone(mocks.config))) as {
          nextConfig: Record<string, unknown>;
          result: unknown;
        };
        mocks.persisted = transformed.nextConfig;
        mocks.config = transformed.nextConfig;
        return { result: transformed.result, nextConfig: transformed.nextConfig };
      },
    );
  });

  it("returns validation errors before mutation", async () => {
    await expect(createAgent({ name: "  " })).resolves.toMatchObject({
      status: "error",
      reason: "invalid-name",
    });
    for (const name of ["OpenClaw", "crestodian"]) {
      await expect(createAgent({ name })).resolves.toMatchObject({
        status: "error",
        reason: "reserved-id",
      });
    }
    expect(mocks.transformConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("allows main and marks the first created agent as default", async () => {
    await expect(createAgent({ name: "main" })).resolves.toMatchObject({
      status: "created",
      agentId: "main",
    });
    expect(mocks.persisted).toMatchObject({
      agents: { list: [{ id: "main", default: true }] },
    });
  });

  it("completes stale default-transfer intent once the roster is populated", async () => {
    mocks.hasPendingLegacyMainFirstAgentDefaultIntent.mockReturnValue(true);
    const config = { agents: { list: [{ id: "ops", default: true }] } };
    mocks.config = config;

    await expect(
      prepareLegacyAgentCreation({
        transformConfig: mocks.transformConfigFileWithRetry,
      }),
    ).resolves.toEqual({ config, makeDefault: false });
    expect(mocks.completeLegacyMainFirstAgentDefaultIntent).toHaveBeenCalledOnce();
  });

  it("preserves repaired legacy-main default transfer across creation retries", async () => {
    mocks.config = { agents: { list: [{ id: "main", default: true }] } };
    mocks.hasPendingLegacyMainFirstAgentDefaultIntent.mockReturnValue(true);
    mocks.isLegacyImplicitMainOnlyRoster.mockReturnValue(true);
    mocks.claimLegacyMainFirstAgentDefaultIntent.mockReturnValue(true);
    mocks.migrateLegacyMainSessionStateOrThrow.mockResolvedValue({ changed: false });

    await expect(createAgent({ name: "ops", workspace: "/tmp/ops" })).resolves.toMatchObject({
      status: "created",
      agentId: "ops",
    });

    expect(mocks.persisted).toMatchObject({
      agents: {
        list: [{ id: "main" }, expect.objectContaining({ id: "ops", default: true })],
      },
    });
    expect(mocks.completeLegacyMainFirstAgentDefaultIntent).toHaveBeenCalledOnce();
  });

  it("does not create an agent while legacy-main migration still needs repair", async () => {
    mocks.config = { agents: { list: [{ id: "main", default: true }] } };
    mocks.isLegacyImplicitMainOnlyRoster.mockReturnValue(true);
    mocks.migrateLegacyMainSessionStateOrThrow.mockRejectedValue(
      new Error("Legacy main session migration requires repair"),
    );

    await expect(createAgent({ name: "ops", workspace: "/tmp/ops" })).rejects.toThrow(
      "Legacy main session migration requires repair",
    );
    expect(mocks.transformConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("defaults the workspace through the agent-scoped resolver", async () => {
    const result = await createAgent({ name: "Researcher" });

    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenCalledWith(expect.any(Object), "researcher");
    expect(result).toMatchObject({
      status: "created",
      agentId: "researcher",
      workspace: "/tmp/default-researcher",
      bootstrapPending: true,
    });
  });

  it("respects skipBootstrap from the current config", async () => {
    mocks.config = { agents: { defaults: { skipBootstrap: true } } };

    await createAgent({ name: "researcher", workspace: "/tmp/work" });

    expect(mocks.ensureAgentWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ ensureBootstrapFiles: false }),
    );
  });

  it("persists the authoritative workspace returned by setup", async () => {
    mocks.ensureAgentWorkspace.mockResolvedValue({
      dir: "/normalized/work",
      bootstrapPending: true,
    });

    const result = await createAgent({ name: "researcher", workspace: "/tmp/work" });

    const agents = mocks.persisted.agents as
      | { entries?: Record<string, { workspace?: string }> }
      | undefined;
    expect(agents?.entries?.researcher?.workspace).toBe("/normalized/work");
    expect(result).toMatchObject({ status: "created", workspace: "/normalized/work" });
  });

  it("persists the canonical agent entry through retrying mutation", async () => {
    const result = await createAgent({
      name: "Researcher",
      workspace: "/tmp/work",
      model: "openai/gpt-5.5",
      emoji: "🔎",
    });

    expect(mocks.transformConfigFileWithRetry).toHaveBeenCalledOnce();
    expect(mocks.persisted).toMatchObject({
      agents: {
        entries: {
          researcher: {
            default: true,
            name: "Researcher",
            workspace: "/tmp/work",
            agentDir: "/tmp/agent-researcher",
            model: "openai/gpt-5.5",
            identity: { name: "Researcher", emoji: "🔎" },
          },
        },
      },
    });
    expect(result).toMatchObject({ status: "created", agentId: "researcher" });
  });

  it("finishes workspace setup before publishing config", async () => {
    mocks.ensureAgentWorkspace.mockImplementation(async ({ dir }: { dir: string }) => {
      expect(mocks.persisted).not.toHaveProperty("agents");
      return { dir, bootstrapPending: true };
    });

    await createAgent({ name: "researcher" });

    expect(mocks.ensureAgentWorkspace).toHaveBeenCalledOnce();
  });

  it("keeps the template identity while bootstrap is pending", async () => {
    await createAgent({ name: "researcher" });

    expect(mocks.rootRead).not.toHaveBeenCalled();
    expect(mocks.rootWrite).not.toHaveBeenCalled();
    expect(mocks.persisted).toMatchObject({
      agents: {
        entries: {
          researcher: expect.objectContaining({ identity: { name: "researcher" } }),
        },
      },
    });
  });

  it("does not publish config when identity setup is unsafe", async () => {
    mocks.ensureAgentWorkspace.mockImplementation(async ({ dir }: { dir: string }) => ({
      dir,
      bootstrapPending: false,
    }));
    mocks.rootRead.mockRejectedValue(new FsSafeError("invalid-path", "unsafe identity path"));

    await expect(createAgent({ name: "researcher" })).resolves.toMatchObject({
      status: "error",
      reason: "unsafe-identity-file",
    });
    expect(mocks.transformConfigFileWithRetry).toHaveBeenCalledOnce();
    expect(mocks.persisted).not.toHaveProperty("agents");
  });

  it("does not recreate an id with pending deletion cleanup", async () => {
    mocks.readAgentDeletionJournal.mockReturnValue({
      operationId: "delete-1",
      cleanupCompleted: false,
    });

    await expect(createAgent({ name: "researcher" })).resolves.toMatchObject({
      status: "error",
      reason: "deletion-pending",
    });
    expect(mocks.transformConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("claims a completed deletion tombstone after recreating the id", async () => {
    mocks.readAgentDeletionJournal.mockReturnValue({
      operationId: "delete-1",
      cleanupCompleted: true,
    });

    await expect(createAgent({ name: "researcher" })).resolves.toMatchObject({
      status: "created",
      agentId: "researcher",
    });
    expect(mocks.claimCompletedAgentDeletion).toHaveBeenCalledWith("researcher", "delete-1");
  });

  it("claims a recovered completed tombstone only once for an existing roster entry", async () => {
    mocks.config = { agents: { list: [{ id: "researcher" }] } };
    mocks.readAgentDeletionJournal.mockReturnValue({
      operationId: "delete-1",
      cleanupCompleted: true,
    });

    await expect(createAgent({ name: "researcher" })).resolves.toMatchObject({
      status: "error",
      reason: "already-exists",
    });
    expect(mocks.claimCompletedAgentDeletion).toHaveBeenCalledTimes(1);
  });

  it("retains a completed tombstone when creation returns an error result", async () => {
    mocks.readAgentDeletionJournal.mockReturnValue({
      operationId: "delete-1",
      cleanupCompleted: true,
    });
    mocks.transformConfigFileWithRetry.mockResolvedValueOnce({
      result: { status: "error", reason: "invalid-bindings", message: "invalid" },
      nextConfig: {},
    });

    await expect(createAgent({ name: "researcher" })).resolves.toMatchObject({
      status: "error",
    });
    expect(mocks.claimCompletedAgentDeletion).not.toHaveBeenCalled();
  });

  it("rejects a concurrent duplicate from the mutation snapshot", async () => {
    mocks.config = { agents: { list: [{ id: "researcher" }] } };

    await expect(createAgent({ name: "researcher" })).resolves.toMatchObject({
      status: "error",
      reason: "already-exists",
    });
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  });

  it("parses binding specs from the locked winning snapshot", async () => {
    mocks.parseBindingSpecs.mockReturnValue({
      bindings: [],
      errors: ['Unknown channel "removed".'],
    });
    const transformConfig = vi.fn(async ({ maxAttempts, transform }) => {
      expect(maxAttempts).toBe(1);
      return await transform({ agents: { list: [] } });
    });

    await expect(
      createAgent({
        name: "researcher",
        bindingSpecs: ["removed"],
        transformConfig: transformConfig as never,
      }),
    ).resolves.toMatchObject({ status: "error", reason: "invalid-bindings" });
    expect(mocks.parseBindingSpecs).toHaveBeenCalledOnce();
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  });
});
