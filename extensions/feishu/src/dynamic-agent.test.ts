// Feishu tests cover dynamic agent plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import { maybeCreateDynamicAgent } from "./dynamic-agent.js";

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-feishu-agent-"));
});

afterEach(async () => {
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

function createRuntime(
  currentCfg?: OpenClawConfig,
  persistedCfg?: OpenClawConfig,
  mutationCfg?: OpenClawConfig,
) {
  let runtimeCfg = structuredClone(currentCfg ?? ({} as OpenClawConfig));
  const commitConfig = vi.fn();
  const mutateConfigFile = vi.fn(
    async (params: {
      mutate: (draft: OpenClawConfig, context: { snapshot: never; previousHash: null }) => unknown;
    }) => {
      const draft = structuredClone(mutationCfg ?? runtimeCfg);
      const result = await params.mutate(draft, { snapshot: {} as never, previousHash: null });
      runtimeCfg = draft;
      commitConfig();
      return { nextConfig: persistedCfg ?? runtimeCfg, result };
    },
  );
  return {
    runtime: {
      config: {
        mutateConfigFile,
        current: vi.fn(() => runtimeCfg),
      },
    } as unknown as PluginRuntime,
    commitConfig,
    mutateConfigFile,
  };
}

function createDynamicConfig() {
  return {
    enabled: true,
    workspaceTemplate: path.join(tempRoot, "workspace-{agentId}"),
    agentDirTemplate: path.join(tempRoot, "agent-{agentId}"),
  };
}

function createCanonicalAgentRoster() {
  return { list: [{ id: "main", default: true }] };
}

async function pathExists(target: string): Promise<boolean> {
  return fs.promises
    .stat(target)
    .then(() => true)
    .catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw err;
    });
}

describe("maybeCreateDynamicAgent", () => {
  it("does not persist dynamic agents when config writes are disabled", async () => {
    const cfg = {
      channels: {
        feishu: {
          configWrites: false,
          dynamicAgentCreation: createDynamicConfig(),
        },
      },
      agents: createCanonicalAgentRoster(),
      bindings: [],
    } as OpenClawConfig;
    const { runtime, mutateConfigFile } = createRuntime(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime,
      accountId: "default",
      senderOpenId: "ou_sender",
      canCreateForConfig: async () => true,
      log: vi.fn(),
    });

    expect(result).toEqual({ created: false, updatedCfg: cfg });
    expect(mutateConfigFile).not.toHaveBeenCalled();
    expect(await pathExists(path.join(tempRoot, "workspace-feishu-ou_sender"))).toBe(false);
    expect(await pathExists(path.join(tempRoot, "agent-feishu-ou_sender"))).toBe(false);
  });

  it("persists a sender agent and direct binding when config writes are allowed", async () => {
    const cfg = {
      channels: { feishu: { dynamicAgentCreation: createDynamicConfig() } },
      agents: createCanonicalAgentRoster(),
      bindings: [],
    } as OpenClawConfig;
    const { runtime, mutateConfigFile } = createRuntime(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime,
      accountId: "default",
      senderOpenId: "ou_sender",
      canCreateForConfig: async () => true,
      log: vi.fn(),
    });

    expect(result.created).toBe(true);
    expect(result.agentId).toBe("feishu-ou_sender");
    expect(mutateConfigFile).toHaveBeenCalledTimes(1);
    expect(mutateConfigFile).toHaveBeenCalledWith({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate: expect.any(Function),
    });
    expect(result.updatedCfg.agents?.list).toEqual([
      { id: "main", default: true },
      {
        id: "feishu-ou_sender",
        workspace: path.join(tempRoot, "workspace-feishu-ou_sender"),
        agentDir: path.join(tempRoot, "agent-feishu-ou_sender"),
      },
    ]);
    expect(result.updatedCfg.bindings).toEqual([
      {
        agentId: "feishu-ou_sender",
        match: {
          channel: "feishu",
          accountId: "default",
          peer: { kind: "direct", id: "ou_sender" },
        },
      },
    ]);
    expect(await pathExists(path.join(tempRoot, "workspace-feishu-ou_sender"))).toBe(true);
    expect(await pathExists(path.join(tempRoot, "agent-feishu-ou_sender"))).toBe(true);
  });

  it("does not create persistent state when current ingress denies the sender", async () => {
    const cfg = {
      channels: { feishu: { dynamicAgentCreation: createDynamicConfig() } },
      agents: createCanonicalAgentRoster(),
      bindings: [],
    } as OpenClawConfig;
    const { runtime, mutateConfigFile } = createRuntime(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime,
      accountId: "default",
      senderOpenId: "ou_sender",
      canCreateForConfig: async () => false,
      log: vi.fn(),
    });

    expect(result).toEqual({ created: false, updatedCfg: cfg });
    expect(mutateConfigFile).not.toHaveBeenCalled();
    expect(await pathExists(path.join(tempRoot, "workspace-feishu-ou_sender"))).toBe(false);
    expect(await pathExists(path.join(tempRoot, "agent-feishu-ou_sender"))).toBe(false);
  });

  it("rechecks current ingress inside the config mutation lock", async () => {
    const cfg = {
      channels: { feishu: { dynamicAgentCreation: createDynamicConfig() } },
      agents: createCanonicalAgentRoster(),
      bindings: [],
    } as OpenClawConfig;
    const { runtime, commitConfig, mutateConfigFile } = createRuntime(cfg);
    const canCreateForConfig = vi
      .fn<(cfg: OpenClawConfig) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime,
      accountId: "default",
      senderOpenId: "ou_sender",
      canCreateForConfig,
      log: vi.fn(),
    });

    expect(result.created).toBe(false);
    expect(canCreateForConfig).toHaveBeenCalledTimes(2);
    expect(mutateConfigFile).toHaveBeenCalledTimes(1);
    expect(commitConfig).not.toHaveBeenCalled();
    expect(result.updatedCfg.agents?.list).toEqual([{ id: "main", default: true }]);
    expect(result.updatedCfg.bindings).toEqual([]);
    expect(await pathExists(path.join(tempRoot, "workspace-feishu-ou_sender"))).toBe(false);
    expect(await pathExists(path.join(tempRoot, "agent-feishu-ou_sender"))).toBe(false);
  });

  it("preserves a non-peer route added before the config mutation lock", async () => {
    const cfg = {
      channels: { feishu: { dynamicAgentCreation: createDynamicConfig() } },
      agents: createCanonicalAgentRoster(),
      bindings: [],
    } as OpenClawConfig;
    const mutationCfg = {
      ...cfg,
      bindings: [
        {
          agentId: "main",
          match: { channel: "feishu", accountId: "default" },
        },
      ],
    } as OpenClawConfig;
    const { runtime, commitConfig, mutateConfigFile } = createRuntime(cfg, undefined, mutationCfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime,
      accountId: "default",
      senderOpenId: "ou_sender",
      canCreateForConfig: async () => true,
      log: vi.fn(),
    });

    expect(result.created).toBe(false);
    expect(result.updatedCfg).toEqual(mutationCfg);
    expect(mutateConfigFile).toHaveBeenCalledTimes(1);
    expect(commitConfig).not.toHaveBeenCalled();
  });

  it("scopes bindings to the normalized account id", async () => {
    const cfg = {
      channels: { feishu: { dynamicAgentCreation: createDynamicConfig() } },
      agents: createCanonicalAgentRoster(),
      bindings: [],
    } as OpenClawConfig;
    const { runtime } = createRuntime(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg,
      runtime,
      accountId: "Ops Team",
      senderOpenId: "ou_sender",
      canCreateForConfig: async () => true,
      log: vi.fn(),
    });

    expect(result.created).toBe(true);
    expect(result.agentId).toMatch(/^feishu-ops-team-[a-f0-9]{32}$/);
    expect(result.updatedCfg.bindings).toEqual([
      {
        agentId: result.agentId,
        match: {
          channel: "feishu",
          accountId: "ops-team",
          peer: { kind: "direct", id: "ou_sender" },
        },
      },
    ]);
  });

  it("keeps named-account dynamic agent ids bounded and sender-unique", async () => {
    const accountId = "a".repeat(64);
    const cfg = {
      channels: { feishu: { dynamicAgentCreation: createDynamicConfig() } },
      agents: createCanonicalAgentRoster(),
      bindings: [],
    } as OpenClawConfig;
    const { runtime } = createRuntime(cfg);

    const first = await maybeCreateDynamicAgent({
      cfg,
      runtime,
      accountId,
      senderOpenId: "ou_sender_one_with_a_shared_long_prefix",
      canCreateForConfig: async () => true,
      log: vi.fn(),
    });
    const second = await maybeCreateDynamicAgent({
      cfg: first.updatedCfg,
      runtime,
      accountId,
      senderOpenId: "ou_sender_two_with_a_shared_long_prefix",
      canCreateForConfig: async () => true,
      log: vi.fn(),
    });

    expect(first.agentId).toHaveLength(52);
    expect(second.agentId).toHaveLength(52);
    expect(first.agentId).not.toBe(second.agentId);
    expect(second.updatedCfg.agents?.list?.map((agent) => agent.id)).toEqual([
      "main",
      first.agentId,
      second.agentId,
    ]);
  });

  it("uses the current maxAgents limit instead of stale request policy", async () => {
    const cfg = {
      channels: {
        feishu: {
          dynamicAgentCreation: {
            ...createDynamicConfig(),
            maxAgents: 1,
          },
        },
      },
      agents: {
        list: [
          { id: "main", default: true },
          {
            id: "feishu-ou_existing",
            workspace: path.join(tempRoot, "existing-workspace"),
            agentDir: path.join(tempRoot, "existing-agent"),
          },
        ],
      },
      bindings: [],
    } as OpenClawConfig;
    const { runtime, mutateConfigFile } = createRuntime(cfg);

    const result = await maybeCreateDynamicAgent({
      cfg: {
        channels: {
          feishu: {
            dynamicAgentCreation: {
              ...createDynamicConfig(),
              maxAgents: 2,
            },
          },
        },
        agents: cfg.agents,
        bindings: [],
      } as OpenClawConfig,
      runtime,
      accountId: "default",
      senderOpenId: "ou_sender",
      canCreateForConfig: async () => true,
      log: vi.fn(),
    });

    expect(result.created).toBe(false);
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });

  it("preserves concurrent runtime config when creating from a stale request snapshot", async () => {
    const currentCfg = {
      channels: { feishu: { dynamicAgentCreation: createDynamicConfig() } },
      agents: {
        list: [
          { id: "main", default: true },
          {
            id: "feishu-ou_existing",
            workspace: path.join(tempRoot, "existing-workspace"),
            agentDir: path.join(tempRoot, "existing-agent"),
          },
        ],
      },
      bindings: [
        {
          agentId: "feishu-ou_existing",
          match: {
            channel: "feishu",
            peer: { kind: "direct", id: "ou_existing" },
          },
        },
      ],
    } as OpenClawConfig;
    const { runtime, mutateConfigFile } = createRuntime(currentCfg);

    const result = await maybeCreateDynamicAgent({
      cfg: { agents: createCanonicalAgentRoster(), bindings: [] } as OpenClawConfig,
      runtime,
      accountId: "default",
      senderOpenId: "ou_sender",
      canCreateForConfig: async () => true,
      log: vi.fn(),
    });

    expect(mutateConfigFile).toHaveBeenCalledWith({
      base: "runtime",
      afterWrite: { mode: "auto" },
      mutate: expect.any(Function),
    });
    expect(result.updatedCfg.agents?.list).toEqual([
      ...currentCfg.agents!.list!,
      {
        id: "feishu-ou_sender",
        workspace: path.join(tempRoot, "workspace-feishu-ou_sender"),
        agentDir: path.join(tempRoot, "agent-feishu-ou_sender"),
      },
    ]);
    expect(result.updatedCfg.bindings).toEqual([
      ...currentCfg.bindings!,
      {
        agentId: "feishu-ou_sender",
        match: {
          channel: "feishu",
          accountId: "default",
          peer: { kind: "direct", id: "ou_sender" },
        },
      },
    ]);
  });

  it("returns refreshed runtime config instead of the persisted source config", async () => {
    const currentCfg = {
      channels: {
        feishu: {
          appSecret: "resolved-secret",
          dynamicAgentCreation: createDynamicConfig(),
        },
      },
      agents: createCanonicalAgentRoster(),
      bindings: [],
    } as OpenClawConfig;
    const persistedCfg = {
      channels: {
        feishu: {
          appSecret: { source: "env", id: "FEISHU_APP_SECRET" },
          dynamicAgentCreation: createDynamicConfig(),
        },
      },
      agents: createCanonicalAgentRoster(),
      bindings: [],
    } as OpenClawConfig;
    const { runtime } = createRuntime(currentCfg, persistedCfg);

    const result = await maybeCreateDynamicAgent({
      cfg: currentCfg,
      runtime,
      accountId: "default",
      senderOpenId: "ou_sender",
      canCreateForConfig: async () => true,
      log: vi.fn(),
    });

    expect(result.updatedCfg.channels?.feishu?.appSecret).toBe("resolved-secret");
    expect(result.updatedCfg.bindings).toHaveLength(1);
  });

  it("returns runtime current binding even when config writes are disabled", async () => {
    const currentCfg = {
      channels: { feishu: { configWrites: false } },
      agents: {
        list: [
          { id: "main", default: true },
          {
            id: "feishu-ou_sender",
            workspace: path.join(tempRoot, "existing-workspace"),
            agentDir: path.join(tempRoot, "existing-agent"),
          },
        ],
      },
      bindings: [
        {
          agentId: "feishu-ou_sender",
          match: {
            channel: "feishu",
            peer: { kind: "direct", id: "ou_sender" },
          },
        },
      ],
    } as OpenClawConfig;
    const { runtime, mutateConfigFile } = createRuntime(currentCfg);

    const result = await maybeCreateDynamicAgent({
      cfg: {
        agents: createCanonicalAgentRoster(),
        bindings: [],
      } as OpenClawConfig,
      runtime,
      accountId: "default",
      senderOpenId: "ou_sender",
      canCreateForConfig: async () => true,
      log: vi.fn(),
    });

    expect(result.created).toBe(false);
    expect(result.updatedCfg).toStrictEqual(currentCfg);
    expect(mutateConfigFile).not.toHaveBeenCalled();
  });
});
