// Crestodian TUI backend tests cover rescue status integration with the TUI backend.
import { describe, expect, it, vi } from "vitest";
import type { CrestodianOperation } from "./operations.js";
import type { RuntimeEnv } from "../runtime.js";
import type { CrestodianOverview } from "./overview.js";
import { runCrestodianTui } from "./tui-backend.js";

const overview: CrestodianOverview = {
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

function createRuntime(): RuntimeEnv {
  return {
    log: () => undefined,
    error: () => undefined,
    exit: (code) => {
      throw new Error(`exit ${code}`);
    },
  };
}

describe("runCrestodianTui", () => {
  it("runs Crestodian inside the shared TUI shell", async () => {
    let runTuiCalls = 0;
    let runTuiOptions: unknown;

    await runCrestodianTui(
      {
        deps: {
          loadOverview: async () => overview,
        },
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
    expect(options.session).toBe("agent:crestodian:main");
    expect(options.historyLimit).toBe(200);
    expect(options.config).toEqual({});
    expect(options.title).toBe("openclaw crestodian");
    if (!options.backend || typeof options.backend !== "object") {
      throw new Error("expected crestodian TUI backend");
    }
  });

  it("isolates event consumer failures during sendChat", async () => {
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
      void runCrestodianTui(
        {
          deps: { loadOverview: async () => overview },
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

  it("exits to masked model setup and then resumes Crestodian", async () => {
    const runModelSetup = vi.fn(async () => ({
      model: "openai/gpt-5.5",
    }));
    let runTuiCalls = 0;

    await runCrestodianTui(
      {
        deps: { loadOverview: async () => ({ ...overview, defaultModel: undefined }) },
        runModelSetup,
        runTui: async (opts) => {
          runTuiCalls += 1;
          if (runTuiCalls > 1) {
            return { exitReason: "exit" };
          }
          const backend = opts.backend as unknown as {
            setRequestExitHandler: (handler: () => void) => void;
            sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
            engine: {
              handle: () => Promise<{
                text: string;
                action: "open-tui";
                handoff: { kind: "model-setup"; workspace: string };
              }>;
            };
          };
          backend.engine.handle = async () => ({
            text: "Opening masked model-provider setup in the terminal.",
            action: "open-tui",
            handoff: { kind: "model-setup", workspace: "/tmp/work" },
          });
          await new Promise<void>((resolve) => {
            backend.setRequestExitHandler(resolve);
            void backend.sendChat({ message: "yes" });
          });
          return { exitReason: "exit" };
        },
      },
      createRuntime(),
    );

    expect(runModelSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: "/tmp/work",
        runtime: expect.anything(),
        prompter: expect.anything(),
      }),
    );
    expect(runTuiCalls).toBe(2);
  });

  it("turns embedded model setup exits into errors and resumes Crestodian", async () => {
    const exit = vi.fn();
    const error = vi.fn();
    const runModelSetup = vi.fn(async (params: { runtime: RuntimeEnv }) => {
      params.runtime.exit(1);
      return {};
    });
    let runTuiCalls = 0;

    await runCrestodianTui(
      {
        deps: { loadOverview: async () => ({ ...overview, defaultModel: undefined }) },
        runModelSetup,
        runTui: async (opts) => {
          runTuiCalls += 1;
          if (runTuiCalls > 1) {
            return { exitReason: "exit" };
          }
          const backend = opts.backend as unknown as {
            setRequestExitHandler: (handler: () => void) => void;
            sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
            engine: {
              handle: () => Promise<{
                text: string;
                action: "open-tui";
                handoff: { kind: "model-setup" };
              }>;
            };
          };
          backend.engine.handle = async () => ({
            text: "Opening masked model-provider setup in the terminal.",
            action: "open-tui",
            handoff: { kind: "model-setup" },
          });
          await new Promise<void>((resolve) => {
            backend.setRequestExitHandler(resolve);
            void backend.sendChat({ message: "yes" });
          });
          return { exitReason: "exit" };
        },
      },
      { log: vi.fn(), error, exit },
    );

    expect(exit).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "Model provider setup failed: embedded model setup exited with code 1",
    );
    expect(runTuiCalls).toBe(2);
  });

  it("consumes a returned model-setup request before resuming after the wizard", async () => {
    const runModelSetup = vi.fn(async () => ({
      model: "openai/gpt-5.5",
    }));
    const runAgentTui = vi.fn(async () => ({
      exitReason: "return-to-crestodian" as const,
      crestodianMessage: "configure model provider",
    }));
    const messages: Array<string | undefined> = [];
    let runTuiCalls = 0;

    await runCrestodianTui(
      {
        deps: {
          loadOverview: async () => ({ ...overview, defaultModel: undefined }),
          runTui: runAgentTui,
        },
        runModelSetup,
        runTui: async (opts) => {
          runTuiCalls += 1;
          messages.push(opts.message);
          if (runTuiCalls === 3) {
            return { exitReason: "exit" };
          }
          const backend = opts.backend as unknown as {
            setRequestExitHandler: (handler: () => void) => void;
            sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
            engine: {
              handle: () => Promise<{
                text: string;
                action: "open-tui";
                handoff: { kind: "open-tui" } | { kind: "model-setup"; workspace?: string };
              }>;
            };
          };
          backend.engine.handle = async () =>
            runTuiCalls === 1
              ? {
                  text: "Opening agent.",
                  action: "open-tui",
                  handoff: { kind: "open-tui" },
                }
              : {
                  text: "Opening masked model-provider setup in the terminal.",
                  action: "open-tui",
                  handoff: { kind: "model-setup" },
                };
          await new Promise<void>((resolve) => {
            backend.setRequestExitHandler(resolve);
            void backend.sendChat({ message: opts.message ?? "talk to agent" });
          });
          return { exitReason: "exit" };
        },
      },
      createRuntime(),
    );

    expect(runAgentTui).toHaveBeenCalledOnce();
    expect(runModelSetup).toHaveBeenCalledOnce();
    expect(messages).toEqual([undefined, "configure model provider", undefined]);
  });
  it("launches setup handoffs after the chat TUI is disposed", async () => {
    const cases: Array<{
      handoff: Extract<CrestodianOperation, { kind: "open-setup" }>;
      expected: string;
    }> = [
      {
        handoff: { kind: "open-setup", target: "guided" },
        expected: "guided:/tmp/custom-workspace:true",
      },
      {
        handoff: { kind: "open-setup", target: "classic" },
        expected: "classic:true:/tmp/custom-workspace:true",
      },
      {
        handoff: { kind: "open-setup", target: "channels", channel: "slack" },
        expected: "channels:slack:false",
      },
    ];

    for (const { handoff, expected } of cases) {
      const events: string[] = [];
      await runCrestodianTui(
        {
          deps: { loadOverview: async () => overview },
          setupWorkspace: "/tmp/custom-workspace",
          setupAcceptRisk: true,
          runTui: async (opts) => {
            const backend = opts.backend as unknown as {
              sendChat: (opts: { message: string }) => Promise<{ runId: string }>;
              setRequestExitHandler: (handler: () => void) => void;
              engine: {
                handle: () => Promise<{
                  text: string;
                  action: "open-setup";
                  handoff: CrestodianOperation;
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
          runGuidedSetup: async (opts) => {
            events.push(`guided:${opts.workspace ?? "default"}:${String(opts.acceptRisk)}`);
          },
          runClassicSetup: async (opts) => {
            events.push(
              `classic:${String(opts.classic)}:${opts.workspace ?? "default"}:${String(opts.acceptRisk)}`,
            );
          },
          runChannelsAdd: async (opts, _runtime, params) => {
            events.push(`channels:${opts.channel ?? "all"}:${String(params?.hasFlags)}`);
          },
        },
        createRuntime(),
      );

      expect(events).toEqual(["disposed", expected]);
    }
  });

});
