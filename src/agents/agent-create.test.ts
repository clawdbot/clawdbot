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

import { createAgent } from "./agent-create.js";

describe("createAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config = { agents: { list: [{ id: "main", default: true }] } };
    mocks.persisted = {};
    mocks.readAgentDeletionJournal.mockReturnValue(undefined);
    mocks.claimCompletedAgentDeletion.mockReturnValue(true);
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
        transform: (config: Record<string, unknown>, context: unknown) => Promise<unknown>;
      }) => {
        const transformed = (await transform(structuredClone(mocks.config), {
          snapshot: { exists: false },
        })) as {
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
    await expect(createAgent({ name: "###" })).resolves.toMatchObject({
      status: "error",
      reason: "invalid-name",
    });
    for (const name of ["main", "OpenClaw", "crestodian"]) {
      await expect(createAgent({ name })).resolves.toMatchObject({
        status: "error",
        reason: "reserved-id",
      });
    }
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

  it("accepts a complete staged entry", async () => {
    const result = await createAgent({
      entry: {
        id: "researcher",
        name: "Researcher",
        workspace: "/tmp/staged-work",
        agentDir: "/tmp/staged-agent",
        model: "openai/gpt-5.5",
        identity: { name: "Researcher", emoji: "🔎" },
      },
    });

    expect(result).toMatchObject({
      status: "created",
      agentId: "researcher",
      workspace: "/tmp/staged-work",
      agentDir: "/tmp/staged-agent",
    });
    expect(mocks.persisted).toMatchObject({
      agents: {
        entries: {
          researcher: expect.objectContaining({ model: "openai/gpt-5.5" }),
        },
      },
    });
    expect((mocks.persisted.agents as { list?: unknown }).list).toBeUndefined();
  });

  it("preserves every legacy-list agent when staging a new entry", async () => {
    mocks.config = {
      agents: {
        list: [
          { id: "main", default: true, name: "Main" },
          { id: "ops", name: "Ops" },
        ],
      },
    };

    await createAgent({
      entry: { id: "researcher", name: "Researcher", model: "openai/gpt-5.5" },
    });

    expect(mocks.persisted).toMatchObject({
      agents: {
        entries: {
          main: { default: true, name: "Main" },
          ops: { name: "Ops" },
          researcher: expect.objectContaining({ model: "openai/gpt-5.5" }),
        },
      },
    });
    expect((mocks.persisted.agents as { list?: unknown }).list).toBeUndefined();
  });

  it("provisions the injected main roster only through a bootstrap entry", async () => {
    await expect(
      createAgent({
        entry: {
          id: "main",
          name: "main",
          default: true,
          workspace: "/tmp/main-work",
        },
      }),
    ).resolves.toMatchObject({ status: "existing", agentId: "main" });
    expect(mocks.ensureAgentWorkspace).toHaveBeenCalledOnce();
    expect(mocks.persisted).toMatchObject({
      agents: { entries: { main: expect.objectContaining({ workspace: "/tmp/main-work" }) } },
    });
  });

  it("does not overwrite an already materialized main agent", async () => {
    mocks.config = {
      agents: {
        list: [{ id: "main", default: true, name: "Existing", workspace: "/tmp/existing" }],
      },
    };
    mocks.resolveAgentWorkspaceDir.mockReturnValueOnce("/tmp/existing");

    await expect(
      createAgent({
        entry: { id: "main", name: "Replacement", default: true, workspace: "/tmp/new" },
      }),
    ).resolves.toMatchObject({
      status: "existing",
      name: "Existing",
      workspace: "/tmp/existing",
      bootstrapPending: false,
    });
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  });

  it("does not materialize a minimal main entry from a persisted snapshot", async () => {
    mocks.resolveAgentWorkspaceDir.mockReturnValueOnce("/tmp/persisted");
    mocks.transformConfigFileWithRetry.mockImplementationOnce(async ({ transform }) => {
      const transformed = await transform(structuredClone(mocks.config), {
        snapshot: { exists: true },
      });
      return { ...transformed, result: transformed.result };
    });

    await expect(
      createAgent({
        entry: { id: "main", default: true, workspace: "/tmp/replacement" },
      }),
    ).resolves.toMatchObject({ status: "existing", workspace: "/tmp/persisted" });
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  });

  it("rejects a default marker when a roster already exists", async () => {
    const before = structuredClone(mocks.config);

    await expect(
      createAgent({
        entry: { id: "researcher", name: "Researcher", default: true },
      }),
    ).resolves.toMatchObject({
      status: "error",
      reason: "default-conflict",
      message: expect.stringContaining("Reassign the default separately"),
    });
    expect(mocks.config).toEqual(before);
    expect(mocks.persisted).toEqual({});
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  });

  it("rejects a concurrent non-main roster during main bootstrap", async () => {
    const transformConfig = vi.fn(async ({ transform }) =>
      transform({ agents: { list: [{ id: "main" }, { id: "ops", default: true }] } }),
    );

    await expect(
      createAgent({
        entry: { id: "main", default: true, workspace: "/tmp/main" },
        transformConfig,
      }),
    ).resolves.toMatchObject({
      status: "error",
      reason: "default-conflict",
      message: expect.stringContaining("Reassign the default separately"),
    });
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  });

  it("respects skipBootstrap from the current config", async () => {
    mocks.config = {
      agents: { defaults: { skipBootstrap: true }, list: [{ id: "main", default: true }] },
    };

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
    mocks.config = {
      agents: { list: [{ id: "main", default: true }, { id: "researcher" }] },
    };
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
    mocks.config = {
      agents: { list: [{ id: "main", default: true }, { id: "researcher" }] },
    };

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
      return await transform({ agents: { list: [{ id: "main", default: true }] } });
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
