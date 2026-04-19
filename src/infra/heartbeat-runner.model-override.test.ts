import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentMainSessionKey, resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedSessionStore,
  type HeartbeatReplySpy,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue(undefined),
}));

type SeedSessionInput = {
  lastChannel: string;
  lastTo: string;
  updatedAt?: number;
};
type AgentDefaultsConfig = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
type HeartbeatConfig = NonNullable<AgentDefaultsConfig["heartbeat"]>;

async function withHeartbeatFixture(
  run: (ctx: {
    tmpDir: string;
    storePath: string;
    replySpy: HeartbeatReplySpy;
    seedSession: (sessionKey: string, input: SeedSessionInput) => Promise<void>;
  }) => Promise<unknown>,
): Promise<unknown> {
  return withTempHeartbeatSandbox(
    async ({ tmpDir, storePath, replySpy }) => {
      const seedSession = async (sessionKey: string, input: SeedSessionInput) => {
        await seedSessionStore(storePath, sessionKey, {
          updatedAt: input.updatedAt,
          lastChannel: input.lastChannel,
          lastProvider: input.lastChannel,
          lastTo: input.lastTo,
        });
      };
      return run({ tmpDir, storePath, replySpy, seedSession });
    },
    { prefix: "openclaw-hb-model-" },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runHeartbeatOnce – heartbeat model override", () => {
  async function runHeartbeatWithSeed(params: {
    seedSession: (sessionKey: string, input: SeedSessionInput) => Promise<void>;
    cfg: OpenClawConfig;
    sessionKey: string;
    replySpy: HeartbeatReplySpy;
    agentId?: string;
  }) {
    await params.seedSession(params.sessionKey, { lastChannel: "whatsapp", lastTo: "+1555" });

    params.replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

    await runHeartbeatOnce({
      cfg: params.cfg,
      agentId: params.agentId,
      deps: {
        getReplyFromConfig: params.replySpy,
        getQueueSize: () => 0,
        nowMs: () => 0,
      },
    });

    expect(params.replySpy).toHaveBeenCalledTimes(1);
    return {
      ctx: params.replySpy.mock.calls[0]?.[0],
      opts: params.replySpy.mock.calls[0]?.[1],
      replySpy: params.replySpy,
    };
  }

  async function runDefaultsHeartbeat(params: {
    model?: string;
    suppressToolErrorWarnings?: boolean;
    timeoutSeconds?: number;
    lightContext?: boolean;
    isolatedSession?: boolean;
  }) {
    return withHeartbeatFixture(async ({ tmpDir, storePath, replySpy, seedSession }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "whatsapp",
              model: params.model,
              suppressToolErrorWarnings: params.suppressToolErrorWarnings,
              timeoutSeconds: params.timeoutSeconds,
              lightContext: params.lightContext,
              isolatedSession: params.isolatedSession,
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      const result = await runHeartbeatWithSeed({
        seedSession,
        cfg,
        sessionKey,
        replySpy,
      });
      return result.opts;
    });
  }

  async function expectPerAgentHeartbeatOverride(params: {
    defaultsHeartbeat: Partial<HeartbeatConfig>;
    expectedOptions: Record<string, unknown>;
    heartbeat: Partial<HeartbeatConfig>;
  }): Promise<void> {
    await withHeartbeatFixture(async ({ tmpDir, storePath, replySpy, seedSession }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            heartbeat: {
              every: "30m",
              ...params.defaultsHeartbeat,
            },
          },
          list: [
            { id: "main", default: true },
            {
              id: "ops",
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "whatsapp",
                ...params.heartbeat,
              },
            },
          ],
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: "ops" });
      const result = await runHeartbeatWithSeed({
        seedSession,
        cfg,
        agentId: "ops",
        sessionKey,
        replySpy,
      });

      expect(result.replySpy).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          isHeartbeat: true,
          ...params.expectedOptions,
        }),
        cfg,
      );
    });
  }

  it("passes heartbeatModelOverride from defaults heartbeat config", async () => {
    const replyOpts = await runDefaultsHeartbeat({ model: "ollama/llama3.2:1b" });
    expect(replyOpts).toEqual(
      expect.objectContaining({
        isHeartbeat: true,
        heartbeatModelOverride: "ollama/llama3.2:1b",
        suppressToolErrorWarnings: false,
      }),
    );
  });

  it("passes suppressToolErrorWarnings when configured", async () => {
    const replyOpts = await runDefaultsHeartbeat({ suppressToolErrorWarnings: true });
    expect(replyOpts).toEqual(
      expect.objectContaining({
        isHeartbeat: true,
        suppressToolErrorWarnings: true,
      }),
    );
  });

  it("passes heartbeat timeoutSeconds as a reply-run timeout override", async () => {
    const replyOpts = await runDefaultsHeartbeat({ timeoutSeconds: 45 });
    expect(replyOpts).toEqual(
      expect.objectContaining({
        isHeartbeat: true,
        timeoutOverrideSeconds: 45,
      }),
    );
  });

  it("passes bootstrapContextMode when heartbeat lightContext is enabled", async () => {
    const replyOpts = await runDefaultsHeartbeat({ lightContext: true });
    expect(replyOpts).toEqual(
      expect.objectContaining({
        isHeartbeat: true,
        bootstrapContextMode: "lightweight",
      }),
    );
  });

  it("uses isolated session key when isolatedSession is enabled", async () => {
    await withHeartbeatFixture(async ({ tmpDir, storePath, replySpy, seedSession }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "whatsapp",
              isolatedSession: true,
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      const result = await runHeartbeatWithSeed({
        seedSession,
        cfg,
        sessionKey,
        replySpy,
      });

      // Isolated heartbeat runs use a dedicated session key with :heartbeat suffix
      expect(result.ctx?.SessionKey).toBe(`${sessionKey}:heartbeat`);
    });
  });

  it("uses main session key when isolatedSession is not set", async () => {
    await withHeartbeatFixture(async ({ tmpDir, storePath, replySpy, seedSession }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "whatsapp",
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      const result = await runHeartbeatWithSeed({
        seedSession,
        cfg,
        sessionKey,
        replySpy,
      });

      expect(result.ctx?.SessionKey).toBe(sessionKey);
    });
  });

  it("passes per-agent heartbeat model override (merged with defaults)", async () => {
    await expectPerAgentHeartbeatOverride({
      defaultsHeartbeat: { model: "openai/gpt-5.4" },
      heartbeat: { model: "ollama/llama3.2:1b" },
      expectedOptions: {
        heartbeatModelOverride: "ollama/llama3.2:1b",
      },
    });
  });

  it("passes per-agent heartbeat lightContext override after merging defaults", async () => {
    await expectPerAgentHeartbeatOverride({
      defaultsHeartbeat: { lightContext: false },
      heartbeat: { lightContext: true },
      expectedOptions: {
        bootstrapContextMode: "lightweight",
      },
    });
  });

  it("passes per-agent heartbeat timeout override after merging defaults", async () => {
    await expectPerAgentHeartbeatOverride({
      defaultsHeartbeat: { timeoutSeconds: 120 },
      heartbeat: { timeoutSeconds: 45 },
      expectedOptions: {
        timeoutOverrideSeconds: 45,
      },
    });
  });

  it("does not pass heartbeatModelOverride when no heartbeat model is configured", async () => {
    const replyOpts = await runDefaultsHeartbeat({ model: undefined });
    expect(replyOpts).toEqual(
      expect.objectContaining({
        isHeartbeat: true,
      }),
    );
  });

  it("trims heartbeat model override before passing it downstream", async () => {
    const replyOpts = await runDefaultsHeartbeat({ model: "  ollama/llama3.2:1b  " });
    expect(replyOpts).toEqual(
      expect.objectContaining({
        isHeartbeat: true,
        heartbeatModelOverride: "ollama/llama3.2:1b",
      }),
    );
  });
});
