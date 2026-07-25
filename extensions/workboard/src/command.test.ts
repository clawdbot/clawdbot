// Workboard tests cover command plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardCommand } from "./command.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";
import {
  resolveAgentWorkboardWorkspaceRuntime,
  resolveCommandWorkboardWorkspaceAccess,
} from "./workspace-access.js";

function createMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

function createApi(run = vi.fn().mockResolvedValue({ runId: "run-1" })): OpenClawPluginApi {
  return {
    registerCommand: vi.fn(),
    runtime: {
      subagent: { run },
      worktrees: {
        resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
        create: vi.fn(),
        release: vi.fn(),
        removeIfLossless: vi.fn(),
      },
      sandbox: {
        resolveWorkspaceAuthority: vi.fn(() => ({
          sandboxed: false,
          workspaceAccess: "rw",
        })),
        prepareWorkspaceAuthority: vi.fn(async () => ({
          sandboxed: false,
          workspaceAccess: "rw",
        })),
      },
    },
  } as unknown as OpenClawPluginApi;
}

async function runWorkboardCommand(params: {
  api: OpenClawPluginApi;
  store: WorkboardStore;
  args?: string;
  context?: {
    senderIsOwner?: boolean;
    gatewayClientScopes?: string[];
    config?: Record<string, unknown>;
    agentId?: string;
    sessionKey?: string;
  };
}) {
  let command: OpenClawPluginCommandDefinition | undefined;
  vi.mocked(params.api.registerCommand).mockImplementationOnce((definition) => {
    command = definition;
  });
  registerWorkboardCommand({ api: params.api, store: params.store });
  return await expectDefined(command, "registered Workboard command").handler({
    channel: "test",
    isAuthorizedSender: true,
    commandBody: "/workboard",
    config: {},
    sessionKey: "agent:main:main",
    args: params.args,
    ...params.context,
  } as never);
}

async function createAmbiguousPrefix(store: WorkboardStore): Promise<string> {
  const seen = new Map<string, string>();
  for (let index = 0; index < 40; index += 1) {
    const card = await store.create({ title: `Card ${index}` });
    const prefix = card.id.slice(0, 1);
    if (seen.has(prefix)) {
      return prefix;
    }
    seen.set(prefix, card.id);
  }
  throw new Error("could not create cards with a shared prefix");
}

describe("handleWorkboardCommand", () => {
  it("uses the configured default agent workspace for unscoped local commands", () => {
    expect(
      resolveCommandWorkboardWorkspaceAccess({
        config: {
          tools: { fs: { workspaceOnly: true } },
          agents: {
            list: [
              {
                id: "first",
                workspace: "/first",
                tools: { fs: { workspaceOnly: false } },
              },
              { id: "chosen", default: true, workspace: "/chosen" },
            ],
          },
        },
      }),
    ).toEqual({ unrestricted: false, roots: ["/chosen"], writable: true });
  });

  it("inherits slash-session sandbox roots and write mode", () => {
    const config = {
      agents: {
        defaults: { sandbox: { mode: "all" as const, workspaceAccess: "ro" as const } },
        list: [{ id: "main", default: true, workspace: "/workspace" }],
      },
    };

    expect(
      resolveCommandWorkboardWorkspaceAccess({
        config,
        agentId: "main",
        sessionKey: "agent:main:main",
        resolveSandboxWorkspaceAuthority: () => ({
          sandboxed: true,
          workspaceAccess: "ro",
        }),
      }),
    ).toEqual({ unrestricted: false, roots: ["/workspace"], writable: false });
  });

  it("projects target sandbox authority into Workboard roots", async () => {
    const safeConfig = {
      agents: {
        defaults: { sandbox: { mode: "all" as const, workspaceAccess: "rw" as const } },
        list: [{ id: "main", default: true, workspace: "/workspace" }],
      },
    };
    await expect(
      resolveAgentWorkboardWorkspaceRuntime({
        config: safeConfig,
        agentId: "main",
        sessionKey: "agent:main:subagent:workboard-card",
        workspaceDir: "/workspace",
        prepareSandboxWorkspaceAuthority: async () => ({
          sandboxed: true,
          workspaceAccess: "rw",
        }),
      }),
    ).resolves.toEqual({
      sandboxed: true,
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
    });
  });

  it("attests the default agent for an unassigned slash-command card", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.create({
      title: "Unassigned slash card",
      status: "ready",
      workspaceAccess: { unrestricted: false, roots: ["/workspace"], writable: true },
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-default-agent" });
    const prepareWorkspaceAuthority = vi.fn().mockResolvedValue({
      sandboxed: true,
      workspaceAccess: "rw" as const,
    });
    let command: OpenClawPluginCommandDefinition | undefined;
    const api = {
      registerCommand: vi.fn((definition: OpenClawPluginCommandDefinition) => {
        command = definition;
      }),
      runtime: {
        subagent: { run },
        worktrees: {
          resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
          create: vi.fn(),
          release: vi.fn(),
          removeIfLossless: vi.fn(),
        },
        sandbox: {
          resolveWorkspaceAuthority: vi.fn().mockReturnValue({
            sandboxed: true,
            workspaceAccess: "rw",
          }),
          prepareWorkspaceAuthority,
        },
      },
    } as unknown as OpenClawPluginApi;
    registerWorkboardCommand({ api, store });
    expect(command).toBeDefined();

    await command!.handler({
      args: "dispatch",
      senderIsOwner: true,
      config: {
        agents: {
          defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } },
          list: [
            { id: "main", default: true, workspace: "/workspace" },
            { id: "secondary", workspace: "/workspace" },
          ],
        },
      },
      agentId: "secondary",
      sessionKey: "agent:secondary:main",
    } as never);

    expect(run).toHaveBeenCalledOnce();
    expect(prepareWorkspaceAuthority).toHaveBeenCalled();
    expect(prepareWorkspaceAuthority.mock.calls.every(([input]) => input.agentId === "main")).toBe(
      true,
    );
    expect(prepareWorkspaceAuthority).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredToolNames: ["workboard_heartbeat", "workboard_complete", "workboard_block"],
      }),
    );
  });

  it("creates, lists, and dispatches workboard cards", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();

    await expect(
      runWorkboardCommand({
        api,
        store,
        args: "create Ship CLI",
        context: { senderIsOwner: true },
      }),
    ).resolves.toEqual(expect.objectContaining({ text: expect.stringContaining("Ship CLI") }));
    const card = expectDefined((await store.list())[0], "created workboard card");
    expect(card).toMatchObject({
      title: "Ship CLI",
      metadata: { automation: { workspaceAccess: { unrestricted: true } } },
    });

    await expect(runWorkboardCommand({ api, store, args: "list" })).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("Ship CLI") }),
    );
    await store.update(card.id, { status: "ready" });
    await expect(
      runWorkboardCommand({
        api,
        store,
        args: "dispatch",
        context: { senderIsOwner: true },
      }),
    ).resolves.toEqual(expect.objectContaining({ text: expect.stringContaining("started=1") }));
    expect(api.runtime.subagent.run).toHaveBeenCalledOnce();
  });

  it("requires write access for slash mutations", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();
    const card = await store.create({ title: "Ready worker", status: "ready" });

    await expect(runWorkboardCommand({ api, store, args: "list" })).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("Ready worker") }),
    );
    await expect(runWorkboardCommand({ api, store, args: "create Blocked" })).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("operator.write"),
      }),
    );
    await expect(runWorkboardCommand({ api, store, args: "dispatch" })).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("operator.write"),
      }),
    );
    await expect(
      runWorkboardCommand({ api, store, args: `move ${card.id} --status running` }),
    ).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("operator.write"),
      }),
    );
    expect(api.runtime.subagent.run).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toMatchObject({ status: "ready" });
  });

  it("moves claimed cards for operators on slash-command surfaces", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();
    const card = await store.create({ title: "Claimed slash card", status: "todo" });
    await store.claim(card.id, { ownerId: "worker", token: "secret-token" });

    await expect(
      runWorkboardCommand({
        api,
        store,
        args: `move ${card.id.slice(0, 8)} --status review`,
        context: { gatewayClientScopes: ["operator.write"] },
      }),
    ).resolves.toEqual(expect.objectContaining({ text: expect.stringContaining("review") }));
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "review",
      metadata: { claim: { ownerId: "worker", token: "secret-token" } },
    });
  });

  it("rejects invalid slash-command move statuses", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();
    const card = await store.create({ title: "Invalid slash move" });

    await expect(
      runWorkboardCommand({
        api,
        store,
        args: `move ${card.id} --status later`,
        context: { senderIsOwner: true },
      }),
    ).resolves.toEqual(
      expect.objectContaining({ isError: true, text: expect.stringContaining("status must be") }),
    );
  });

  it("uses the slash caller's workspace access for worktree materialization", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();
    const createWorktree = vi.mocked(api.runtime.worktrees.create);
    createWorktree.mockResolvedValue({
      id: "managed-id",
      path: "/state/worktrees/fingerprint/wb-card",
      branch: "openclaw/wb-card",
    });
    await store.create({
      title: "Denied checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo-denied" },
    });

    const restrictedConfig = {
      tools: { fs: { workspaceOnly: true } },
      agents: {
        list: [
          { id: "main", default: true, workspace: "/workspace" },
          { id: "restricted", workspace: "/workspace" },
        ],
      },
    };
    vi.mocked(api.runtime.sandbox.resolveWorkspaceAuthority).mockReturnValue({
      sandboxed: true,
      workspaceAccess: "rw",
    });
    vi.mocked(api.runtime.sandbox.prepareWorkspaceAuthority).mockResolvedValue({
      sandboxed: true,
      workspaceAccess: "rw",
    });
    await expect(
      runWorkboardCommand({
        api,
        store,
        args: "dispatch",
        context: {
          gatewayClientScopes: ["operator.write"],
          config: restrictedConfig,
          agentId: "main",
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({ text: expect.stringContaining("outside the caller") }),
    );
    expect(createWorktree).not.toHaveBeenCalled();
    const denied = (await store.list()).find((card) => card.title === "Denied checkout");
    expect(denied).toMatchObject({ status: "ready" });
    await store.update(denied!.id, { status: "blocked" });

    const restricted = await store.create({
      title: "Workspace checkout",
      status: "ready",
      agentId: "restricted",
      workspace: { kind: "worktree", path: "/workspace" },
    });
    await runWorkboardCommand({
      api,
      store,
      args: "dispatch",
      context: {
        senderIsOwner: true,
        config: restrictedConfig,
        agentId: "main",
      },
    });
    expect(createWorktree).not.toHaveBeenCalled();
    expect(api.runtime.subagent.run).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/workspace" }),
    );
    await expect(store.get(restricted.id)).resolves.toMatchObject({
      metadata: { automation: { workspace: { kind: "dir", path: "/workspace" } } },
    });

    const allowed = await store.create({
      title: "Allowed checkout",
      status: "ready",
      agentId: "admin",
      workspace: { kind: "worktree", path: "/repo-allowed" },
      workspaceAccess: { unrestricted: true },
    });
    vi.mocked(api.runtime.sandbox.resolveWorkspaceAuthority).mockReturnValue({
      sandboxed: false,
      workspaceAccess: "rw",
    });
    vi.mocked(api.runtime.sandbox.prepareWorkspaceAuthority).mockResolvedValue({
      sandboxed: false,
      workspaceAccess: "rw",
    });
    await runWorkboardCommand({
      api,
      store,
      args: "dispatch",
      context: {
        gatewayClientScopes: ["operator.admin"],
        config: { agents: { list: [{ id: "admin", default: true, workspace: "/repo-allowed" }] } },
        agentId: "admin",
      },
    });

    expect(createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/repo-allowed",
        ownerId: allowed.id,
      }),
    );
  });

  it("rejects ambiguous card id prefixes", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const api = createApi();
    const prefix = await createAmbiguousPrefix(store);

    await expect(runWorkboardCommand({ api, store, args: `show ${prefix}` })).resolves.toEqual(
      expect.objectContaining({
        isError: true,
        text: expect.stringContaining("Ambiguous card id prefix"),
      }),
    );
  });
});
