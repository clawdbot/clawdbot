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
  recordAgentProvenance: vi.fn(),
  readAgentDeletionJournal: vi.fn(() => undefined as Record<string, unknown> | undefined),
  claimCompletedAgentDeletion: vi.fn(() => true),
  migrateLegacyMainSessionKeys: vi.fn(),
  resolveSharedAuthStoreOwnership: vi.fn(),
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

vi.mock("../state/agent-provenance.js", () => ({
  recordAgentProvenance: mocks.recordAgentProvenance,
}));

vi.mock("../config/sessions/legacy-main-session-migration.js", () => ({
  migrateLegacyMainSessionKeys: mocks.migrateLegacyMainSessionKeys,
}));

vi.mock("./auth-profiles/path-resolve.js", () => ({
  resolveSharedAuthStoreOwnership: mocks.resolveSharedAuthStoreOwnership,
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
    mocks.config = { agents: { list: [{ id: "main" }] } };
    mocks.persisted = {};
    mocks.readAgentDeletionJournal.mockReturnValue(undefined);
    mocks.claimCompletedAgentDeletion.mockReturnValue(true);
    mocks.migrateLegacyMainSessionKeys.mockResolvedValue({
      armed: true,
      changes: [],
      complete: true,
      ledgerComplete: true,
      legacyAgentId: "main",
      mainKey: "main",
      outcomes: [{ kind: "no-legacy-rows", detail: "matching completed ledger" }],
      ownerAgentId: "researcher",
      warnings: [],
    });
    mocks.resolveSharedAuthStoreOwnership.mockReturnValue({ location: "state-db" });
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
          previousHash: null,
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
    for (const name of ["OpenClaw", "crestodian"]) {
      await expect(createAgent({ name })).resolves.toMatchObject({
        status: "error",
        reason: "reserved-id",
      });
    }
    expect(mocks.transformConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "not-armed", armed: false, detail: "owner-unresolved" },
    { kind: "no-legacy-rows", armed: true },
    { kind: "migrated-in-place", armed: true, canonicalKey: "agent:robby:main" },
    { kind: "migrated-cross-store", armed: true, canonicalKey: "agent:robby:main" },
    { kind: "canonical-exists-identical", armed: true, canonicalKey: "agent:robby:main" },
    { kind: "divergent-canonical", armed: true, canonicalKey: "agent:robby:main" },
    { kind: "divergent-aliases", armed: true, canonicalKey: "agent:robby:main" },
    { kind: "legacy-json-store", armed: true, paths: ["/tmp/sessions.json"] },
    { kind: "store-unreadable", armed: true, paths: ["/tmp/store.sqlite"] },
  ] as const)("rejects main while the $kind session outcome is unresolved", async (outcome) => {
    mocks.config = { agents: { entries: { robby: { id: "robby" } } } };
    mocks.migrateLegacyMainSessionKeys.mockResolvedValueOnce({
      armed: outcome.armed,
      changes: [],
      complete: false,
      ledgerComplete: false,
      legacyAgentId: "main",
      mainKey: "main",
      outcomes: [
        {
          ...outcome,
          paths: "paths" in outcome ? outcome.paths : ["/tmp/legacy.sqlite", "/tmp/owner.sqlite"],
          sourceKeys: ["agent:main:main", "agent:robby:main"],
        },
      ],
      warnings: [],
    });

    await expect(createAgent({ name: "main" })).resolves.toMatchObject({
      status: "error",
      reason: "legacy-session-migration-required",
      message: expect.stringContaining("openclaw doctor --fix"),
    });
    expect(mocks.transformConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("names both preserved claims when main creation finds divergence", async () => {
    mocks.config = { agents: { entries: { robby: { id: "robby" } } } };
    mocks.migrateLegacyMainSessionKeys.mockResolvedValueOnce({
      armed: true,
      changes: [],
      complete: false,
      ledgerComplete: false,
      legacyAgentId: "main",
      mainKey: "main",
      outcomes: [
        {
          kind: "divergent-canonical",
          canonicalKey: "agent:robby:main",
          paths: ["/tmp/legacy.sqlite", "/tmp/owner.sqlite"],
          sourceKeys: ["agent:main:main", "agent:robby:main"],
        },
      ],
      warnings: [],
    });

    const result = await createAgent({ name: "main" });

    expect(result).toMatchObject({
      status: "error",
      message: expect.stringMatching(
        /legacy\.sqlite#agent:main:main.*owner\.sqlite#agent:robby:main/u,
      ),
    });
  });

  it("rejects main while its agent database still owns shared auth", async () => {
    mocks.config = { agents: { entries: { robby: { id: "robby" } } } };
    mocks.resolveSharedAuthStoreOwnership.mockReturnValueOnce({ location: "legacy-main" });

    await expect(createAgent({ name: "main" })).resolves.toMatchObject({
      status: "error",
      reason: "shared-auth-store-owned-by-main",
      message: expect.stringContaining("openclaw doctor --fix"),
    });
    expect(mocks.transformConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("creates main as an ordinary agent once both migration gates are complete", async () => {
    mocks.config = { agents: { entries: { robby: { id: "robby" } } } };
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/workspace-main");
    mocks.resolveAgentDir.mockReturnValue("/tmp/agents/main/agent");

    await expect(createAgent({ name: "main" })).resolves.toMatchObject({
      status: "created",
      agentId: "main",
      agentDir: "/tmp/agents/main/agent",
    });
    expect(mocks.persisted).toMatchObject({
      agents: { entries: { robby: expect.any(Object), main: expect.any(Object) } },
    });
    expect(mocks.migrateLegacyMainSessionKeys).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        agents: { entries: { robby: { id: "robby" } } },
      }),
      forceScan: true,
      legacyAgentId: "main",
      mode: "detect",
    });
  });

  it("creates main when an unarmed scan proves every legacy store clean", async () => {
    mocks.config = { agents: { entries: { robby: { id: "robby" } } } };
    mocks.migrateLegacyMainSessionKeys.mockResolvedValueOnce({
      armed: false,
      changes: [],
      complete: true,
      ledgerComplete: false,
      legacyAgentId: "main",
      mainKey: "main",
      outcomes: [{ kind: "no-legacy-rows", detail: "no configured owner" }],
      warnings: [],
    });

    await expect(createAgent({ name: "main" })).resolves.toMatchObject({
      status: "created",
      agentId: "main",
    });
    expect(mocks.resolveSharedAuthStoreOwnership).toHaveBeenCalledOnce();
    expect(mocks.transformConfigFileWithRetry).toHaveBeenCalledOnce();
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
    expect(mocks.recordAgentProvenance).toHaveBeenCalledWith("researcher", {
      createdVia: "operator",
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

  it("publishes guided staging and its new agent in one conditional transform", async () => {
    const result = await createAgent({
      entry: {
        id: "researcher",
        name: "Researcher",
        workspace: "/tmp/staged-work",
      },
      expectedConfigHash: null,
      stagedConfig: {
        agents: {
          entries: {
            main: {},
            researcher: { workspace: "/tmp/staged-work" },
          },
        },
        channels: { telegram: { enabled: true } },
      },
    });

    expect(result).toMatchObject({ status: "created", agentId: "researcher" });
    if (result.status === "error") {
      throw new Error(result.message);
    }
    expect(mocks.transformConfigFileWithRetry).toHaveBeenCalledOnce();
    expect(mocks.persisted).toMatchObject({
      agents: { entries: { main: expect.any(Object), researcher: expect.any(Object) } },
      channels: { telegram: { enabled: true } },
    });
    expect(result.config).toEqual(mocks.persisted);
  });

  it("requires a config revision for guided staging", async () => {
    await expect(
      createAgent({
        entry: { id: "researcher" },
        stagedConfig: { agents: { entries: { researcher: {} } } },
      }),
    ).rejects.toThrow("staged agent creation requires an expected config hash");
    expect(mocks.withConfigMutationExclusive).not.toHaveBeenCalled();
  });

  it("replaces only the load-time compatibility roster when creating a named first agent", async () => {
    await createAgent({
      entry: { id: "robby", name: "robby", workspace: "/tmp/robby" },
      bootstrapFirstAgent: true,
    });

    expect(mocks.transformConfigFileWithRetry).toHaveBeenCalledOnce();
    expect(mocks.transformConfigFileWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        writeOptions: { allowedAgentRosterRemovals: ["main"] },
      }),
    );
    expect(mocks.persisted).toMatchObject({
      agents: { entries: { robby: expect.objectContaining({ workspace: "/tmp/robby" }) } },
    });
    expect(
      (mocks.persisted.agents as { entries?: Record<string, unknown> }).entries,
    ).not.toHaveProperty("main");
  });

  it("rejects first-agent creation when the approved config hash changed under the lock", async () => {
    mocks.transformConfigFileWithRetry.mockImplementationOnce(async ({ transform }) =>
      transform(structuredClone(mocks.config), {
        snapshot: { exists: true },
        previousHash: "concurrent",
      }),
    );

    await expect(
      createAgent({
        entry: { id: "robby", name: "robby", workspace: "/tmp/robby" },
        bootstrapFirstAgent: true,
        expectedConfigHash: "approved",
      }),
    ).rejects.toThrow("config changed before first-agent creation");

    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  });

  it("keeps the first staged roster entry marker-free", async () => {
    mocks.config = { agents: { list: [] } };

    await createAgent({
      entry: { id: "researcher", name: "Researcher", default: false },
    });

    expect(
      (mocks.persisted.agents as { entries?: Record<string, unknown> })?.entries?.researcher,
    ).not.toHaveProperty("default");
  });

  it.each([
    {
      label: "staged model only",
      entryModel: "openai/staged",
      paramsModel: undefined,
    },
    {
      label: "staged model over explicit parameter",
      entryModel: "openai/staged",
      paramsModel: "openai/parameter",
    },
  ])(
    "preserves $label when workspace setup normalizes the path",
    async ({ entryModel, paramsModel }) => {
      mocks.ensureAgentWorkspace.mockResolvedValue({
        dir: "/normalized/work",
        bootstrapPending: true,
      });

      await createAgent({
        entry: {
          id: "researcher",
          name: "Researcher",
          workspace: "/staged/work",
          model: entryModel,
        },
        model: paramsModel,
      });

      expect(mocks.persisted).toMatchObject({
        agents: {
          entries: {
            researcher: expect.objectContaining({
              model: entryModel,
              workspace: "/normalized/work",
            }),
          },
        },
      });
    },
  );

  it("preserves every legacy-list agent when staging a new entry", async () => {
    mocks.config = {
      agents: {
        list: [
          { id: "main", name: "Main" },
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
          main: { name: "Main" },
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
          workspace: "/tmp/main-work",
        },
        bootstrapMain: true,
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
        list: [{ id: "main", name: "Existing", workspace: "/tmp/existing" }],
      },
    };
    mocks.resolveAgentWorkspaceDir.mockReturnValueOnce("/tmp/existing");

    await expect(
      createAgent({
        entry: { id: "main", name: "Replacement", workspace: "/tmp/new" },
        bootstrapMain: true,
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
        entry: { id: "main", workspace: "/tmp/replacement" },
        bootstrapMain: true,
      }),
    ).resolves.toMatchObject({ status: "existing", workspace: "/tmp/persisted" });
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  });

  it("drops a deprecated staged default marker", async () => {
    await expect(
      createAgent({ entry: { id: "researcher", name: "Researcher", default: true } }),
    ).resolves.toMatchObject({ status: "created", agentId: "researcher" });
    expect(
      (mocks.persisted.agents as { entries?: Record<string, unknown> })?.entries?.researcher,
    ).not.toHaveProperty("default");
    expect(mocks.ensureAgentWorkspace).toHaveBeenCalledOnce();
  });

  it("rejects a concurrent non-main roster during main bootstrap", async () => {
    const transformConfig = vi.fn(async ({ transform }) =>
      transform({ agents: { list: [{ id: "main" }, { id: "ops" }] } }),
    );

    await expect(
      createAgent({
        entry: { id: "main", workspace: "/tmp/main" },
        bootstrapMain: true,
        transformConfig,
      }),
    ).resolves.toMatchObject({
      status: "existing",
      agentId: "main",
    });
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
  });

  it("respects skipBootstrap from the current config", async () => {
    mocks.config = {
      agents: { defaults: { skipBootstrap: true }, list: [{ id: "main" }] },
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

  it("prepares staged config effects after setup and immediately before publication", async () => {
    mocks.ensureAgentWorkspace.mockResolvedValue({
      dir: "/tmp/default-researcher",
      bootstrapPending: false,
    });
    const prepareConfigCommit = vi.fn(async () => {
      expect(mocks.ensureAgentWorkspace).toHaveBeenCalledOnce();
      expect(mocks.mkdir).toHaveBeenCalledOnce();
      expect(mocks.rootWrite).toHaveBeenCalledOnce();
      expect(mocks.persisted).not.toHaveProperty("agents");
    });

    await createAgent({ name: "researcher", prepareConfigCommit });

    expect(prepareConfigCommit).toHaveBeenCalledOnce();
    expect(mocks.persisted).toHaveProperty("agents.entries.researcher");
  });

  it("rolls staged config effects back once when config publication fails", async () => {
    const rollback = vi.fn();
    const prepareConfigCommit = vi.fn(async () => rollback);
    mocks.transformConfigFileWithRetry.mockImplementationOnce(async ({ transform }) => {
      await transform(structuredClone(mocks.config), {
        snapshot: { exists: false },
        previousHash: null,
      });
      throw new Error("injected config commit failure");
    });

    await expect(createAgent({ name: "researcher", prepareConfigCommit })).rejects.toThrow(
      "injected config commit failure",
    );

    expect(prepareConfigCommit).toHaveBeenCalledOnce();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("does not roll staged config effects back after config publication", async () => {
    const rollback = vi.fn();
    mocks.recordAgentProvenance.mockImplementationOnce(() => {
      throw new Error("injected provenance failure");
    });

    await expect(
      createAgent({
        name: "researcher",
        prepareConfigCommit: async () => rollback,
      }),
    ).rejects.toThrow("injected provenance failure");

    expect(mocks.persisted).toHaveProperty("agents.entries.researcher");
    expect(rollback).not.toHaveBeenCalled();
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
      agents: { list: [{ id: "main" }, { id: "researcher" }] },
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
      agents: { list: [{ id: "main" }, { id: "researcher" }] },
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
      return await transform({ agents: { list: [{ id: "main" }] } });
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
