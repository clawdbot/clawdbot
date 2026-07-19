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
    mocks.config = {};
    mocks.persisted = {};
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
    mocks.withConfigMutationExclusive.mockImplementation(async (fn: () => Promise<unknown>) => {
      return await fn();
    });
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

    const agents = mocks.persisted.agents as { list?: Array<{ workspace?: string }> } | undefined;
    expect(agents?.list?.at(-1)?.workspace).toBe("/normalized/work");
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
        list: expect.arrayContaining([
          {
            id: "researcher",
            name: "Researcher",
            workspace: "/tmp/work",
            agentDir: "/tmp/agent-researcher",
            model: "openai/gpt-5.5",
            identity: { name: "Researcher", emoji: "🔎" },
          },
        ]),
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

  it("does not publish config when identity setup is unsafe", async () => {
    mocks.rootRead.mockRejectedValue(new FsSafeError("invalid-path", "unsafe identity path"));

    await expect(createAgent({ name: "researcher" })).resolves.toMatchObject({
      status: "error",
      reason: "unsafe-identity-file",
    });
    expect(mocks.transformConfigFileWithRetry).toHaveBeenCalledOnce();
    expect(mocks.persisted).not.toHaveProperty("agents");
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
