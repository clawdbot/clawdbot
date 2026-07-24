// OpenClaw TUI backend tests cover rescue status integration with the TUI backend.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import type { SystemAgentCommandDeps, SystemAgentOperation } from "./operations.js";
import type { SystemAgentOverview } from "./overview.js";
import { createSystemAgentVerifiedInferenceTestFixture } from "./system-agent.test-helpers.js";
import { runSystemAgentTui, type SystemAgentTuiOptions } from "./tui-backend.js";

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalog: vi.fn(async () => []),
}));

vi.mock("../plugins/providers.js", () => ({
  resolveOwningPluginIdsForModelRefs: vi.fn(() => []),
  resolveOwningPluginIdsForProviderRef: vi.fn(() => []),
}));

vi.mock("../agents/prepared-model-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-catalog.js")>()),
  // These tests exercise the TUI boundary, not filesystem-backed catalog discovery.
  loadPreparedModelCatalog: vi.fn(async () => []),
}));

const overview: SystemAgentOverview = {
  defaultAgentId: "main",
  defaultModel: "openai/gpt-5.5",
  agents: [{ id: "main", isDefault: true, model: "openai/gpt-5.5" }],
  config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: null },
  tools: {
    codex: { command: "codex", found: false, error: "not found" },
    claude: { command: "claude", found: false, error: "not found" },
    gemini: { command: "gemini", found: false, error: "not found" },
    apiKeys: { openai: true, anthropic: false },
  },
  gateway: {
    url: "ws://127.0.0.1:18789",
    source: "local loopback",
    reachable: false,
    error: "offline",
  },
  references: {
    docsUrl: "https://docs.openclaw.ai",
    sourceUrl: "https://github.com/openclaw/openclaw",
  },
};

const verifiedConfig = {
  agents: { defaults: { model: "openai/gpt-5.5" } },
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "test-key",
        auth: "api-key",
        models: [],
      },
    },
  },
} satisfies OpenClawConfig;

function configSnapshot(config: OpenClawConfig) {
  return {
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "h",
    config,
    runtimeConfig: config,
    sourceConfig: config,
    issues: [],
  };
}

async function createVerifiedTuiOptions(
  deps: SystemAgentCommandDeps = {},
  config: OpenClawConfig = verifiedConfig,
) {
  const fixture = await createSystemAgentVerifiedInferenceTestFixture(config);
  return {
    verifiedInference: fixture.binding,
    deps: {
      ...fixture.deps,
      readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
      ...deps,
    },
  };
}

function createRuntime(): RuntimeEnv {
  return {
    log: () => undefined,
    error: () => undefined,
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
  };
}

describe("runSystemAgentTui", () => {
  it("rejects a missing inference binding before overview, planner, TUI, or setup", async () => {
    const loadOverview = vi.fn(async () => overview);
    const planWithAssistant = vi.fn(async () => ({ reply: "ready" }));
    const runTui = vi.fn(async () => ({ exitReason: "exit" as const }));
    const runChannelsAdd = vi.fn(async () => undefined);
    const fixture = await createSystemAgentVerifiedInferenceTestFixture(verifiedConfig);
    const options: SystemAgentTuiOptions = {
      verifiedInference: fixture.binding,
      deps: { loadOverview },
      planWithAssistant,
      runTui,
      runChannelsAdd,
    };
    Reflect.deleteProperty(options, "verifiedInference");

    await expect(runSystemAgentTui(options, createRuntime())).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );

    expect(loadOverview).not.toHaveBeenCalled();
    expect(planWithAssistant).not.toHaveBeenCalled();
    expect(runTui).not.toHaveBeenCalled();
    expect(runChannelsAdd).not.toHaveBeenCalled();
  });

  it("runs OpenClaw inside the shared TUI shell", async () => {
    let runTuiCalls = 0;
    let runTuiOptions: unknown;
    const verified = await createVerifiedTuiOptions({ loadOverview: async () => overview });

    await runSystemAgentTui(
      {
        ...verified,
        runTui: async (opts) => {
          runTuiCalls += 1;
          runTuiOptions = opts;
          return { exitReason: "exit" };
        },
      },
      createRuntime(),
    );

    expect(runTuiCalls).toBe(1);
    const options = runTuiOptions as {
      local?: boolean;
      session?: string;
      historyLimit?: number;
      config?: unknown;
      title?: string;
      backend?: unknown;
    };
    expect(options.local).toBe(true);
    expect(options.session).toBe("agent:openclaw:main");
    expect(options.historyLimit).toBe(200);
    expect(options.config).toEqual({});
    expect(options.title).toBe("openclaw setup");
    if (!options.backend || typeof options.backend !== "object") {
      throw new Error("expected openclaw TUI backend");
    }
  }, 240_000);

  it("reports the verified model without its auth profile and the effective thinking level", async () => {
    const config = {
      ...verifiedConfig,
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          thinkingDefault: "high",
        },
      },
    } satisfies OpenClawConfig;
    const profileQualifiedOverview = {
      ...overview,
      defaultModel: "openai/gpt-5.5@openai:setup-test",
    } satisfies SystemAgentOverview;
    const verified = await createVerifiedTuiOptions(
      { loadOverview: async () => profileQualifiedOverview },
      config,
    );

    await runSystemAgentTui(
      {
        ...verified,
        runTui: async (opts) => {
          const backend = opts.backend as unknown as {
            loadHistory: () => Promise<{ thinkingLevel: string }>;
            listSessions: () => Promise<{
              sessions: Array<{
                model?: string;
                modelProvider?: string;
                thinkingLevel?: string;
              }>;
            }>;
          };

          await expect(backend.loadHistory()).resolves.toMatchObject({ thinkingLevel: "high" });
          await expect(backend.listSessions()).resolves.toMatchObject({
            sessions: [
              {
                model: "gpt-5.5",
                modelProvider: "openai",
                thinkingLevel: "high",
              },
            ],
          });
          return { exitReason: "exit" };
        },
      },
      createRuntime(),
    );
  });

  it("uses the verified model's default thinking level", async () => {
    const config = {
      ...verifiedConfig,
      agents: { defaults: { model: "openai/gpt-5.6-sol" } },
    } satisfies OpenClawConfig;
    const verified = await createVerifiedTuiOptions(
      {
        loadOverview: async () => ({
          ...overview,
          defaultModel: "openai/gpt-5.6-sol@openai:setup-test",
        }),
      },
      config,
    );

    await runSystemAgentTui(
      {
        ...verified,
        runTui: async (opts) => {
          const backend = opts.backend as unknown as {
            listSessions: () => Promise<{
              sessions: Array<{ model?: string; thinkingLevel?: string }>;
            }>;
          };

          await expect(backend.listSessions()).resolves.toMatchObject({
            sessions: [{ model: "gpt-5.6-sol", thinkingLevel: "medium" }],
          });
          return { exitReason: "exit" };
        },
      },
      createRuntime(),
    );
  });

  it("reports that /model cannot replace the active verified inference route", async () => {
    const verified = await createVerifiedTuiOptions({ loadOverview: async () => overview });

    await runSystemAgentTui(
      {
        ...verified,
        runTui: async (opts) => {
          const backend = opts.backend as unknown as {
            patchSession: (opts: { key: string; model: string }) => Promise<unknown>;
            listSessions: () => Promise<{
              sessions: Array<{ model?: string; modelProvider?: string }>;
            }>;
          };

          await expect(
            backend.patchSession({
              key: "agent:openclaw:main",
              model: "anthropic/claude-opus-4-8",
            }),
          ).rejects.toThrow("cannot change the model inside its active verified session");
          await expect(backend.listSessions()).resolves.toMatchObject({
            sessions: [{ model: "gpt-5.5", modelProvider: "openai" }],
          });
          return { exitReason: "exit" };
        },
      },
      createRuntime(),
    );
  });

  it("isolates event consumer failures during sendChat", async () => {
    const verified = await createVerifiedTuiOptions({ loadOverview: async () => overview });
    const backendWithEngine = await new Promise<{
      backend: {
        sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
        onEvent?: (evt: {
          event: string;
          payload?: { state?: string; errorMessage?: string };
        }) => void;
        engine: {
          handle: () => Promise<{ text: string; action: "none" }>;
          dispose: () => Promise<void>;
        };
      };
      dispose: () => Promise<void>;
    }>((resolve) => {
      void runSystemAgentTui(
        {
          ...verified,
          runTui: async (opts) => {
            const backend = opts.backend as unknown as {
              sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
              onEvent?: (evt: {
                event: string;
                payload?: { state?: string; errorMessage?: string };
              }) => void;
              engine: {
                handle: () => Promise<{ text: string; action: "none" }>;
                dispose: () => Promise<void>;
              };
              dispose: () => Promise<void>;
            };
            resolve({ backend, dispose: async () => backend.dispose() });
            return { exitReason: "exit" };
          },
        },
        createRuntime(),
      );
    });

    const { backend, dispose } = backendWithEngine;
    backend.engine.handle = async () => ({ text: "hello", action: "none" });
    backend.onEvent = () => {
      throw new Error("simulated render failure");
    };

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await backend.sendChat({ message: "hello" });
      // Wait for the fire-and-forget response path to emit its final event.
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await dispose();
    }

    expect(unhandled).toHaveLength(0);
  });

  it("emits an error without a fake final reply when inference fails", async () => {
    const events: Array<{ payload?: { state?: string; errorMessage?: string } }> = [];
    const verified = await createVerifiedTuiOptions({ loadOverview: async () => overview });

    await runSystemAgentTui(
      {
        ...verified,
        runTui: async (opts) => {
          const backend = opts.backend as unknown as {
            sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
            onEvent?: (event: { payload?: { state?: string; errorMessage?: string } }) => void;
            engine: { handle: () => Promise<never> };
          };
          backend.engine.handle = async () => {
            throw new SystemAgentInferenceUnavailableError("conversation");
          };
          backend.onEvent = (event) => events.push(event);

          await backend.sendChat({ message: "status please" });
          await new Promise((resolve) => {
            setTimeout(resolve, 0);
          });
          return { exitReason: "exit" };
        },
      },
      createRuntime(),
    );

    expect(events).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          state: "error",
          errorMessage: expect.stringContaining("working inference"),
        }),
      }),
    ]);
  });

  it("retires the local session before a queued exact mutation can run", async () => {
    const handle = vi
      .fn()
      .mockRejectedValueOnce(new SystemAgentInferenceUnavailableError("conversation"))
      .mockResolvedValue({ text: "mutation ran", action: "none" });
    const dispose = vi.fn(async () => undefined);
    const events: Array<{ payload?: { state?: string; errorMessage?: string } }> = [];
    const verified = await createVerifiedTuiOptions({ loadOverview: async () => overview });

    await runSystemAgentTui(
      {
        ...verified,
        runTui: async (opts) => {
          const backend = opts.backend as unknown as {
            sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
            setRequestExitHandler: (handler: () => void) => void;
            onEvent?: (event: { payload?: { state?: string; errorMessage?: string } }) => void;
            engine: {
              handle: typeof handle;
              dispose: typeof dispose;
            };
          };
          backend.engine.handle = handle;
          backend.engine.dispose = dispose;
          backend.onEvent = (event) => events.push(event);

          const requestedExit = new Promise<void>((resolve) => {
            backend.setRequestExitHandler(resolve);
          });
          await backend.sendChat({ message: "status please" });
          await backend.sendChat({ message: "config set gateway.port 19001" });
          await requestedExit;
          await new Promise((resolve) => {
            setTimeout(resolve, 0);
          });
          return { exitReason: "exit" };
        },
      },
      createRuntime(),
    );

    expect(handle).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            state: "error",
            errorMessage: expect.stringContaining("working inference"),
          }),
        }),
      ]),
    );
    expect(events.some((event) => event.payload?.state === "final")).toBe(false);
  });

  it("launches setup handoffs after the chat TUI is disposed", async () => {
    const cases: Array<{
      handoff: Extract<SystemAgentOperation, { kind: "open-setup" }>;
      expected: string;
    }> = [
      {
        handoff: { kind: "open-setup", target: "channels", channel: "slack" },
        expected: "channels:slack:false:function:undefined",
      },
    ];

    for (const { handoff, expected } of cases) {
      const events: string[] = [];
      const verified = await createVerifiedTuiOptions({ loadOverview: async () => overview });
      await runSystemAgentTui(
        {
          ...verified,
          setupWorkspace: "/tmp/custom-workspace",
          runTui: async (opts) => {
            const backend = opts.backend as unknown as {
              sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
              setRequestExitHandler: (handler: () => void) => void;
              engine: {
                handle: () => Promise<{
                  text: string;
                  action: "open-setup";
                  handoff: SystemAgentOperation;
                }>;
                dispose: () => Promise<void>;
              };
            };
            backend.engine.handle = async () => ({
              text: "Opening setup.",
              action: "open-setup",
              handoff,
            });
            backend.engine.dispose = async () => {
              events.push("disposed");
            };
            const requestedExit = new Promise<void>((resolve) => {
              backend.setRequestExitHandler(resolve);
            });
            await backend.sendChat({ message: "open setup wizard" });
            await requestedExit;
            return { exitReason: "exit" };
          },
          runChannelsAdd: async (opts, _runtime, params) => {
            events.push(
              `channels:${opts.channel ?? "all"}:${String(params?.hasFlags)}:${typeof params?.beforePersistentEffect}:${String(params?.directEntry)}`,
            );
          },
        },
        createRuntime(),
      );

      expect(events).toEqual(["disposed", expected]);
    }
  });
});
